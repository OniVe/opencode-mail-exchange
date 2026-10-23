import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EwsBackend } from "../src/backend"
import type { MailConfig } from "../src/config"
import { openStore } from "../src/store"
import type { MessageSummary } from "../src/types"

const config = (storage: MailConfig["storage"] = "metadata", requestTimeoutMs = 30_000): MailConfig => ({
  id: "default",
  ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
  username: "CORP\\bot",
  password: "secret",
  selfAddress: "bot@example.com",
  storage,
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-recipients-")),
  maxMessages: 100,
  retentionDays: 365,
  maxBodyBytes: 1000,
  syncIntervalMinutes: 5,
  allowSend: true,
  requestTimeoutMs,
  codemode: false,
})

const message = (id: string, to: string[] = [], cc?: string[]): MessageSummary => ({
  id,
  subject: "Subject",
  from: "alice@example.com",
  to,
  cc,
  received: "2026-10-23T09:41:32Z",
  isRead: false,
  hasAttachments: false,
  preview: "preview",
})

const recipients = (addresses: string[]) => ({
  GetEnumerator: () => addresses.map((address) => ({ Address: address })),
})

/** EwsBackend owns its ExchangeService privately; tests swap it for a scripted fake. */
const fakeService = (backend: EwsBackend, service: unknown): void => {
  ;(backend as unknown as { service: unknown }).service = service
}

const freshState = (store: ReturnType<typeof openStore>): void => {
  // Mark the index fresh so listMessages does not try to sync through the fake service.
  store?.setSyncState("wk:inbox", "state")
}

describe("cached recipients", () => {
  test("upsert with empty to/cc does not erase recipients learned from a bind", () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])
    store.updateRecipients("1", ["to@example.com"], ["cc@example.com"])
    // Sync payloads carry no recipients at all.
    store.upsertMessages("wk:inbox", [message("1")])

    const row = store.listMessages({ folderId: "wk:inbox", limit: 10 })[0]
    expect(row?.to).toEqual(["to@example.com"])
    expect(row?.cc).toEqual(["cc@example.com"])
    expect(row?.recipientsKnown).toBe(true)

    store.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("an empty payload does not erase only cc", () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1", ["to@example.com"])])
    store.updateRecipients("1", ["to@example.com"], ["cc@example.com"])
    store.upsertMessages("wk:inbox", [message("1", ["to@example.com"])])

    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 })[0]?.cc).toEqual(["cc@example.com"])
    store.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("list enriches an envelope-only page once and persists the result", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1"), message("2")])
    freshState(store)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 })[0]?.recipientsKnown).toBe(false)

    let binds = 0
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      BindToItems: async (ids: Array<{ UniqueId?: string }>) => {
        binds++
        return {
          Responses: ids.map((id, index) => ({
            Result: 0,
            Item: {
              Id: { UniqueId: id.UniqueId },
              ToRecipients: recipients([`to${index}@example.com`]),
              CcRecipients: recipients(["cc@example.com"]),
            },
          })),
        }
      },
    })

    const first = await backend.listMessages({ limit: 10 })
    expect(first.map((entry) => entry.to)).toEqual([["to0@example.com"], ["to1@example.com"]])
    expect(first.map((entry) => entry.cc)).toEqual([["cc@example.com"], ["cc@example.com"]])
    expect(first.every((entry) => entry.recipientsKnown === true)).toBe(true)
    expect(binds).toBe(1)

    // Now the store knows them: no second bind.
    const second = await backend.listMessages({ limit: 10 })
    expect(second.map((entry) => entry.to)).toEqual(first.map((entry) => entry.to))
    expect(binds).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("BindToItems failure still returns the page with recipientsKnown:false", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])
    freshState(store)

    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      BindToItems: async () => {
        throw new Error("EWS exploded")
      },
    })

    const page = await backend.listMessages({ limit: 10 })
    expect(page).toHaveLength(1)
    expect(page[0]?.recipientsKnown).toBe(false)
    expect(page[0]?.to).toEqual([])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("an empty bind result is remembered: three lists, one bind", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])
    freshState(store)

    let binds = 0
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      // The message really has no to/cc: that is an answer, not a missing value.
      BindToItems: async (ids: Array<{ UniqueId?: string }>) => {
        binds++
        return {
          Responses: ids.map((id) => ({
            Result: 0,
            Item: { Id: { UniqueId: id.UniqueId }, ToRecipients: recipients([]), CcRecipients: recipients([]) },
          })),
        }
      },
    })

    for (let round = 0; round < 3; round++) {
      const page = await backend.listMessages({ limit: 10 })
      expect(page[0]?.recipientsKnown).toBe(true)
      expect(page[0]?.to).toEqual([])
      expect(page[0]?.cc).toBeUndefined()
    }
    expect(binds).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a failing updateRecipients does not fail the page (bind data still returned)", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])
    freshState(store)

    // The index is a cache: a write failure (SQLITE_BUSY, disk full) must not fail mail_list.
    const brokenStore = {
      ...store,
      updateRecipients: () => {
        throw new Error("SQLITE_BUSY: database is locked")
      },
    }
    const backend = new EwsBackend(cfg, brokenStore)
    fakeService(backend, {
      BindToItems: async () => ({
        Responses: [
          {
            Result: 0,
            Item: {
              Id: { UniqueId: "1" },
              ToRecipients: recipients(["to@example.com"]),
              CcRecipients: recipients(["cc@example.com"]),
            },
          },
        ],
      }),
    })

    const page = await backend.listMessages({ limit: 10 })
    expect(page).toHaveLength(1)
    expect(page[0]?.to).toEqual(["to@example.com"])
    expect(page[0]?.cc).toEqual(["cc@example.com"])
    expect(page[0]?.recipientsKnown).toBe(true)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a hanging bind is cut off by the enrichment budget and parked for a minute", async () => {
    // requestTimeoutMs/5 = 500 ms → the page must come back in about that time, not in 2.5 s.
    const cfg = config("metadata", 2_500)
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])
    freshState(store)

    let binds = 0
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      BindToItems: async () => {
        binds++
        return new Promise<never>(() => {})
      },
    })

    const started = Date.now()
    const page = await backend.listMessages({ limit: 10 })
    const elapsed = Date.now() - started
    expect(page).toHaveLength(1)
    expect(page[0]?.recipientsKnown).toBe(false)
    expect(elapsed).toBeGreaterThanOrEqual(400)
    expect(elapsed).toBeLessThan(1_500)

    // Negative cache: the next page does not wait on EWS again.
    const secondStart = Date.now()
    const second = await backend.listMessages({ limit: 10 })
    expect(Date.now() - secondStart).toBeLessThan(300)
    expect(second[0]?.recipientsKnown).toBe(false)
    expect(binds).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("search enriches a cached page the same way", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [{ ...message("1"), subject: "Уникальная зебра" }])
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      BindToItems: async () => ({
        Responses: [
          {
            Result: 0,
            Item: {
              Id: { UniqueId: "1" },
              ToRecipients: recipients(["to@example.com"]),
              CcRecipients: recipients([]),
            },
          },
        ],
      }),
    })

    const found = await backend.searchMessages({ query: "зебра", limit: 5 })
    expect(found[0]?.to).toEqual(["to@example.com"])
    expect(found[0]?.cc).toBeUndefined()
    expect(found[0]?.recipientsKnown).toBe(true)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("getMessage body cache", () => {
  test("a fetched but empty body is not re-bound", async () => {
    const cfg = config("full")
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1", ["to@example.com"])])
    store.putBody("1", "", "text", false)

    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      Bind: async () => {
        throw new Error("must not bind a fetched body")
      },
    })

    const detail = await backend.getMessage({ id: "1" })
    expect(detail.body).toBe("")
    // `fetched` = a body was obtained by this call; `bodyCached` = it lives in the index.
    expect(detail.fetched).toBe(true)
    expect(detail.bodyCached).toBe(true)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("reading an unindexed message leaves no orphan body", async () => {
    const cfg = config("full")
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      BindToItem: async () => ({
        Id: { UniqueId: "orphan1" },
        Subject: "Not indexed",
        From: { Address: "alice@example.com" },
        ToRecipients: { GetEnumerator: () => [{ Address: "bot@example.com" }] },
        CcRecipients: { GetEnumerator: () => [] },
        DateTimeReceived: { ToISOString: () => "2026-10-23T09:41:32Z" },
        IsRead: false,
        HasAttachments: false,
        Preview: "preview",
        Body: { Text: "тело письма вне индекса", BodyType: 0 },
      }),
    })

    const detail = await backend.getMessage({ id: "orphan1" })
    expect(detail.body).toContain("вне индекса")
    expect(detail.fetched).toBe(true)
    // Nothing was indexed, so nothing may be cached: bodies never live without their message.
    expect(detail.bodyCached).toBe(false)
    expect(store.hasMessage("orphan1")).toBe(false)

    const db = new Database(path.join(cfg.dataDir, "mail.db"))
    const bodies = db.query("select count(*) as n from bodies").get() as { n: number }
    db.close()
    expect(bodies.n).toBe(0)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("rejects malformed item ids before they reach SOAP", async () => {
    const cfg = config("off")
    const backend = new EwsBackend(cfg)
    fakeService(backend, {
      Bind: async () => {
        throw new Error("must not bind an invalid id")
      },
    })

    await expect(backend.getMessage({ id: 'x"><t:Injection' })).rejects.toThrow(/invalid item id/)
    await expect(backend.getMessage({ id: "a b" })).rejects.toThrow(/invalid item id/)
    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("empty pages", () => {
  test("list and search return [] without calling LoadPropertiesForItems", async () => {
    const cfg = config("off")
    const backend = new EwsBackend(cfg)
    let loads = 0
    fakeService(backend, {
      FindItems: async () => ({ Items: [] }),
      LoadPropertiesForItems: async () => {
        loads++
      },
    })

    expect(await backend.listMessages({ limit: 10 })).toEqual([])
    expect(await backend.searchMessages({ query: "R&D", limit: 10 })).toEqual([])
    expect(loads).toBe(0)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

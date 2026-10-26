import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ServiceResult } from "ews-javascript-api"
import { EwsBackend, escapeXml, parseRecipient } from "../src/backend"
import type { MailConfig } from "../src/config"
import { createEwsService, toSummary } from "../src/ews"
import { openStore } from "../src/store"
import type { MessageSummary } from "../src/types"

const config = (): MailConfig => ({
  id: "default",
  ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
  username: "CORP\\bot",
  password: "secret",
  selfAddress: "bot@example.com",
  storage: "full",
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-backend-")),
  maxMessages: 100,
  retentionDays: 365,
  maxBodyBytes: 1000,
  syncIntervalMinutes: 5,
  allowSend: true,
  requestTimeoutMs: 30_000,
  codemode: false,
})

const message = (id: string): MessageSummary => ({
  id,
  subject: "Subject",
  from: "alice@example.com",
  to: ["bot@example.com"],
  received: "2026-10-23T09:41:32Z",
  isRead: false,
  hasAttachments: false,
  preview: "preview",
})

describe("SOAP escaping and recipient validation", () => {
  test("escapes XML metacharacters and strips forbidden control characters", () => {
    expect(escapeXml("a&b.txt")).toBe("a&amp;b.txt")
    expect(escapeXml("<script>")).toBe("&lt;script&gt;")
    expect(escapeXml('say "hi"')).toBe("say &quot;hi&quot;")
    expect(escapeXml("a\u0000b\u0007c")).toBe("abc")
    expect(escapeXml("bad\uFFFFchar")).toBe("badchar")
    expect(escapeXml("\uFFFE")).toBe("")
    expect(escapeXml("\uD800")).toBe("")
  })

  test("parses plain and named recipients", () => {
    expect(parseRecipient("bot@example.com")).toEqual({ address: "bot@example.com" })
    expect(parseRecipient(" Probe <bot@example.com> ")).toEqual({ name: "Probe", address: "bot@example.com" })
    expect(parseRecipient("<bot@example.com>")).toEqual({ address: "bot@example.com" })
  })

  test("rejects recipients that could inject a second mailbox or SOAP markup", () => {
    for (const value of [
      "bot@example.com\r\nBcc: evil@example.com",
      "bot@example.com, evil@example.com",
      "Probe <bot@example.com>, evil@example.com",
      "bot@example.com><evil",
      "no-at-sign",
      " bot ",
    ]) {
      expect(() => parseRecipient(value)).toThrow()
    }
  })
})

describe("attachment limits", () => {
  const attachment = (name: string, contentBase64: string) => ({ name, contentBase64 })

  test("rejects more than 10 attachments before touching EWS", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    const attachments = Array.from({ length: 11 }, (_, index) => attachment(`f${index}.txt`, "eA=="))
    await expect(backend.saveDraft({ to: ["bot@example.com"], subject: "s", body: "b", attachments })).rejects.toThrow(
      /Too many attachments: 11/,
    )
    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("rejects an attachment over 40 MB decoded before touching EWS", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    // 56 MB of base64 decodes to ~42 MB: over the EWS/IIS request limit.
    const oversized = attachment("big.bin", "A".repeat(56 * 1024 * 1024))
    await expect(
      backend.saveDraft({ to: ["bot@example.com"], subject: "s", body: "b", attachments: [oversized] }),
    ).rejects.toThrow(/Attachment too large: big\.bin/)
    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("message size and attachments", () => {
  test("maps ItemSize and attachment count from a live page", async () => {
    const cfg: MailConfig = { ...config(), storage: "off" }
    const backend = new EwsBackend(cfg)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({
        Items: [
          {
            Id: { UniqueId: "1" },
            Subject: "With files",
            From: { Address: "alice@example.com" },
            ToRecipients: { GetEnumerator: () => [{ Address: "bot@example.com" }] },
            DateTimeReceived: { ToISOString: () => "2026-10-23T09:41:32Z" },
            IsRead: false,
            HasAttachments: true,
            Size: 1234,
            Attachments: { Count: 2 },
            Preview: "preview",
          },
        ],
      }),
      LoadPropertiesForItems: async () => ({ Responses: [{ Result: ServiceResult.Success }] }),
    }

    const [summary] = await backend.listMessages({ folder: "inbox", limit: 10 })
    expect(summary?.size).toBe(1234)
    expect(summary?.attachmentCount).toBe(2)
    expect(summary?.hasAttachments).toBe(true)

    backend.close()
  })

  test("drops a page row whose batch property load failed", async () => {
    const cfg: MailConfig = { ...config(), storage: "off" }
    const backend = new EwsBackend(cfg)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({ Items: [{ Id: { UniqueId: "gone" } }] }),
      // LoadPropertiesForItems uses ReturnErrors: the deleted item stays a stub.
      LoadPropertiesForItems: async () => ({ Responses: [{ Result: ServiceResult.Error }] }),
    }

    expect(await backend.listMessages({ folder: "inbox", limit: 10 })).toEqual([])
    backend.close()
  })

  test("drops Warning rows that were not processed", async () => {
    const cfg: MailConfig = { ...config(), storage: "off" }
    const backend = new EwsBackend(cfg)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({ Items: [{ Id: { UniqueId: "warned" } }] }),
      LoadPropertiesForItems: async () => ({ Responses: [{ Result: ServiceResult.Warning }] }),
    }

    expect(await backend.listMessages({ folder: "inbox", limit: 10 })).toEqual([])
    backend.close()
  })

  test("toSummary tolerates an unloaded HasAttachments property", () => {
    const summary = toSummary(
      {
        Id: { UniqueId: "unloaded" },
        get HasAttachments(): boolean {
          throw new Error("MustLoadOrAssignPropertyBeforeAccess")
        },
      },
      undefined,
      true,
      true,
    )
    expect(summary.hasAttachments).toBe(false)
    expect(summary.attachmentCount).toBeUndefined()
  })

  test("omits a contradictory attachment count", async () => {
    const cfg: MailConfig = { ...config(), storage: "off" }
    const backend = new EwsBackend(cfg)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({
        Items: [
          {
            Id: { UniqueId: "1" },
            Subject: "Broken metadata",
            DateTimeReceived: { ToISOString: () => "2026-10-23T09:41:32Z" },
            HasAttachments: true,
            Size: 100,
            // Attachments did not arrive but the collection auto-instantiates at 0.
            Attachments: { Count: 0 },
          },
        ],
      }),
      LoadPropertiesForItems: async () => ({ Responses: [{ Result: ServiceResult.Success }] }),
    }

    const [summary] = await backend.listMessages({ folder: "inbox", limit: 10 })
    expect(summary?.hasAttachments).toBe(true)
    expect(summary?.attachmentCount).toBeUndefined()
    expect(summary?.size).toBe(100)

    backend.close()
  })

  test("does not count attachments when the property was not requested", () => {
    const summary = toSummary(
      {
        Id: { UniqueId: "sync" },
        Subject: "Sync row",
        HasAttachments: true,
        Size: 512,
        Attachments: { Count: 2 },
      },
      "wk:inbox",
      false,
      false,
    )
    expect(summary.size).toBe(512)
    expect(summary.attachmentCount).toBeUndefined()
  })

  test("rejects a size outside the EWS Int32 range", () => {
    const summary = toSummary({ Id: { UniqueId: "huge" }, Size: 2_147_483_648 }, undefined, false, true)
    expect(summary.size).toBeUndefined()
  })

  test("rejects an attachment count outside Int32", () => {
    const summary = toSummary(
      { Id: { UniqueId: "many" }, HasAttachments: true, Attachments: { Count: 2_147_483_648 } },
      undefined,
      true,
      true,
    )
    expect(summary.attachmentCount).toBeUndefined()
  })

  test("truncates fractional size and ignores a count against HasAttachments=false", () => {
    const fractional = toSummary({ Id: { UniqueId: "fraction" }, Size: 12.9 }, undefined, true, true)
    expect(fractional.size).toBe(12)
    const contradictory = toSummary(
      { Id: { UniqueId: "contradiction" }, HasAttachments: false, Attachments: { Count: 2 } },
      undefined,
      true,
      true,
    )
    expect(contradictory.hasAttachments).toBe(false)
    expect(contradictory.attachmentCount).toBeUndefined()
  })

  test("keeps the page when Responses is shorter than Items", async () => {
    const cfg: MailConfig = { ...config(), storage: "off" }
    const backend = new EwsBackend(cfg)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({
        Items: [
          { Id: { UniqueId: "1" }, Subject: "One", HasAttachments: true, Attachments: { Count: 2 } },
          { Id: { UniqueId: "2" }, Subject: "Two" },
        ],
      }),
      LoadPropertiesForItems: async () => ({ Responses: [] }),
    }

    const page = await backend.listMessages({ folder: "inbox", limit: 10 })
    expect(page.map((item) => item.id)).toEqual(["1", "2"])
    expect(page[0]?.attachmentCount).toBeUndefined()
    expect(page[0]?.recipientsKnown).toBe(false)
    backend.close()
  })

  test("a metadata cache failure does not fail mail_get", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    store.updateMetadata = () => {
      throw new Error("SQLITE_BUSY")
    }
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      BindToItem: async () => ({
        Id: { UniqueId: "1" },
        Subject: "Still readable",
        From: { Address: "alice@example.com" },
        ToRecipients: { GetEnumerator: () => [{ Address: "to@example.com" }] },
        CcRecipients: { GetEnumerator: () => [] },
        DateTimeReceived: { ToISOString: () => "2026-10-23T09:41:32Z" },
        IsRead: false,
        HasAttachments: true,
        Size: 4321,
        Attachments: { Count: 1 },
        Preview: "preview",
        Body: { Text: "body", BodyType: 0 },
      }),
    }

    const detail = await backend.getMessage({ id: "1" })
    expect(detail.subject).toBe("Still readable")
    expect(detail.size).toBe(4321)
    expect(detail.attachmentCount).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("falls back to the envelope when the property load throws", async () => {
    const cfg: MailConfig = { ...config(), storage: "off" }
    const backend = new EwsBackend(cfg)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({ Items: [{ Id: { UniqueId: "1" }, Subject: "One", HasAttachments: true, Size: 10 }] }),
      LoadPropertiesForItems: async () => {
        throw new Error("batch failed")
      },
    }

    const page = await backend.listMessages({ folder: "inbox", limit: 10 })
    expect(page.map((item) => item.id)).toEqual(["1"])
    expect(page[0]?.size).toBe(10)
    expect(page[0]?.attachmentCount).toBeUndefined()
    expect(page[0]?.recipientsKnown).toBe(false)
    backend.close()
  })

  test("infers attachments when only a positive count arrived", () => {
    const summary = toSummary({ Id: { UniqueId: "count-only" }, Attachments: { Count: 2 } }, undefined, true, true)
    expect(summary.hasAttachments).toBe(true)
    expect(summary.attachmentCount).toBe(2)
  })

  test("search fallback keeps recipients unknown and enriches lazily", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    const backend = new EwsBackend(cfg, store)
    let binds = 0
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({ Items: [{ Id: { UniqueId: "1" }, Subject: "Search hit" }] }),
      LoadPropertiesForItems: async () => {
        throw new Error("batch failed")
      },
      BindToItems: async () => {
        binds++
        return {
          Responses: [
            {
              Result: ServiceResult.Success,
              Item: { Id: { UniqueId: "1" }, ToRecipients: { GetEnumerator: () => [{ Address: "lazy@example.com" }] } },
            },
          ],
        }
      },
    }

    const [hit] = await backend.searchMessages({ query: "x", limit: 5 })
    expect(hit?.recipientsKnown).toBe(true)
    expect(hit?.to).toEqual(["lazy@example.com"])
    expect(binds).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("persists size and attachment count from a bind", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      BindToItem: async () => ({
        Id: { UniqueId: "1" },
        Subject: "With file",
        From: { Address: "alice@example.com" },
        ToRecipients: { GetEnumerator: () => [{ Address: "to@example.com" }] },
        CcRecipients: { GetEnumerator: () => [] },
        DateTimeReceived: { ToISOString: () => "2026-10-23T09:41:32Z" },
        IsRead: false,
        HasAttachments: true,
        Size: 4321,
        Attachments: { Count: 1 },
        Preview: "preview",
        Body: { Text: "body", BodyType: 0 },
      }),
    }

    const detail = await backend.getMessage({ id: "1" })
    expect(detail.size).toBe(4321)
    expect(detail.attachmentCount).toBe(1)
    const second = await backend.getMessage({ id: "1" })
    expect(second.size).toBe(4321)
    expect(second.attachmentCount).toBe(1)

    const [cached] = store.listMessages({ folderId: "wk:inbox", limit: 10 })
    expect(cached?.size).toBe(4321)
    expect(cached?.attachmentCount).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("getMessage cache", () => {
  test("binds once, then returns identical to/cc/body from the cache", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])

    let binds = 0
    const backend = new EwsBackend(cfg, store)
    // No pre-filled body: the first call must bind, the second must be served from SQLite.
    ;(backend as unknown as { service: unknown }).service = {
      BindToItem: async () => {
        binds++
        return {
          Id: { UniqueId: "1" },
          Subject: "Subject",
          From: { Address: "alice@example.com" },
          ToRecipients: { GetEnumerator: () => [{ Address: "to@example.com" }] },
          CcRecipients: { GetEnumerator: () => [{ Address: "cc1@example.com" }] },
          DateTimeReceived: { ToISOString: () => "2026-10-23T09:41:32Z" },
          IsRead: false,
          HasAttachments: false,
          Preview: "preview",
          Body: { Text: "cached body", BodyType: 0 },
        }
      },
    }

    const first = await backend.getMessage({ id: "1" })
    const second = await backend.getMessage({ id: "1" })

    expect(binds).toBe(1)
    expect(first.to).toEqual(["to@example.com"])
    expect(first.cc).toEqual(["cc1@example.com"])
    expect(second.to).toEqual(first.to)
    expect(second.cc).toEqual(first.cc)
    expect(second.body).toBe(first.body)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("search serialization", () => {
  test("an ampersand in the query reaches EWS escaped, not raw", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    let captured: { searchFilters?: Array<{ Value?: string }> } | undefined
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async (_folder: unknown, filter: { searchFilters?: Array<{ Value?: string }> }) => {
        captured = filter
        return { Items: [] }
      },
      LoadPropertiesForItems: async () => {},
    }

    expect(await backend.searchMessages({ query: "R&D", limit: 5 })).toEqual([])
    const values = (captured?.searchFilters ?? []).map((filter) => filter.Value)
    expect(values).toEqual(["R&amp;D", "R&amp;D"])
    // No bare ampersand may reach the SOAP document: it would break the request.
    for (const value of values) expect(value).not.toMatch(/&(?!(?:amp|lt|gt|quot|apos);)/)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("trims leading and trailing whitespace before the EWS query", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    let captured: { searchFilters?: Array<{ Value?: string }> } | undefined
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async (_folder: unknown, filter: { searchFilters?: Array<{ Value?: string }> }) => {
        captured = filter
        return { Items: [] }
      },
      LoadPropertiesForItems: async () => {},
    }

    expect(await backend.searchMessages({ query: "  R&D  ", limit: 5 })).toEqual([])
    const values = (captured?.searchFilters ?? []).map((filter) => filter.Value)
    expect(values).toEqual(["R&amp;D", "R&amp;D"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("does not call EWS when the query is empty after XML sanitization", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    let findCalls = 0
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => {
        findCalls++
        return { Items: [] }
      },
      LoadPropertiesForItems: async () => {},
    }

    expect(await backend.searchMessages({ query: "\u0001\uFFFF", limit: 5 })).toEqual([])
    expect(await backend.searchMessages({ query: "   ", limit: 5 })).toEqual([])
    expect(await backend.searchMessages({ query: "2026-10-23T10:00:60", limit: 5 })).toEqual([])
    expect(await backend.searchMessages({ query: "2026-10-23 10:00:60", limit: 5 })).toEqual([])
    expect(await backend.searchMessages({ query: "2026-10-23 10:00::0,", limit: 5 })).toEqual([])
    expect(await backend.searchMessages({ query: "2026-10-23 10:00:0,Z", limit: 5 })).toEqual([])
    expect(await backend.searchMessages({ query: "2026-10-23 10:00:0+03:00Z", limit: 5 })).toEqual([])
    expect(findCalls).toBe(0)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("contacts scan budget", () => {
  test("a filtered scan reads at most 500 contacts (200 + 200 + 100)", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    const pages: Array<{ offset: number; count: number }> = []
    const contact = (index: number) => ({
      Id: { UniqueId: `c${index}` },
      DisplayName: index >= 480 && index < 485 ? `Zebra ${index}` : `Person ${index}`,
      CompanyName: "Example",
      EmailAddresses: { GetEnumerator: () => [{ Address: `p${index}@example.com` }] },
    })
    const all = Array.from({ length: 500 }, (_, index) => contact(index))
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async (_folder: unknown, view: { pageSize: number; offset: number }) => {
        pages.push({ offset: view.offset, count: view.pageSize })
        return { Items: all.slice(view.offset, view.offset + view.pageSize) }
      },
      LoadPropertiesForItems: async () => {},
    }

    const found = await backend.listContacts({ query: "zebra", limit: 200 })
    expect(pages).toEqual([
      { offset: 0, count: 200 },
      { offset: 200, count: 200 },
      { offset: 400, count: 100 },
    ])
    expect(found).toHaveLength(5)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

describe("send result", () => {
  test("mail_send reports {sent: true} because EWS Send returns no id", async () => {
    const cfg = config()
    const backend = new EwsBackend(cfg, openStore(cfg))
    // A real ExchangeService is needed to build the message; only the wire call is stubbed.
    const service = createEwsService(cfg)
    let created = 0
    ;(service as unknown as { CreateItem: unknown }).CreateItem = async (item: unknown) => {
      created++
      return item
    }
    ;(backend as unknown as { service: unknown }).service = service

    const result = await backend.send({ to: ["bot@example.com"], subject: "s", body: "b" })
    expect(result).toEqual({ sent: true })
    expect(created).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigError, resolveAccounts, resolveConfig } from "../src/config"
import { MailService } from "../src/service"
import { openStore } from "../src/store"
import type { MessageSummary } from "../src/types"

const baseConfig = () => ({
  id: "default",
  ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
  username: "CORP\\bot",
  password: "secret",
  selfAddress: "bot@example.com",
  storage: "metadata" as const,
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-store-")),
  maxMessages: 100,
  retentionDays: 365,
  maxBodyBytes: 1000,
  syncIntervalMinutes: 5,
  allowSend: true,
  requestTimeoutMs: 30_000,
  codemode: false,
})

const message = (id: string, subject: string, received: string): MessageSummary => ({
  id,
  subject,
  from: "alice@example.com",
  to: ["bot@example.com"],
  received,
  isRead: false,
  hasAttachments: false,
  preview: `${subject} preview`,
})

describe("resolveConfig", () => {
  test("parses required values and defaults", () => {
    const config = resolveConfig({ ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }, {})
    expect(config.storage).toBe("metadata")
    expect(config.allowSend).toBe(true)
    expect(config.codemode).toBe(false)
    expect(config.username).toBe("D\\u")
  })

  test("codemode is a global plugin option", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }
    expect(resolveConfig({ ...base, codemode: "TRUE" }, {}).codemode).toBe(true)
    expect(resolveConfig({ ...base, codemode: "false" }, {}).codemode).toBe(false)

    const root = mkdtempSync(path.join(tmpdir(), "mail-codemode-"))
    const accounts = resolveAccounts(
      {
        dataDir: root,
        ewsUrl: "https://mail/EWS/Exchange.asmx",
        password: "p",
        username: "D\\a",
        codemode: true,
        accounts: [{ id: "a", codemode: false }, { id: "b" }],
      },
      {},
    )
    expect(accounts.map((account) => account.codemode)).toEqual([true, true])
    rmSync(root, { recursive: true, force: true })
  })

  test("requires domain in username", () => {
    expect(() =>
      resolveConfig({ ewsUrl: "https://mail/EWS/Exchange.asmx", username: "bot", password: "p" }, {}),
    ).toThrow(ConfigError)
  })

  test("requires ewsUrl", () => {
    expect(() => resolveConfig({}, {})).toThrow(ConfigError)
  })

  test("builds ids and per-account data directories", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mail-accounts-"))
    const accounts = resolveAccounts(
      {
        dataDir: root,
        ewsUrl: "https://mail/EWS/Exchange.asmx",
        password: "p",
        username: "D\\a",
        accounts: [{ id: "a" }, { id: "b", username: "D\\b" }],
      },
      {},
    )
    expect(accounts.map((account) => account.id)).toEqual(["a", "b"])
    expect(accounts[0]?.dataDir).toBe(path.join(root, "a"))
    expect(accounts[1]?.dataDir).toBe(path.join(root, "b"))
    rmSync(root, { recursive: true, force: true })
  })

  test("accounts sharing one username still get separate data directories", () => {
    const accounts = resolveAccounts(
      {
        ewsUrl: "https://mail/EWS/Exchange.asmx",
        password: "p",
        username: "D\\same",
        accounts: [{ id: "one" }, { id: "two" }],
      },
      {},
    )
    expect(accounts[0]?.dataDir).not.toBe(accounts[1]?.dataDir)
    expect(path.basename(accounts[0]?.dataDir ?? "")).toBe("one")
    expect(path.basename(accounts[1]?.dataDir ?? "")).toBe("two")
  })

  test("rejects account ids with traversal or separators", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", password: "p", username: "D\\a" }
    for (const id of ["../x", "..", "a/b", "a\\b", "/abs", "a b", ".hidden"]) {
      expect(() => resolveAccounts({ ...base, accounts: [{ id }] }, {})).toThrow(ConfigError)
    }
  })

  test("rejects two accounts resolving to the same dataDir (case-folded on win32)", () => {
    const root = mkdtempSync(path.join(tmpdir(), "mail-dup-"))
    const shared = path.join(root, "Same", "mail")
    const other = process.platform === "win32" ? path.join(root, "same", "MAIL") : shared
    expect(() =>
      resolveAccounts(
        {
          ewsUrl: "https://mail/EWS/Exchange.asmx",
          password: "p",
          username: "D\\a",
          accounts: [
            { id: "a", dataDir: shared },
            { id: "b", dataDir: other },
          ],
        },
        {},
      ),
    ).toThrow(ConfigError)
    rmSync(root, { recursive: true, force: true })
  })

  test("rejects a trailing-dot dataDir collision on win32", () => {
    if (process.platform !== "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "mail-dup-dot-"))
    expect(() =>
      resolveAccounts(
        {
          ewsUrl: "https://mail/EWS/Exchange.asmx",
          password: "p",
          username: "D\\a",
          accounts: [
            { id: "a", dataDir: path.join(root, "shared") },
            { id: "b", dataDir: path.join(root, "shared.") },
          ],
        },
        {},
      ),
    ).toThrow(ConfigError)
    rmSync(root, { recursive: true, force: true })
  })

  test("rejects ids that collapse to the same win32 dataDir", () => {
    if (process.platform !== "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "mail-dup-id-"))
    expect(() =>
      resolveAccounts(
        {
          dataDir: root,
          ewsUrl: "https://mail/EWS/Exchange.asmx",
          password: "p",
          username: "D\\a",
          accounts: [{ id: "a" }, { id: "a." }],
        },
        {},
      ),
    ).toThrow(ConfigError)
    rmSync(root, { recursive: true, force: true })
  })

  test("normalizes win32 trailing dots in dataDir", () => {
    if (process.platform !== "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "mail-dot-"))
    const accounts = resolveAccounts(
      {
        dataDir: path.join(root, "mail."),
        ewsUrl: "https://mail/EWS/Exchange.asmx",
        password: "p",
        username: "D\\a",
        accounts: [{ id: "a" }],
      },
      {},
    )
    expect(accounts[0]?.dataDir).toBe(path.join(root, "mail", "a"))
    rmSync(root, { recursive: true, force: true })
  })

  test("resolves MAIL_PASSWORD_<ID> for auto-generated account ids", () => {
    const accounts = resolveAccounts(
      {
        ewsUrl: "https://mail/EWS/Exchange.asmx",
        username: "D\\u",
        accounts: [{}, {}],
      },
      { MAIL_PASSWORD_ACCOUNT_1: "one", MAIL_PASSWORD_ACCOUNT_2: "two" },
    )
    expect(accounts.map((account) => account.id)).toEqual(["account-1", "account-2"])
    expect(accounts.map((account) => account.password)).toEqual(["one", "two"])
  })

  test("rejects an unknown storage mode instead of silently storing metadata", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }
    expect(() => resolveConfig({ ...base, storage: "none" }, {})).toThrow(ConfigError)
    expect(resolveConfig({ ...base, storage: "full" }, {}).storage).toBe("full")
  })

  test("truncates fractional numeric options and keeps them at least 1", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }
    const config = resolveConfig({ ...base, maxMessages: 1.9, requestTimeoutMs: 2.7 }, {})
    expect(config.maxMessages).toBe(1)
    expect(config.requestTimeoutMs).toBe(2)
    const tiny = resolveConfig({ ...base, retentionDays: 0.5, maxBodyBytes: 0.5 }, {})
    expect(tiny.retentionDays).toBe(1)
    expect(tiny.maxBodyBytes).toBe(1)
  })

  test("rejects a missing caFile and reads env fallbacks", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }
    expect(() => resolveConfig({ ...base, caFile: "C:/definitely/missing.pem" }, {})).toThrow(ConfigError)
    const config = resolveConfig(
      {},
      {
        MAIL_EWS_URL: "https://env.example.com/EWS/Exchange.asmx",
        MAIL_USER: "D\\u",
        MAIL_PASSWORD: "p",
        MAIL_SELF: "bot@example.com",
        MAIL_DATA_DIR: "C:/tmp/mail-data",
      },
    )
    expect(config.ewsUrl).toBe("https://env.example.com/EWS/Exchange.asmx")
    expect(config.selfAddress).toBe("bot@example.com")
    expect(config.dataDir).toBe("C:/tmp/mail-data")
  })

  test("parses booleans case-insensitively", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }
    const off = resolveConfig({ ...base, allowSend: "FALSE" }, {})
    expect(off.allowSend).toBe(false)
    expect(resolveConfig({ ...base, allowSend: "Yes" }, {}).allowSend).toBe(true)
    expect(resolveConfig({ ...base, allowSend: "on" }, {}).allowSend).toBe(true)
    expect(resolveConfig({ ...base, allowSend: "0" }, {}).allowSend).toBe(false)
    expect(resolveConfig({ ...base, allowSend: "no" }, {}).allowSend).toBe(false)
  })

  test("rejects an unrecognized allowSend instead of silently enabling sending", () => {
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", username: "D\\u", password: "p" }
    for (const allowSend of ["maybe", "disabled", 2, {}, "true-ish"]) {
      expect(() => resolveConfig({ ...base, allowSend }, {})).toThrow(ConfigError)
    }
  })
})

describe("store", () => {
  test("keeps metadata, searches and tombstones", () => {
    const config = baseConfig()
    const store = openStore(config)
    expect(store).toBeDefined()
    if (!store) return

    store.upsertMessages("wk:inbox", [
      message("1", "Проверка SMTP", "2026-10-23T09:41:32Z"),
      message("2", "Отчёт за октябрь", "2026-10-22T09:00:00Z"),
    ])

    expect(store.count()).toBe(2)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 })[0]?.subject).toBe("Проверка SMTP")
    expect(store.search("провер*", 10)[0]?.id).toBe("1")
    expect(store.search("октябрь", 10)[0]?.id).toBe("2")

    store.putBody("1", "полный текст письма", "text", false)
    expect(store.getMessage("1")?.body).toBe("полный текст письма")
    expect(store.search("полный", 10)[0]?.id).toBe("1")

    store.tombstone(["1"])
    expect(store.getMessage("1")).toBeUndefined()
    expect(store.search("полный", 10)).toHaveLength(0)

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("keeps message body in FTS across metadata upserts", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1", "Subject", "2026-10-23T09:41:32Z")])
    store.putBody("1", "уникальное слово зебра", "text", false)
    expect(store.search("зебра", 10)[0]?.id).toBe("1")

    // A later sync updates headers only; the body must stay searchable.
    store.upsertMessages("wk:inbox", [message("1", "Subject v2", "2026-10-23T09:41:32Z")])
    expect(store.search("зебра", 10)[0]?.id).toBe("1")
    expect(store.getMessage("1")?.body).toBe("уникальное слово зебра")

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("searches apostrophes and every token, not just the first eight", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("apos", "O'Brien quarterly report", "2026-10-23T09:00:00Z"),
      message("dont", "please don't panic", "2026-10-22T09:00:00Z"),
      message("long", "alpha beta gamma delta epsilon zeta eta theta iota", "2026-10-21T09:00:00Z"),
    ])
    expect(store.search("O'Brien", 10).map((item) => item.id)).toEqual(["apos"])
    expect(store.search("don't", 10).map((item) => item.id)).toEqual(["dont"])
    expect(store.search("alpha beta gamma delta epsilon zeta eta theta iota", 10).map((item) => item.id)).toEqual([
      "long",
    ])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("keeps punctuation-separated words adjacent (R&D is not r AND d)", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("true", "R&D roadmap review", "2026-10-23T09:00:00Z"),
      message("noise-1", "Re: Draft agenda", "2026-10-23T08:00:00Z"),
      message("noise-2", "Report data", "2026-10-23T07:00:00Z"),
      message("noise-3", "Risk decision", "2026-10-23T06:00:00Z"),
      message("qa", "Q&A session", "2026-10-23T05:00:00Z"),
      message("quick", "Quick answer", "2026-10-23T04:00:00Z"),
    ])
    expect(store.search("R&D", 10).map((item) => item.id)).toEqual(["true"])
    expect(store.search("Q&A", 10).map((item) => item.id)).toEqual(["qa"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("applies read flags", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [
      message("1", "One", "2026-10-23T09:41:32Z"),
      message("2", "Two", "2026-10-22T09:41:32Z"),
    ])
    expect(store.getMessage("1")?.isRead).toBe(false)

    store.markRead(["1", "2"], true)
    expect(store.getMessage("1")?.isRead).toBe(true)
    expect(store.getMessage("2")?.isRead).toBe(true)

    store.markRead(["1"], false)
    expect(store.getMessage("1")?.isRead).toBe(false)
    expect(store.getMessage("2")?.isRead).toBe(true)

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("stores CC recipients and can refresh them after a bind", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [{ ...message("1", "One", "2026-10-23T09:41:32Z"), cc: ["cc@example.com"] }])
    expect(store.getMessage("1")?.cc).toEqual(["cc@example.com"])

    store.updateRecipients("1", ["to@example.com"], ["cc2@example.com", "cc3@example.com"])
    const detail = store.getMessage("1")
    expect(detail?.to).toEqual(["to@example.com"])
    expect(detail?.cc).toEqual(["cc2@example.com", "cc3@example.com"])

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("an empty recipient list is stored as known and survives a header-only upsert", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [{ ...message("1", "One", "2026-10-23T09:41:32Z"), to: [] }])
    expect(store.getMessage("1")?.recipientsKnown).toBe(false)

    store.updateRecipients("1", [], [])
    expect(store.getMessage("1")?.recipientsKnown).toBe(true)
    expect(store.getMessage("1")?.to).toEqual([])

    // Sync payloads carry no recipients at all: the "known empty" flag must not be erased.
    store.upsertMessages("wk:inbox", [{ ...message("1", "One", "2026-10-23T09:41:32Z"), to: [] }])
    expect(store.getMessage("1")?.recipientsKnown).toBe(true)

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("prune drops bodies that have no message row", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1", "One", "2026-10-23T09:41:32Z")])
    store.putBody("1", "body", "text", false)
    // Orphan left behind by an older version (before putBody refused unindexed messages).
    const file = path.join(config.dataDir, "mail.db")
    const db = new Database(file)
    db.run("insert into bodies (message_id, body, body_type, truncated, fetched_ts) values (?, ?, ?, 0, ?)", [
      "ghost",
      "orphan",
      "text",
      Date.now(),
    ])
    db.close()

    store.prune(100, 365)

    const check = new Database(file)
    const rows = check.query("select message_id from bodies order by message_id").all() as Array<{ message_id: string }>
    check.close()
    expect(rows.map((row) => row.message_id)).toEqual(["1"])
    expect(store.getMessage("1")?.body).toBe("body")

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("clears sync state", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")

    store.setSyncState("wk:inbox", "token-1")
    expect(store.getSyncState("wk:inbox")?.token).toBe("token-1")

    store.clearSyncState("wk:inbox")
    expect(store.getSyncState("wk:inbox")).toBeUndefined()

    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })
})

describe("MailService degradation", () => {
  test("keeps serving EWS when the local index cannot be opened", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "mail-degrade-"))
    const blocker = path.join(dir, "blocked")
    writeFileSync(blocker, "not a directory")

    const service = new MailService([{ ...baseConfig(), dataDir: blocker }])
    expect(service.ids()).toEqual(["default"])
    service.close()

    rmSync(dir, { recursive: true, force: true })
  })
})

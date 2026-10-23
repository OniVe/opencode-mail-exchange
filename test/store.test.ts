import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
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

  test("rejects extended-length and device dataDir paths", () => {
    if (process.platform !== "win32") return
    const base = { ewsUrl: "https://mail/EWS/Exchange.asmx", password: "p", username: "D\\a" }
    for (const dataDir of [String.raw`\\?\C:\data\rt-mail`, String.raw`\\.\C:\data\rt-mail`]) {
      expect(() => resolveConfig({ ...base, dataDir }, {})).toThrow(ConfigError)
      expect(() => resolveAccounts({ ...base, accounts: [{ id: "a", dataDir }] }, {})).toThrow(ConfigError)
    }
  })

  test("rejects an extended top-level dataDir even when an account overrides it", () => {
    if (process.platform !== "win32") return
    const base = {
      dataDir: String.raw`\\?\C:\data\rt-mail`,
      ewsUrl: "https://mail/EWS/Exchange.asmx",
      password: "p",
      username: "D\\a",
    }
    for (const override of ["", null, "   ", 0]) {
      expect(() => resolveAccounts({ ...base, accounts: [{ id: "a", dataDir: override }] }, {})).toThrow(ConfigError)
    }
    const root = mkdtempSync(path.join(tmpdir(), "mail-ext-root-"))
    expect(() => resolveAccounts({ ...base, accounts: [{ id: "a", dataDir: path.join(root, "normal") }] }, {})).toThrow(
      ConfigError,
    )
    rmSync(root, { recursive: true, force: true })
  })

  test("rejects a junction that resolves to the same dataDir", () => {
    if (process.platform !== "win32") return
    const root = mkdtempSync(path.join(tmpdir(), "mail-junction-"))
    const real = path.join(root, "real")
    const link = path.join(root, "link")
    mkdirSync(real)
    symlinkSync(real, link, "junction")
    expect(() =>
      resolveAccounts(
        {
          ewsUrl: "https://mail/EWS/Exchange.asmx",
          password: "p",
          username: "D\\a",
          accounts: [
            { id: "a", dataDir: real },
            { id: "b", dataDir: link },
          ],
        },
        {},
      ),
    ).toThrow(ConfigError)
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

  test("keeps punctuation-separated words adjacent, even with spaces or partial dates", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("rd", "R&D roadmap review", "2026-10-23T09:00:00Z"),
      message("spaced", "R & D roadmap", "2026-10-22T09:00:00Z"),
      message("noise-1", "Re: Draft agenda", "2026-10-21T09:00:00Z"),
      message("noise-2", "Report data", "2026-10-20T09:00:00Z"),
      message("noise-3", "Risk decision", "2026-10-19T09:00:00Z"),
      message("qa", "Q&A session", "2026-10-18T09:00:00Z"),
      message("quick", "Quick answer", "2026-10-17T09:00:00Z"),
      message("date", "2026-10-23 report", "2026-10-16T09:00:00Z"),
      message("addr", "john.doe@example.com", "2026-10-15T09:00:00Z"),
      message("obrien", "O'Brien report", "2026-10-12T09:00:00Z"),
      message("obriens", "O'Briens report", "2026-10-11T09:00:00Z"),
      message("at", "at the table", "2026-10-14T09:00:00Z"),
      message("ithink", "I think so", "2026-10-13T09:00:00Z"),
    ])
    expect(store.search("R&D", 10).map((item) => item.id)).toEqual(["rd", "spaced"])
    expect(store.search("R & D", 10).map((item) => item.id)).toEqual(["rd", "spaced"])
    expect(store.search("Q&A", 10).map((item) => item.id)).toEqual(["qa"])
    expect(store.search("202-10", 10).map((item) => item.id)).toEqual(["date"])
    expect(store.search("j.doe@example.com", 10).map((item) => item.id)).toEqual(["addr"])
    expect(store.search("j.doe", 10).map((item) => item.id)).toEqual(["addr"])
    expect(store.search("O'Bri", 10).map((item) => item.id)).toEqual(["obrien", "obriens"])
    expect(store.search("O'Brien", 10).map((item) => item.id)).toEqual(["obrien", "obriens"])
    expect(store.search("AT&T", 10)).toEqual([])
    expect(store.search("I&T", 10)).toEqual([])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("dotted initials do not fuzzy-match and numeric versions stay exact", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("report", "Report data", "2026-10-20T09:00:00Z"),
      message("jdot", "J.D. notes", "2026-10-19T09:00:00Z"),
      message("johndoe", "John Doe", "2026-10-18T09:00:00Z"),
      message("numeric", "1.2 release", "2026-10-16T09:00:00Z"),
      message("numnoise", "1 200 units", "2026-10-24T09:00:00Z"),
    ])
    expect(store.search("R.D", 10)).toEqual([])
    expect(store.search("J.D.", 10).map((item) => item.id)).toEqual(["jdot"])
    expect(store.search("j.doe", 10).map((item) => item.id)).toEqual(["johndoe"])
    expect(store.search("1.2", 1).map((item) => item.id)).toEqual(["numeric"])
    expect(store.search("1.2", 10).map((item) => item.id)).toEqual(["numeric"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("dotted versions stay exact in the primary pass", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("v12", "v1.2 release", "2026-10-16T09:00:00Z"),
      message("v123", "v1.2.3 release", "2026-10-15T09:00:00Z"),
      message("v1200", "v1 200 units", "2026-10-24T09:00:00Z"),
    ])
    expect(store.search("v1.2", 1).map((item) => item.id)).toEqual(["v12"])
    expect(store.search("v1.2", 10).map((item) => item.id)).toEqual(["v12", "v123"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("an exact numeric date is not displaced by newer partial-number noise", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("date-true", "2026-10-23 report", "2026-10-16T09:00:00Z"),
      message("noise-num", "2026 plan: 10 hires, 23 desks", "2026-10-24T09:00:00Z"),
    ])
    expect(store.search("2026-10-23", 1).map((item) => item.id)).toEqual(["date-true"])
    expect(store.search("2026-10-23", 3).map((item) => item.id)).toEqual(["date-true"])
    // A partial date falls back to prefixes and may match both; the exact date must be present.
    expect(store.search("202-10", 10).map((item) => item.id)).toContain("date-true")
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("ISO zone and h-suffix times match date and time queries", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("z10", "call 2026-10-23T10Z", "2026-10-18T09:00:00Z"),
      message("z3", "call 2026-10-23T3Z", "2026-10-19T09:00:00Z"),
      message("h10", "time 2026-10-23T10h30", "2026-10-20T09:00:00Z"),
      message("t30", "invalid 2026-10-23T30:00", "2026-10-27T09:00:00Z"),
      message("t3text", "invalid 2026-10-23T3text", "2026-10-29T09:00:00Z"),
    ])
    expect(store.search("2026-10-23", 10).map((item) => item.id)).toEqual(["h10", "z3", "z10"])
    expect(store.search("2026-10-23T3", 10).map((item) => item.id)).toEqual(["z3"])
    expect(store.search("2026-10-23T10Z", 10).map((item) => item.id)).toContain("z10")
    expect(store.search("2026-10-23T10h30", 10).map((item) => item.id)).toEqual(["h10"])
    expect(store.search("2026-10-23T10:30", 10).map((item) => item.id)).toEqual(["h10"])
    expect(store.search("2026-10-23T10h30Z", 10)).toEqual([])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("date search normalizes padding and validates time suffixes", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("padDate", "padded 2026-10-03T10:00:00Z", "2026-10-10T09:00:00Z"),
      message("unpaddedDate", "unpadded 2026-10-3T9:45:00Z", "2026-10-11T09:00:00Z"),
      message("p09", "padded hour 2026-10-23T09:30:00Z", "2026-10-12T09:00:00Z"),
      message("s9", "single hour 2026-10-23T9:45:00Z", "2026-10-13T09:00:00Z"),
      message("t24", "invalid 2026-10-23T24:00", "2026-10-14T09:00:00Z"),
      message("hello", "odd 2026-10-23T3hello", "2026-10-15T09:00:00Z"),
      message("h99", "invalid 2026-10-23T10h99", "2026-10-16T09:00:00Z"),
      message("htext", "invalid 2026-10-23T10h30text", "2026-10-17T09:00:00Z"),
      message("n7", "units 2026 10 2345", "2026-10-18T09:00:00Z"),
      message("h10", "time 2026-10-23T10h30", "2026-10-19T09:00:00Z"),
      message("z10", "call 2026-10-23T10Z", "2026-10-20T09:00:00Z"),
    ])
    expect(store.search("2026-10-3", 10).map((item) => item.id)).toEqual(["unpaddedDate", "padDate"])
    expect(store.search("2026-10-03", 10).map((item) => item.id)).toEqual(["unpaddedDate", "padDate"])
    expect(store.search("2026-10-23T9", 10).map((item) => item.id)).toEqual(["s9", "p09"])
    expect(store.search("2026-10-23T09", 10).map((item) => item.id)).toEqual(["s9", "p09"])
    expect(store.search("2026 10 23", 20).map((item) => item.id)).toEqual(["z10", "h10", "s9", "p09"])
    expect(store.search("2026-10-23T10Z", 10).map((item) => item.id)).toEqual(["z10"])
    expect(store.search("2026-10-23T10h30", 10).map((item) => item.id)).toEqual(["h10"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("date scan handles space, offset, fractional Z and mixed text", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("sp_time", "2026-10-23 10:00", "2026-10-10T09:00:00Z"),
      message("sp_num", "2026-10-23 5 items", "2026-10-11T09:00:00Z"),
      message("sp_full", "2026 10 23 10:30", "2026-10-12T09:00:00Z"),
      message("off", "2026-10-23T10+02:00", "2026-10-13T09:00:00Z"),
      message("fracZ", "2026-10-23T10:00:00.000Z", "2026-10-14T09:00:00Z"),
      message("z10", "2026-10-23T10Z", "2026-10-15T09:00:00Z"),
      message("report", "2026-10-23 report", "2026-10-16T09:00:00Z"),
      message("h99", "2026-10-23T10h99", "2026-10-17T09:00:00Z"),
      message("htext", "2026-10-23T10h30text", "2026-10-18T09:00:00Z"),
    ])
    const all = store.search("2026-10-23", 20).map((item) => item.id)
    expect(all).toContain("sp_time")
    expect(all).toContain("sp_num")
    expect(all).toContain("sp_full")
    expect(all).toContain("off")
    expect(all).toContain("fracZ")
    expect(all).not.toContain("h99")
    expect(all).not.toContain("htext")
    expect(store.search("2026-10-23 10:00", 10).map((item) => item.id)).toContain("sp_time")
    expect(store.search("2026 10 23 10:30", 10).map((item) => item.id)).toEqual(["sp_full"])
    expect(store.search("2026-10-23T10+02:00", 10).map((item) => item.id)).toEqual(["off"])
    expect(store.search("2026-10-23T10Z", 10).map((item) => item.id)).toContain("z10")
    expect(store.search("2026-10-23T10Z", 10).map((item) => item.id)).not.toContain("off")
    expect(store.search("2026-10-23T10:00Z", 10).map((item) => item.id)).toContain("fracZ")
    expect(store.search("2026-10-23 report", 10).map((item) => item.id)).toEqual(["report"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("date+text uses sender, rejects Z-text and accepts space-hour and quotes", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      { ...message("alice", "2026-10-23", "2026-10-10T09:00:00Z"), from: "unique@example.com" },
      message("zebra", "2026-10-23Zebra", "2026-10-11T09:00:00Z"),
      message("zone", "2026-10-23Zone", "2026-10-12T09:00:00Z"),
      message("z10", "2026-10-23Z10", "2026-10-13T09:00:00Z"),
      message("t10", "2026-10-23T10:00", "2026-10-14T09:00:00Z"),
      message("t23", "2026-10-23T23:00", "2026-10-15T09:00:00Z"),
      message("quote", "2026-10-23 quarterly report", "2026-10-16T09:00:00Z"),
      message("amp", "2026-10-23 & report", "2026-10-17T09:00:00Z"),
      message("cpp", "2026-10-23 C++", "2026-10-18T09:00:00Z"),
      message("csharp", "2026-10-23 C#", "2026-10-19T09:00:00Z"),
      message("rT10", "2026-10-23T10:00 report", "2026-10-20T09:00:00Z"),
      message("rT23", "2026-10-23T23:00 report", "2026-10-21T09:00:00Z"),
      message("sp_num", "2026-10-23 5 items", "2026-10-22T09:00:00Z"),
      message("fifteen", "2026-10-23T15:00 items", "2026-10-23T09:00:00Z"),
      message("obrien", "2026-10-23 O'Brien", "2026-10-24T09:00:00Z"),
      message("rd", "2026-10-23 R&D roadmap", "2026-10-25T09:00:00Z"),
      message("rdSpaced", "2026-10-23 R & D roadmap", "2026-10-26T09:00:00Z"),
      message("cppSpaced", "2026-10-23 C + + notes", "2026-10-27T09:00:00Z"),
      message("abcpp", "2026-10-23 abc++", "2026-10-28T09:00:00Z"),
      message("bar", "2026-10-23 bar&doe", "2026-10-29T09:00:00Z"),
      message("abcsharp", "2026-10-23 abc#", "2026-10-30T09:00:00Z"),
      message("dash", "2026-10-23 -report note", "2026-10-31T09:00:00Z"),
      message("ell", "2026-10-23 ...report note", "2026-11-01T09:00:00Z"),
      message("guillemets", "2026-10-23 «report» note", "2026-11-02T09:00:00Z"),
      message("ellipsis", "2026-10-23 report… note", "2026-11-03T09:00:00Z"),
      message("slash", "2026-10-23 report/ note", "2026-11-04T09:00:00Z"),
      message("carbon", "2026-10-23 carbon copy", "2026-11-05T09:00:00Z"),
      message("censored", "2026-10-23 censored", "2026-11-06T09:00:00Z"),
      { ...message("fromDate", "no date in text", "2026-10-28T09:00:00Z"), from: "2026-10-23@example.com" },
    ])
    expect(store.search("2026-10-23 unique", 10).map((item) => item.id)).toEqual(["alice"])
    const all = store.search("2026-10-23", 20).map((item) => item.id)
    expect(all).not.toContain("zebra")
    expect(all).not.toContain("zone")
    expect(all).not.toContain("z10")
    expect(store.search("2026-10-23 10", 10).map((item) => item.id)).toEqual(["rT10", "t10"])
    expect(store.search('2026-10-23 "quarterly report"', 10).map((item) => item.id)).toEqual(["quote"])
    expect(store.search("2026-10-23 & report", 10).map((item) => item.id)).toEqual(["amp"])
    expect(store.search("2026-10-23 C#", 10).map((item) => item.id)).toEqual(["csharp"])
    expect(store.search("2026-10-23 10 report", 10).map((item) => item.id)).toEqual(["rT10"])
    expect(store.search("2026-10-23 5 items", 10).map((item) => item.id)).toEqual(["sp_num"])
    expect(store.search("2026-10-23 rep", 10).map((item) => item.id)).toContain("quote")
    expect(store.search("2026-10-23 O'Bri", 10).map((item) => item.id)).toEqual(["obrien"])
    expect(store.search("2026-10-23 report,", 10).map((item) => item.id)).toContain("quote")
    expect(store.search("2026-10-23 10:00 report", 10).map((item) => item.id)).toEqual(["rT10"])
    expect(store.search("2026-10-23 (report)", 10).map((item) => item.id)).toContain("quote")
    expect(store.search("2026-10-23 report.", 10).map((item) => item.id)).toContain("quote")
    expect(store.search("2026-10-23 R&D", 10).map((item) => item.id)).toEqual(["rdSpaced", "rd"])
    expect(store.search("2026-10-23 C++", 10).map((item) => item.id)).toEqual(["cppSpaced", "cpp"])
    expect(store.search("2026-10-23 C#", 10).map((item) => item.id)).toEqual(["csharp"])
    expect(store.search("2026-10-23 -report", 10).map((item) => item.id)).toContain("quote")
    expect(store.search("2026-10-23 ...report", 10).map((item) => item.id)).toContain("quote")
    expect(store.search("2026-10-23 «report»", 10).map((item) => item.id)).toContain("guillemets")
    expect(store.search("2026-10-23 report…", 10).map((item) => item.id)).toContain("ellipsis")
    expect(store.search("2026-10-23 report/", 10).map((item) => item.id)).toContain("slash")
    expect(store.search("2026-10-23 (C++)", 10).map((item) => item.id)).toEqual(["cppSpaced", "cpp"])
    expect(store.search("2026-10-23 C++.", 10).map((item) => item.id)).toEqual(["cppSpaced", "cpp"])
    expect(store.search("2026-10-23 C#,", 10).map((item) => item.id)).toEqual(["csharp"])
    expect(store.search("2026-10-23", 30).map((item) => item.id)).toContain("fromDate")
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("space h-time, seconds and wide punctuation gaps", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("hSpace", "2026-10-23 10h30", "2026-10-10T09:00:00Z"),
      message("hT", "2026-10-23T10h30", "2026-10-11T09:00:00Z"),
      message("secSpace", "2026-10-23 10:00:00", "2026-10-12T09:00:00Z"),
      message("secT", "2026-10-23T10:00:00", "2026-10-13T09:00:00Z"),
      message("rd3", "2026-10-23 R   &   D roadmap", "2026-10-14T09:00:00Z"),
      message("cpp3", "2026-10-23 C   +   + notes", "2026-10-15T09:00:00Z"),
    ])
    expect(store.search("2026-10-23 10h30", 10).map((item) => item.id)).toEqual(["hT", "hSpace"])
    expect(store.search("2026-10-23T10h30", 10).map((item) => item.id)).toEqual(["hT", "hSpace"])
    expect(store.search("2026-10-23T10:00:00", 10).map((item) => item.id)).toContain("secT")
    expect(store.search("2026-10-23 10:00:00", 10).map((item) => item.id)).toContain("secSpace")
    expect(store.search("2026-10-23 R&D", 10).map((item) => item.id)).toEqual(["rd3"])
    expect(store.search("2026-10-23 C++", 10).map((item) => item.id)).toEqual(["cpp3"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("a single-digit ISO hour still matches the date", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("single", "2026-10-23T3:00:00Z meeting", "2026-10-18T09:00:00Z")])
    expect(store.search("2026-10-23", 10).map((item) => item.id)).toEqual(["single"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("a date does not match a longer numeric suffix", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("exact", "2026-10-23 report", "2026-10-16T09:00:00Z"),
      message("iso", "2026-10-23T10:00 meeting", "2026-10-17T09:00:00Z"),
      message("long-suffix", "units 2026 10 2345 total", "2026-10-24T09:00:00Z"),
      message("txn", "order 2026-10-23TXN-9", "2026-10-25T09:00:00Z"),
      message("text", "note 2026-10-23text", "2026-10-26T09:00:00Z"),
      message("t30", "invalid 2026-10-23T30:00", "2026-10-27T09:00:00Z"),
      message("t99", "invalid 2026-10-23T99:00", "2026-10-28T09:00:00Z"),
      message("t3text", "invalid 2026-10-23T3text", "2026-10-29T09:00:00Z"),
    ])
    expect(store.search("2026-10-23", 10).map((item) => item.id)).toEqual(["iso", "exact"])
    expect(store.search("2026-10-23", 1).map((item) => item.id)).toEqual(["iso"])
    store.close()
    rmSync(config.dataDir, { recursive: true, force: true })
  })

  test("an ISO timestamp matches the date phrase", () => {
    const config = baseConfig()
    const store = openStore(config)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("exact", "2026-10-23 report", "2026-10-16T09:00:00Z"),
      message("iso", "2026-10-23T10:00 meeting", "2026-10-24T09:00:00Z"),
    ])
    expect(store.search("2026-10-23", 10).map((item) => item.id)).toEqual(["iso", "exact"])
    expect(store.search("2026-10-23", 1).map((item) => item.id)).toEqual(["iso"])
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

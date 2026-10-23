import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EwsBackend } from "../src/backend"
import type { MailConfig } from "../src/config"
import { openStore } from "../src/store"
import type { MessageSummary } from "../src/types"

const config = (): MailConfig => ({
  id: "default",
  ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
  username: "CORP\\bot",
  password: "secret",
  selfAddress: "bot@example.com",
  storage: "full",
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-search-")),
  maxMessages: 100,
  retentionDays: 365,
  maxBodyBytes: 1000,
  syncIntervalMinutes: 5,
  allowSend: true,
  requestTimeoutMs: 30_000,
  codemode: false,
})

const message = (id: string, received: string, overrides: Partial<MessageSummary> = {}): MessageSummary => ({
  id,
  subject: "invoice",
  from: "alice@example.com",
  to: ["bot@example.com"],
  received,
  isRead: false,
  hasAttachments: false,
  preview: "",
  ...overrides,
})

const ewsItem = (overrides: Record<string, unknown> = {}) => ({
  Id: { UniqueId: "a" },
  Subject: "remote subject",
  From: { Address: "remote@example.com" },
  ToRecipients: { GetEnumerator: () => [{ Address: "to@example.com" }] },
  CcRecipients: { GetEnumerator: () => [] },
  DateTimeReceived: { ToISOString: () => "2026-10-25T10:00:00.000Z" },
  IsRead: true,
  HasAttachments: false,
  Preview: "remote preview",
  ConversationId: { UniqueId: "conv-remote" },
  ...overrides,
})

describe("searchMessages", () => {
  test("merges both halves and the EWS page is requested newest-first", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    // The local half is intentionally ordered by received date now, so `limit` keeps the newest.
    store.upsertMessages("wk:inbox", [
      message("old", "2026-10-01T00:00:00Z"),
      message("mid", "2026-10-10T00:00:00Z"),
      message("new", "2026-10-23T00:00:00Z"),
    ])
    const backend = new EwsBackend(cfg, store)
    let view: { OrderBy?: { Count?: number } } | undefined
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async (_folder: unknown, _filter: unknown, receivedView: { OrderBy?: { Count?: number } }) => {
        view = receivedView
        return { Items: [] }
      },
      LoadPropertiesForItems: async () => {},
    }

    const found = await backend.searchMessages({ query: "invoice", limit: 2 })
    expect(found.map((item) => item.id)).toEqual(["new", "mid"])
    expect(view?.OrderBy?.Count).toBe(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a duplicate id keeps fresh EWS metadata and local recipients", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [
      message("a", "2026-10-20T10:00:00Z", {
        subject: "local subject",
        from: "local@example.com",
        conversationId: "conv-local",
        to: [],
        recipientsKnown: false,
        preview: "local preview",
      }),
    ])
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      FindItems: async () => ({ Items: [ewsItem()] }),
      LoadPropertiesForItems: async () => {},
    }

    const found = await backend.searchMessages({ query: "invoice", limit: 10 })
    expect(found).toHaveLength(1)
    expect(found[0]?.subject).toBe("remote subject")
    expect(found[0]?.from).toBe("remote@example.com")
    expect(found[0]?.received).toBe("2026-10-25T10:00:00.000Z")
    expect(found[0]?.isRead).toBe(true)
    expect(found[0]?.conversationId).toBe("conv-remote")
    expect(found[0]?.to).toEqual(["to@example.com"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

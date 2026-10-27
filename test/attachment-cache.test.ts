import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { attachmentInfo, EwsBackend } from "../src/backend"
import type { MailConfig } from "../src/config"
import { openStore } from "../src/store"
import type { AttachmentText } from "../src/types"

const config = (storage: MailConfig["storage"] = "full"): MailConfig => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "mail-attachment-cache-"))
  return {
    id: "default",
    ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
    username: "CORP\\bot",
    password: "secret",
    selfAddress: "bot@example.com",
    storage,
    dataDir,
    maxMessages: 100,
    retentionDays: 365,
    maxBodyBytes: 1000,
    syncIntervalMinutes: 5,
    allowSend: true,
    requestTimeoutMs: 30_000,
    codemode: false,
  }
}

const summary = (id: string, attachmentCount = 1) => ({
  id,
  subject: "Invoice",
  from: "alice@example.com",
  to: ["bot@example.com"],
  received: "2026-10-27T09:00:00Z",
  isRead: false,
  hasAttachments: true,
  attachmentCount,
  preview: "invoice",
})

const text = (messageId: string): AttachmentText => ({
  messageId,
  attachment: {
    id: "a1",
    name: "invoice.pdf",
    contentType: "application/pdf",
    size: 123,
    isInline: false,
    kind: "file",
  },
  kind: "pdf",
  text: "needle total 42",
  truncated: false,
  pages: 1,
})

describe("attachment text cache", () => {
  test("keeps long attachment names and strips control characters", () => {
    const long = attachmentInfo(
      { FileName: `${"x".repeat(116)}.docx`, ContentType: "application/octet-stream\u009bC1" },
      "file",
    )
    expect(long.name.endsWith(".docx")).toBe(true)
    expect(long.name.length).toBeGreaterThan(120)
    expect(long.contentType).not.toContain("\u009b")
    const unsafe = attachmentInfo({ Name: "inv\u009b2J\u202egnp.exe" }, "file")
    expect(unsafe.name).toBe("inv2Jgnp.exe")
  })

  test("stores, reads and searches attachment text", () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      store.upsertMessages("wk:inbox", [summary("m1")])
      expect(store.putAttachmentText(text("m1"))).toBe(true)
      expect(store.getAttachmentText("m1", "a1")).toMatchObject({
        messageId: "m1",
        kind: "pdf",
        text: "needle total 42",
        pages: 1,
        attachment: { name: "invoice.pdf", kind: "file" },
      })
      const found = store.search("needle", 10)
      expect(found).toHaveLength(1)
      expect(found[0]?.id).toBe("m1")
      expect(found[0]?.attachmentMatch).toMatchObject({ id: "a1", name: "invoice.pdf" })
      expect(found[0]?.attachmentMatch?.snippet).toContain("needle")
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("does not cache unindexed messages", () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      expect(store.putAttachmentText(text("missing"))).toBe(false)
      expect(store.getAttachmentText("missing", "a1")).toBeUndefined()
      store.upsertMessages("wk:inbox", [summary("m1")])
      expect(store.putAttachmentText({ ...text("m1"), attachment: { ...text("m1").attachment, id: "" } })).toBe(false)
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("invalidates on tombstone and attachment count changes", () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      store.upsertMessages("wk:inbox", [summary("m1")])
      store.putAttachmentText(text("m1"))
      store.tombstone(["m1"])
      expect(store.getAttachmentText("m1", "a1")).toBeUndefined()
      expect(store.search("needle", 10)).toHaveLength(0)

      store.upsertMessages("wk:inbox", [summary("m2")])
      store.putAttachmentText({ ...text("m2"), attachment: { ...text("m2").attachment, id: "a2" } })
      expect(store.getAttachmentText("m2", "a2")).toBeDefined()
      store.upsertMessages("wk:inbox", [summary("m2", 2)])
      expect(store.getAttachmentText("m2", "a2")).toBeUndefined()

      store.upsertMessages("wk:inbox", [summary("m3")])
      store.putAttachmentText({ ...text("m3"), attachment: { ...text("m3").attachment, id: "a3" } })
      store.updateMetadata("m3", { hasAttachments: true, attachmentCount: 3 })
      expect(store.getAttachmentText("m3", "a3")).toBeUndefined()

      store.upsertMessages("wk:inbox", [summary("m4")])
      store.putAttachmentText({ ...text("m4"), attachment: { ...text("m4").attachment, id: "a4" } })
      store.upsertMessages("wk:inbox", [{ ...summary("m4"), hasAttachments: false, attachmentCount: 0 }])
      expect(store.getAttachmentText("m4", "a4")).toBeUndefined()

      // Flag-only change: the count is unknown on both sides, so only hasAttachments differs.
      store.upsertMessages("wk:inbox", [{ ...summary("m5"), attachmentCount: undefined }])
      store.putAttachmentText({ ...text("m5"), attachment: { ...text("m5").attachment, id: "a5" } })
      expect(store.getAttachmentText("m5", "a5")).toBeDefined()
      store.upsertMessages("wk:inbox", [{ ...summary("m5"), hasAttachments: false, attachmentCount: undefined }])
      expect(store.getAttachmentText("m5", "a5")).toBeUndefined()
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("prunes attachment text with the message", () => {
    const cfg = { ...config(), retentionDays: 1 }
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      store.upsertMessages("wk:inbox", [{ ...summary("old"), received: "2020-01-01T00:00:00Z" }])
      store.putAttachmentText(text("old"))
      store.prune(100, 1)
      expect(store.getAttachmentText("old", "a1")).toBeUndefined()
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("metadata storage never writes or exposes attachment cache", () => {
    const cfg = config("metadata")
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      store.upsertMessages("wk:inbox", [summary("m1")])
      expect(store.putAttachmentText(text("m1"))).toBe(false)
      expect(store.getAttachmentText("m1", "a1")).toBeUndefined()
      expect(store.search("needle", 10)).toHaveLength(0)
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("clears attachment cache on a storage downgrade and does not revive it", () => {
    const cfg = config("full")
    let store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      store.upsertMessages("wk:inbox", [summary("m1")])
      store.putAttachmentText(text("m1"))
      store.close()

      store = openStore({ ...cfg, storage: "metadata" })
      expect(store?.getAttachmentText("m1", "a1")).toBeUndefined()
      store?.close()

      store = openStore(cfg)
      expect(store?.getAttachmentText("m1", "a1")).toBeUndefined()
      store?.close()
    } finally {
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("rolls back the attachment text when the FTS write fails", () => {
    const cfg = config("full")
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    try {
      store.upsertMessages("wk:inbox", [summary("m9")])
      const side = new Database(path.join(cfg.dataDir, "mail.db"))
      side.run("drop table attachment_fts")
      side.close()

      expect(() =>
        store.putAttachmentText({ ...text("m9"), attachment: { ...text("m9").attachment, id: "a9" } }),
      ).toThrow()
      expect(store.getAttachmentText("m9", "a9")).toBeUndefined()
      const check = new Database(path.join(cfg.dataDir, "mail.db"))
      const row = check.query("select count(*) as n from attachment_text where message_id = 'm9'").get() as {
        n: number
      }
      check.close()
      expect(row.n).toBe(0)
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("backend reads by attachmentId from cache without touching EWS and applies maxChars", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    const backend = new EwsBackend(cfg, store)
    try {
      store.upsertMessages("wk:inbox", [summary("m1")])
      store.putAttachmentText({ ...text("m1"), text: "x".repeat(2_000), truncated: false })
      ;(backend as unknown as { service: unknown }).service = new Proxy(
        {},
        {
          get() {
            throw new Error("EWS must not be touched on a cache hit")
          },
        },
      )
      const result = await backend.readAttachment({ id: "m1", attachmentId: "a1", maxChars: 1_000 })
      expect(result.text).toHaveLength(1_000)
      expect(result.truncated).toBe(true)
      expect(result.attachment.name).toBe("invoice.pdf")
      await expect(backend.readAttachment({ id: "m1", attachmentId: "a1", index: 0 })).rejects.toThrow(
        /either attachmentId or index/,
      )
    } finally {
      backend.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })
})

import { Database } from "bun:sqlite"
import { describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { strToU8, zipSync } from "fflate"
import { attachmentInfo, attachmentSavePath, EwsBackend } from "../src/backend"
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

  test("saves a file attachment under dataDir with a sanitized name", async () => {
    const cfg = config("full")
    const backend = new EwsBackend(cfg)
    try {
      const fake = {
        Id: "a1",
        FileName: "../evil name.xlsx",
        ContentType: "application/vnd.ms-excel",
        Size: 5,
        Load: async function (this: { Base64Content?: string }) {
          this.Base64Content = Buffer.from("hello").toString("base64")
        },
      }
      ;(
        backend as unknown as { loadAttachmentCollection: (id: string) => Promise<unknown[]> }
      ).loadAttachmentCollection = async () => [fake]
      const saved = await backend.saveAttachment({ id: "m1", index: 0 })
      expect(saved.path.startsWith(cfg.dataDir)).toBe(true)
      expect(saved.name).toBe(path.basename(saved.path))
      expect(saved.path.endsWith("evil name.xlsx")).toBe(true)
      expect(saved.path).not.toContain("..")
      expect(saved.size).toBe(5)
      expect(saved.sha256).toHaveLength(64)
      expect(readFileSync(saved.path, "utf8")).toBe("hello")

      const longFake = {
        Id: "a2",
        FileName: `${"y".repeat(300)}.docx`,
        ContentType: "application/vnd.ms-excel",
        Size: 5,
        Load: async function (this: { Base64Content?: string }) {
          this.Base64Content = Buffer.from("hello").toString("base64")
        },
      }
      ;(
        backend as unknown as { loadAttachmentCollection: (id: string) => Promise<unknown[]> }
      ).loadAttachmentCollection = async () => [longFake]
      const savedLong = await backend.saveAttachment({ id: "m2", index: 0 })
      expect(savedLong.name).toBe(path.basename(savedLong.path))
      expect(savedLong.name.length).toBeLessThanOrEqual(120)
    } finally {
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("keeps the extension and bounds the saved file name", () => {
    const base = path.join(process.cwd(), "tmp-save")
    const long = attachmentSavePath(base, "m1", "a1", `${"x".repeat(300)}.docx`)
    expect(long.endsWith(".docx")).toBe(true)
    expect(long.length).toBeLessThan(base.length + 200)
    for (const name of ["../../../../evil.txt", String.raw`C:\Windows\evil.txt`, "..", ".", "CON", "NUL", "nul.pdf"]) {
      const target = attachmentSavePath(base, "m1", "a1", name)
      expect(path.relative(base, target).startsWith("..")).toBe(false)
      expect(target.startsWith(`${base}${path.sep}`)).toBe(true)
    }
    expect(path.basename(attachmentSavePath(base, "m1", "a1", "NUL"))).toBe("_NUL")
    expect(path.basename(attachmentSavePath(base, "m1", "a1", "nul.pdf"))).toBe("_nul.pdf")
  })

  test("a sheet read does not write the attachment cache", async () => {
    const cfg = config("full")
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    const backend = new EwsBackend(cfg, store)
    try {
      store.upsertMessages("wk:inbox", [summary("m1")])
      const workbook = zipSync({
        "xl/workbook.xml": strToU8('<workbook><sheets><sheet name="Data"/></sheets></workbook>'),
        "xl/worksheets/sheet1.xml": strToU8(
          "<worksheet><sheetData><row><c><v>42</v></c></row></sheetData></worksheet>",
        ),
      })
      const fake = {
        Id: "a1",
        FileName: "book.xlsx",
        ContentType: "application/vnd.ms-excel",
        Size: workbook.length,
        Load: async function (this: { Base64Content?: string }) {
          this.Base64Content = Buffer.from(workbook).toString("base64")
        },
      }
      ;(
        backend as unknown as { loadAttachmentCollection: (id: string) => Promise<unknown[]> }
      ).loadAttachmentCollection = async () => [fake]
      const result = await backend.readAttachment({ id: "m1", index: 0, sheet: "Data" })
      expect(result.kind).toBe("excel")
      expect(result.text).toContain("42")
      expect(store.getAttachmentText("m1", "a1")).toBeUndefined()
    } finally {
      store.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("rejects a sheet selector for non-Excel attachments", async () => {
    const cfg = config("full")
    const backend = new EwsBackend(cfg)
    try {
      const fake = {
        Id: "a1",
        FileName: "note.txt",
        ContentType: "text/plain",
        Size: 5,
        Load: async function (this: { Base64Content?: string }) {
          this.Base64Content = Buffer.from("hello").toString("base64")
        },
      }
      ;(
        backend as unknown as { loadAttachmentCollection: (id: string) => Promise<unknown[]> }
      ).loadAttachmentCollection = async () => [fake]
      await expect(backend.readAttachment({ id: "m1", index: 0, sheet: "Data" })).rejects.toThrow(
        /sheet is only supported for Excel attachments/,
      )
    } finally {
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
      // A sheet selector must not be served from the whole-attachment cache.
      await expect(
        backend.readAttachment({ id: "m1", attachmentId: "a1", sheet: "Data", maxChars: 1_000 }),
      ).rejects.toThrow(/EWS must not be touched/)
      // The index path re-checks the cache after resolving the attachment; a sheet
      // read must skip that lookup too (otherwise it returns the whole-file text).
      ;(
        backend as unknown as { loadAttachmentCollection: (id: string) => Promise<unknown[]> }
      ).loadAttachmentCollection = async () => [
        { Id: "a1", FileName: "book.xlsx", ContentType: "application/vnd.ms-excel", Size: 100, IsInline: false },
      ]
      await expect(backend.readAttachment({ id: "m1", index: 0, sheet: "Data" })).rejects.toThrow()
      expect(store.getAttachmentText("m1", "a1")?.text).toBe("x".repeat(2_000))
    } finally {
      backend.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })
})

import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  AffectedTaskOccurrence,
  DeleteMode,
  FolderId,
  SendCancellationsMode,
  ServiceResponseException,
  ServiceResult,
  WellKnownFolderName,
} from "ews-javascript-api"
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
  storage: "metadata",
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-delete-")),
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

const successFor = (ids: unknown[]) => ({
  OverallResult: ServiceResult.Success,
  Responses: ids.map(() => ({ Result: ServiceResult.Success })),
})

describe("delete tools", () => {
  test("soft delete tombstones the old row (Exchange assigns a new id on move)", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    let mode: DeleteMode | undefined
    let cancellations: SendCancellationsMode | undefined
    let occurrences: AffectedTaskOccurrence | undefined
    let ids: unknown[] = []
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async (
        requested: unknown[],
        deleteMode: DeleteMode,
        sendCancellationsMode: SendCancellationsMode,
        affectedTaskOccurrence: AffectedTaskOccurrence,
      ) => {
        ids = requested
        mode = deleteMode
        cancellations = sendCancellationsMode
        occurrences = affectedTaskOccurrence
        return successFor(requested)
      },
    }

    await expect(backend.deleteMessages({ ids: ["1"] })).resolves.toEqual({ deleted: 1, mode: "soft" })
    expect(mode).toBe(DeleteMode.MoveToDeletedItems)
    expect(cancellations).toBe(SendCancellationsMode.SendToNone)
    expect(occurrences).toBe(AffectedTaskOccurrence.AllOccurrences)
    expect(ids).toHaveLength(1)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 })).toEqual([])
    // The old ItemId is invalid after MoveToDeletedItems: do not keep a stale row in
    // `wk:deleted`. The next sync adds the message under its new id instead.
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 })).toEqual([])
    store.upsertMessages("wk:deleted", [message("NEW")])
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 }).map((item) => item.id)).toEqual(["NEW"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("hard delete tombstones the row", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    let mode: DeleteMode | undefined
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async (requested: unknown[], deleteMode: DeleteMode) => {
        mode = deleteMode
        return successFor(requested)
      },
    }

    await expect(backend.deleteMessages({ ids: ["1"], hard: true })).resolves.toEqual({
      deleted: 1,
      mode: "hard",
    })
    expect(mode).toBe(DeleteMode.HardDelete)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 })).toEqual([])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("deduplicates ids before the EWS request", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    let ids: unknown[] = []
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async (requested: unknown[]) => {
        ids = requested
        return successFor(requested)
      },
    }

    await expect(backend.deleteMessages({ ids: ["1", "1"], hard: true })).resolves.toEqual({
      deleted: 1,
      mode: "hard",
    })
    expect(ids).toHaveLength(1)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("emptyDeleted uses EmptyFolder with HardDelete and clears the local folder", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:deleted", [message("1")])
    const backend = new EwsBackend(cfg, store)
    let called: { folder: unknown; mode: DeleteMode; subfolders: boolean } | undefined
    ;(backend as unknown as { service: unknown }).service = {
      EmptyFolder: async (folder: unknown, mode: DeleteMode, subfolders: boolean) => {
        called = { folder, mode, subfolders }
        return { OverallResult: ServiceResult.Success, Responses: [{ Result: ServiceResult.Success }] }
      },
    }

    await expect(backend.emptyDeleted()).resolves.toEqual({ emptied: true })
    if (!called) throw new Error("EmptyFolder was not called")
    expect(called.folder).toBeInstanceOf(FolderId)
    expect((called.folder as FolderId).FolderName).toBe(WellKnownFolderName.DeletedItems)
    expect(called.mode).toBe(DeleteMode.HardDelete)
    expect(called.subfolders).toBe(false)
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 })).toEqual([])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("EWS errors are surfaced and the local index is left unchanged", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async () => ({
        OverallResult: ServiceResult.Error,
        Responses: [{ Result: ServiceResult.Error, ErrorMessage: "boom" }],
      }),
    }

    await expect(backend.deleteMessages({ ids: ["1"], hard: true })).rejects.toThrow(/not confirmed.*boom/)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("Warning and missing responses are not treated as confirmation", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    const service = backend as unknown as { service: unknown }

    service.service = {
      DeleteItems: async () => ({
        OverallResult: ServiceResult.Warning,
        Responses: [{ Result: ServiceResult.Warning, ErrorMessage: "batch stopped" }],
      }),
    }
    await expect(backend.deleteMessages({ ids: ["1"], hard: true })).rejects.toThrow(/not confirmed.*batch stopped/)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    service.service = {
      DeleteItems: async () => ({ OverallResult: ServiceResult.Success, Responses: [] }),
    }
    await expect(backend.deleteMessages({ ids: ["1"], hard: true })).rejects.toThrow(/no per-item response/)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a batch-level EWS failure is reported as an unknown outcome", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async () => {
        throw new TypeError("deserialize")
      },
    }

    await expect(backend.deleteMessages({ ids: ["1"], hard: true })).rejects.toThrow(
      /server may have applied it.*deserialize/,
    )
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("an explicit EWS rejection is not reported as an unknown outcome", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async () => {
        throw new ServiceResponseException({ ErrorMessage: "denied", ErrorCode: 0 } as never)
      },
    }

    await expect(backend.deleteMessages({ ids: ["1"], hard: true })).rejects.toThrow(/^EWS delete failed: denied$/)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a partial EWS failure still applies the deletions that succeeded", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:inbox", [message("1"), message("2")])
    const backend = new EwsBackend(cfg, store)
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async () => ({
        OverallResult: ServiceResult.Error,
        Responses: [{ Result: ServiceResult.Success }, { Result: ServiceResult.Error, ErrorMessage: "boom" }],
      }),
    }

    await expect(backend.deleteMessages({ ids: ["1", "2"] })).rejects.toThrow(/1 of 2 confirmed, 1 not confirmed.*boom/)
    expect(store.listMessages({ folderId: "wk:inbox", limit: 10 }).map((item) => item.id)).toEqual(["2"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("emptyDeleted requires a Success response and leaves the index intact otherwise", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    store.upsertMessages("wk:deleted", [message("1")])
    const backend = new EwsBackend(cfg, store)
    const service = backend as unknown as { service: unknown }

    service.service = {
      EmptyFolder: async () => ({
        OverallResult: ServiceResult.Warning,
        Responses: [{ Result: ServiceResult.Warning, ErrorMessage: "partial" }],
      }),
    }
    await expect(backend.emptyDeleted()).rejects.toThrow(/not confirmed.*partial/)
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    service.service = {
      EmptyFolder: async () => {
        throw new Error("denied")
      },
    }
    await expect(backend.emptyDeleted()).rejects.toThrow(
      /EWS empty folder failed; the server may have applied it.*denied/,
    )
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    service.service = {
      EmptyFolder: async () => {
        throw new ServiceResponseException({ ErrorMessage: "denied", ErrorCode: 0 } as never)
      },
    }
    await expect(backend.emptyDeleted()).rejects.toThrow(/^EWS empty folder failed: denied$/)
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    service.service = {
      EmptyFolder: async () => ({ OverallResult: ServiceResult.Success, Responses: [] }),
    }
    await expect(backend.emptyDeleted()).rejects.toThrow(/not confirmed \(no response\)/)
    expect(store.listMessages({ folderId: "wk:deleted", limit: 10 }).map((item) => item.id)).toEqual(["1"])

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("rejects an over-long item id before EWS", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    const backend = new EwsBackend(cfg, store)
    let called = false
    ;(backend as unknown as { service: unknown }).service = {
      DeleteItems: async () => {
        called = true
        return successFor([])
      },
    }

    await expect(backend.deleteMessages({ ids: ["a".repeat(2049)] })).rejects.toThrow(/too long/)
    expect(called).toBe(false)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

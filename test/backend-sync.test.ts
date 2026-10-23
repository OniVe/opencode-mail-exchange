import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ChangeType } from "ews-javascript-api"
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
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-sync-")),
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
  to: [],
  received: "2026-10-23T09:41:32Z",
  isRead: false,
  hasAttachments: false,
  preview: "preview",
})

const fakeService = (backend: EwsBackend, service: unknown): void => {
  ;(backend as unknown as { service: unknown }).service = service
}

let stateCounter = 0
const round = (changes: unknown[], options: { more?: boolean } = {}) => ({
  GetEnumerator: () => changes,
  SyncState: `state-${++stateCounter}`,
  MoreChangesAvailable: options.more === true,
})

describe("syncFolder", () => {
  test("applies ReadFlagChange via markRead", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.upsertMessages("wk:inbox", [message("1")])
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      SyncFolderItems: async () =>
        round([{ ChangeType: ChangeType.ReadFlagChange, ItemId: { UniqueId: "1" }, IsRead: true }]),
    })

    const result = await backend.syncFolder("inbox")
    expect(result).toEqual({ synced: 0, complete: true })
    expect(store.getMessage("1")?.isRead).toBe(true)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("resets an invalid SyncState token and retries once from scratch", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.setSyncState("wk:inbox", "broken-token")
    let calls = 0
    const tokens: Array<string | null> = []
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      SyncFolderItems: async (
        _folder: unknown,
        _props: unknown,
        _ids: unknown,
        _max: unknown,
        _scope: unknown,
        token: string | null,
      ) => {
        calls++
        tokens.push(token)
        if (calls === 1) throw Object.assign(new Error("Invalid synchronization state"), { ErrorCode: 237 })
        return round([])
      },
    })

    const result = await backend.syncFolder("inbox")
    expect(result).toEqual({ synced: 0, complete: true })
    expect(calls).toBe(2)
    expect(tokens[0]).toBe("broken-token")
    expect(tokens[1]).toBeNull()
    expect(store.getSyncState("wk:inbox")?.token).not.toBe("broken-token")

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("recognizes a localized corrupt synchronization-state message without ErrorCode", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    let calls = 0
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      SyncFolderItems: async () => {
        calls++
        if (calls === 1) throw new Error("Состояние синхронизации повреждено и не может быть использовано.")
        return round([])
      },
    })

    const result = await backend.syncFolder("inbox")
    expect(result.complete).toBe(true)
    expect(calls).toBe(2)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("does not reset the token on an unrelated 'поврежден' error", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    store.setSyncState("wk:inbox", "good-token")
    let calls = 0
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      SyncFolderItems: async () => {
        calls++
        throw new Error("Вложение повреждено и не может быть прочитано")
      },
    })

    await expect(backend.syncFolder("inbox")).rejects.toThrow(/повреждено/)
    expect(calls).toBe(1)
    expect(store.getSyncState("wk:inbox")?.token).toBe("good-token")

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("reports complete=false when the 50-round budget runs out with more changes", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    const backend = new EwsBackend(cfg, store)
    let calls = 0
    fakeService(backend, {
      SyncFolderItems: async () => {
        calls++
        return round([], { more: true })
      },
    })

    const result = await backend.syncFolder("inbox")
    expect(calls).toBe(50)
    expect(result.complete).toBe(false)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("shares one run between concurrent callers (single-flight)", async () => {
    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")

    let calls = 0
    const backend = new EwsBackend(cfg, store)
    fakeService(backend, {
      SyncFolderItems: async () => {
        calls++
        await new Promise((resolve) => setTimeout(resolve, 20))
        return round([])
      },
    })

    const [a, b] = await Promise.all([backend.syncFolder("inbox"), backend.syncFolder("inbox")])
    expect(calls).toBe(1)
    expect(a).toEqual(b)

    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("skips non-indexed folders and storage=off explicitly", async () => {
    const offCfg = config()
    const offBackend = new EwsBackend(offCfg)
    expect(await offBackend.syncFolder("inbox")).toEqual({ synced: 0, complete: true, skipped: "storage-off" })
    offBackend.close()
    rmSync(offCfg.dataDir, { recursive: true, force: true })

    const cfg = config()
    const store = openStore(cfg)
    if (!store) throw new Error("store expected")
    const backend = new EwsBackend(cfg, store)
    expect(await backend.syncFolder("calendar")).toEqual({ synced: 0, complete: true, skipped: "not-indexed" })
    backend.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

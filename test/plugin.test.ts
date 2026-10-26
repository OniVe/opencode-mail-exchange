import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { Plugin } from "@opencode/plugin"
import { ConfigurationApi } from "ews-javascript-api"
import plugin from "../src/index"
import { disposeXhrRouter, installXhrRouter } from "../src/xhr-router"

describe("plugin setup", () => {
  test("registers tools with valid options and returns cleanup", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "mail-setup-"))
    const tools: string[] = []
    let disposed = 0
    const ctx = {
      options: {
        ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
        username: "CORP\\bot",
        password: "secret",
        storage: "off",
        dataDir,
      },
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: { name: string }) => tools.push(tool.name),
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({
            dispose: async () => {
              disposed++
            },
          })
        },
      },
    } as unknown as Plugin.Context

    const cleanup = await plugin.setup(ctx)
    expect(tools).toHaveLength(12)
    expect(tools).toContain("send")
    expect(typeof cleanup).toBe("function")
    if (typeof cleanup === "function") await cleanup()
    // Cleanup must release the tool registration, not only the SQLite handles.
    expect(disposed).toBe(1)

    rmSync(dataDir, { recursive: true, force: true })
  })

  test("survives missing configuration", async () => {
    const ctx = {
      options: {},
      tool: { transform: async () => ({ dispose: async () => {} }) },
    } as unknown as Plugin.Context
    const cleanup = await plugin.setup(ctx)
    expect(cleanup).toBeUndefined()
  })

  test("cleanup releases the router even when tool disposal fails", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "mail-dispose-"))
    const original = ConfigurationApi.ConfigureXHR
    let configured = 0
    ConfigurationApi.ConfigureXHR = ((...args: unknown[]) => {
      configured++
      return original.apply(ConfigurationApi, args as never)
    }) as typeof ConfigurationApi.ConfigureXHR

    try {
      disposeXhrRouter()
      const ctx = {
        options: {
          ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
          username: "CORP\\bot",
          password: "secret",
          storage: "off",
          dataDir,
        },
        tool: {
          transform: async () => ({
            dispose: async () => {
              throw new Error("tool disposal failed")
            },
          }),
        },
      } as unknown as Plugin.Context

      const cleanup = await plugin.setup(ctx)
      expect(configured).toBe(1)
      if (typeof cleanup !== "function") throw new Error("cleanup expected")
      await expect(cleanup()).rejects.toThrow("tool disposal failed")

      // service.close() ran despite the failed dispose: the router can be installed again.
      installXhrRouter()
      expect(configured).toBe(2)
    } finally {
      ConfigurationApi.ConfigureXHR = original
      disposeXhrRouter()
      rmSync(dataDir, { recursive: true, force: true })
    }
  })
})

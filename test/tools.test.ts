import { describe, expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin"
import plugin from "../src/index"
import type { MailService } from "../src/service"
import { registerTools } from "../src/tools"
import type { MailBackend } from "../src/types"

let lastDelete: { ids: string[]; hard?: boolean } | undefined

const backend: MailBackend = {
  listFolders: async () => [{ id: "1", name: "Inbox", unread: 2, total: 3 }],
  syncFolder: async () => ({ synced: 1, complete: true }),
  listMessages: async () => [
    {
      id: "m1",
      subject: "Hello",
      from: "a@example.com",
      to: ["b@example.com"],
      received: "2026-10-23T00:00:00Z",
      isRead: false,
      hasAttachments: false,
      preview: "hello",
    },
  ],
  searchMessages: async () => [],
  getMessage: async () => ({
    id: "m1",
    subject: "Hello",
    from: "a@example.com",
    to: ["b@example.com"],
    cc: [],
    received: "2026-10-23T00:00:00Z",
    isRead: false,
    hasAttachments: false,
    preview: "hello",
    body: "full body",
    bodyType: "text",
    truncated: false,
    bodyCached: true,
  }),
  send: async () => ({ sent: true }),
  saveDraft: async () => ({ id: "draft" }),
  deleteMessages: async (input) => {
    lastDelete = { ids: input.ids, hard: input.hard }
    return { deleted: input.ids.length, mode: input.hard ? "hard" : "soft" }
  },
  emptyDeleted: async () => ({ emptied: true }),
  listCalendar: async () => [],
  listContacts: async () => [],
  close: () => {},
}

const service = {
  accounts: [
    {
      id: "default",
      ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
      selfAddress: "bot@example.com",
      storage: "off",
      allowSend: true,
    },
  ],
  defaultAccount: "default",
  ids: () => ["default"],
  config: () => ({ allowSend: true, codemode: false }),
  run: async (_account: string | undefined, action: (backend: MailBackend) => Promise<unknown>) => action(backend),
  close: () => {},
} as unknown as MailService

describe("plugin entry", () => {
  test("exports a V2 plugin definition", () => {
    expect(plugin.id).toBe("mail.exchange")
    expect(typeof plugin.setup).toBe("function")
  })
})

describe("registerTools", () => {
  test("registers account + mail tools with direct-call options", async () => {
    type TestTool = {
      name: string
      options?: Record<string, unknown>
      execute: (input?: unknown) => Promise<{ content?: string }>
    }
    const registered: TestTool[] = []
    const ctx = {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: TestTool) => {
              registered.push(tool)
            },
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as unknown as Plugin.Context

    await registerTools(ctx, service)

    expect(registered.map((tool) => tool.name)).toEqual([
      "accounts",
      "folders",
      "list",
      "search",
      "get",
      "delete",
      "empty_deleted",
      "sync",
      "draft",
      "send",
      "calendar",
      "contacts",
    ])
    for (const tool of registered) {
      expect(tool.options?.codemode).toBe(false)
      expect(tool.options?.namespace).toBe("mail")
    }

    const list = registered.find((tool) => tool.name === "list")
    const result = await list?.execute({ limit: 5 })
    expect(result?.content).toContain("Hello")

    // The runtime guard rejects over-long and non-string queries before the backend.
    const search = registered.find((tool) => tool.name === "search")
    expect((await search?.execute({ query: "a".repeat(512) }))?.content).toContain("[]")
    expect((await search?.execute({ query: "a".repeat(513) }))?.content).toContain("query is too long")
    expect((await search?.execute({ query: 123 }))?.content).toContain("query must be a string")

    const remove = registered.find((tool) => tool.name === "delete")
    expect((await remove?.execute({ ids: ["1"] }))?.content).toContain('"deleted": 1')
    expect(lastDelete).toEqual({ ids: ["1"], hard: undefined })
    const removeHard = await remove?.execute({ ids: ["1"], hard: true })
    expect(lastDelete).toEqual({ ids: ["1"], hard: true })
    expect(removeHard?.content).toContain('"mode": "hard"')
    expect((await remove?.execute({ ids: [] }))?.content).toContain("ids must be an array of 1..100 item ids")
    expect(
      (await remove?.execute({ ids: Array.from({ length: 101 }, (_, index) => String(index)) }))?.content,
    ).toContain("ids must be an array of 1..100 item ids")
    const empty = registered.find((tool) => tool.name === "empty_deleted")
    expect((await empty?.execute({ confirm: false }))?.content).toContain("confirm: true is required")
    expect((await empty?.execute({ confirm: true }))?.content).toContain('"emptied": true')
  })

  test("codemode=true switches every tool to Code Mode", async () => {
    const coded = {
      ...(service as unknown as Record<string, unknown>),
      config: () => ({ allowSend: true, codemode: true }),
    } as unknown as MailService
    const registered: Array<{ name: string; options?: Record<string, unknown> }> = []
    const ctx = {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: { name: string; options?: Record<string, unknown> }) => registered.push(tool),
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as unknown as Plugin.Context

    await registerTools(ctx, coded)
    expect(registered).toHaveLength(12)
    for (const tool of registered) expect(tool.options?.codemode).toBe(true)
  })

  test("passes context.signal to MailService.run", async () => {
    let seen: AbortSignal | undefined
    const coded = {
      ...(service as unknown as Record<string, unknown>),
      run: async (
        _account: string | undefined,
        action: (backend: MailBackend) => Promise<unknown>,
        signal?: AbortSignal,
      ) => {
        seen = signal
        return action(backend)
      },
    } as unknown as MailService
    const registered: Array<{ name: string; execute: (input?: unknown, context?: unknown) => Promise<unknown> }> = []
    const ctx = {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: { name: string; execute: (input?: unknown, context?: unknown) => Promise<unknown> }) =>
              registered.push(tool),
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as unknown as Plugin.Context

    await registerTools(ctx, coded)
    const controller = new AbortController()
    await registered.find((tool) => tool.name === "folders")?.execute({}, { signal: controller.signal })
    expect(seen).toBe(controller.signal)
  })

  test("maps permissions per tool", async () => {
    const registered: Array<{ name: string; options?: Record<string, unknown> }> = []
    const ctx = {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: { name: string; options?: Record<string, unknown> }) => registered.push(tool),
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as unknown as Plugin.Context

    await registerTools(ctx, service)
    const expected: Record<string, string> = {
      accounts: "mail.read",
      folders: "mail.read",
      list: "mail.read",
      search: "mail.read",
      get: "mail.read",
      delete: "mail.delete",
      empty_deleted: "mail.delete",
      sync: "mail.read",
      draft: "mail.draft",
      send: "mail.send",
      calendar: "mail.read",
      contacts: "mail.read",
    }
    for (const [name, permission] of Object.entries(expected)) {
      expect(registered.find((tool) => tool.name === name)?.options?.permission).toBe(permission)
    }
  })

  test("registers inline attachment fields in the draft/send schema", async () => {
    type TestTool = { name: string; input: { properties?: Record<string, { properties?: Record<string, unknown> }> } }
    const registered: TestTool[] = []
    const ctx = {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: TestTool) => registered.push(tool),
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as unknown as Plugin.Context

    await registerTools(ctx, service)
    const draft = registered.find((tool) => tool.name === "draft")
    const attachment = draft?.input.properties?.attachments as {
      items?: { properties?: Record<string, unknown> }
    }
    expect(Object.keys(attachment.items?.properties ?? {})).toContain("contentId")
    expect(Object.keys(attachment.items?.properties ?? {})).toContain("isInline")
  })
})

describe("tool error surfacing", () => {
  const makeService = (error: unknown) =>
    ({
      accounts: [
        { id: "default", ewsUrl: "https://x", selfAddress: "bot@example.com", storage: "off", allowSend: false },
      ],
      defaultAccount: "default",
      ids: () => ["default"],
      config: () => ({ allowSend: false, codemode: false }),
      run: async () => {
        throw error
      },
      close: () => {},
    }) as unknown as MailService

  const capture = async (error: unknown, svc: MailService = makeService(error)) => {
    const registered: Array<{ name: string; execute: (input?: unknown) => Promise<{ content?: string }> }> = []
    const ctx = {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: { name: string; execute: (input?: unknown) => Promise<{ content?: string }> }) =>
              registered.push(tool),
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as unknown as Plugin.Context
    await registerTools(ctx, svc)
    return registered
  }

  test("does not leak a stack trace and keeps EWS code", async () => {
    const error = Object.assign(new Error("inner"), {
      Message: "Запрос не прошел проверку на соответствие схеме.",
      ErrorCode: 5,
      stack: "STACK-TRACE-MARKER",
    })
    const tools = await capture(error)
    const result = await tools.find((tool) => tool.name === "folders")?.execute({})
    expect(result?.content).toContain("Запрос не прошел проверку")
    expect(result?.content).toContain("ErrorCode 5")
    expect(result?.content).not.toContain("STACK-TRACE-MARKER")
  })

  test("maps HTTP 413 to a readable attachment limit message", async () => {
    const tools = await capture(Object.assign(new Error("Request failed"), { HttpStatusCode: 413 }))
    const result = await tools.find((tool) => tool.name === "folders")?.execute({})
    expect(result?.content).toContain("attachment too large")

    // EWS puts the HTTP status on `response` for non-SOAP (non-500) failures.
    const nested = await capture({ message: "", response: { HttpStatusCode: 413 } })
    const nestedResult = await nested.find((tool) => tool.name === "folders")?.execute({})
    expect(nestedResult?.content).toContain("attachment too large")
  })

  test("mail_send returns {sent: true} (no item id from EWS Send)", async () => {
    // The module-level stub backend answers send() with {sent: true}.
    const tools = await capture(new Error("unused"), service)
    const result = await tools
      .find((tool) => tool.name === "send")
      ?.execute({ to: ["bot@example.com"], subject: "s", body: "b" })
    expect(JSON.parse(result?.content ?? "null")).toEqual({ sent: true })
  })

  test("allowSend=false is an ERROR result, not a thrown tool", async () => {
    const tools = await capture(new Error("unused"))
    const result = await tools
      .find((tool) => tool.name === "send")
      ?.execute({
        to: ["bot@example.com"],
        subject: "s",
        body: "b",
      })
    expect(result?.content).toContain("allowSend=false")
  })
})

import { AsyncLocalStorage } from "node:async_hooks"
import type { MailService } from "./service"
import type { MailBackend, OutgoingMessage } from "./types"

const json = (value: unknown): string => JSON.stringify(value, null, 2)

const textOf = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

/**
 * EWS errors arrive as `ServiceResponseException` (`Message`/`ErrorCode`, HTTP status on
 * `response`), plain `Error`, or anything else. Surface message + code only — never a stack trace.
 */
const describeError = (error: unknown): string => {
  const typed = (error ?? {}) as {
    message?: unknown
    Message?: unknown
    HttpStatusCode?: unknown
    status?: unknown
    ErrorCode?: unknown
    code?: unknown
    response?: { HttpStatusCode?: unknown; status?: unknown; ErrorCode?: unknown }
  }
  const status = [typed.HttpStatusCode, typed.status, typed.response?.HttpStatusCode, typed.response?.status].find(
    (candidate): candidate is number => typeof candidate === "number",
  )
  if (status === 413)
    return "attachment too large (HTTP 413: request exceeded the EWS/IIS limit, ~40 MB per attachment)"
  const rawCode = typed.ErrorCode ?? typed.response?.ErrorCode
  const code = textOf(typed.code) ?? (typeof rawCode === "number" ? `ErrorCode ${rawCode}` : textOf(rawCode))
  const message =
    textOf(typed.Message) ?? textOf(typed.message) ?? (error instanceof Error ? error.message : String(error))
  return code ? `${message} (${code})` : message
}

const failure = (error: unknown): { content: string; metadata: { error: true } } => ({
  content: `ERROR: ${describeError(error)}`,
  metadata: { error: true },
})

/** Tool schemas advertise ranges, but models send anything: clamp server-side too. */
const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  if (!Number.isFinite(n)) return fallback
  return Math.min(Math.max(Math.trunc(n), min), max)
}

const accountField = {
  type: "string",
  description: "Account id (see mail_accounts); default is the first configured account",
} as const

const attachmentSchema = {
  type: "object",
  properties: {
    name: { type: "string", description: "File name with extension" },
    contentBase64: { type: "string", description: "Base64-encoded file content (max ~40 MB decoded)" },
    contentId: {
      type: "string",
      description: "Content-ID for inline images, referenced as cid:<contentId> in an HTML body",
    },
    isInline: { type: "boolean", description: "Mark as inline (referenced by cid:, hidden from the attachment list)" },
  },
  required: ["name", "contentBase64"],
  additionalProperties: false,
} as const

const outgoingSchema = {
  type: "object",
  properties: {
    account: accountField,
    to: { type: "array", items: { type: "string" }, minItems: 1, description: "Recipient addresses" },
    cc: { type: "array", items: { type: "string" }, description: "CC addresses" },
    subject: { type: "string", maxLength: 512 },
    body: { type: "string", maxLength: 1_000_000 },
    bodyType: { type: "string", enum: ["text", "html"], description: "Body format, default text" },
    attachments: { type: "array", items: attachmentSchema, maxItems: 10 },
  },
  required: ["to", "subject", "body"],
  additionalProperties: false,
} as const

type AccountInput = { account?: string }

/** Set per tool call so `run` can hand `context.signal` to the EWS layer. */
const currentSignal = new AsyncLocalStorage<AbortSignal | undefined>()

export async function registerTools(
  ctx: import("@opencode/plugin").Plugin.Context,
  service: MailService,
): Promise<Awaited<ReturnType<import("@opencode/plugin").Plugin.Context["tool"]["transform"]>>> {
  const run = <T>(input: AccountInput, action: (backend: MailBackend) => Promise<T>) =>
    service.run(input.account, action, currentSignal.getStore())
  // Global tool visibility: false = direct calls, true = only via Code Mode `execute`.
  const codemode = service.config().codemode

  const registration = await ctx.tool.transform((tools) => {
    tools.namespace({ name: "mail", description: "Exchange mailbox, calendar and contacts (EWS)" })

    // Wrap every executor so `run` can see the tool-call AbortSignal.
    type ToolLike = {
      [key: string]: unknown
      execute: (input: unknown, context?: { signal?: AbortSignal }) => Promise<unknown>
    }
    const add = (tool: ToolLike): void => {
      tools.add({
        ...tool,
        execute: (input: unknown, context?: { signal?: AbortSignal }) =>
          currentSignal.run(context?.signal, () => tool.execute(input, context)),
      } as never)
    }

    add({
      name: "accounts",
      description: "List configured mailbox accounts. Use the id in the `account` argument of other mail tools.",
      input: { type: "object", properties: {}, additionalProperties: false },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async () => ({
        content: json(
          service.accounts.map((account) => ({
            id: account.id,
            address: account.selfAddress,
            ewsUrl: account.ewsUrl,
            storage: account.storage,
          })),
        ),
      }),
    })

    add({
      name: "folders",
      description: "List mailbox folders with unread and total counts.",
      input: { type: "object", properties: { account: accountField }, additionalProperties: false },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        try {
          return { content: json(await run(input as AccountInput, (backend) => backend.listFolders())) }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "list",
      description:
        "List recent messages in a folder (metadata only, newest first). Folder accepts inbox/sent/drafts/deleted or a display name; default inbox.",
      input: {
        type: "object",
        properties: {
          account: accountField,
          folder: { type: "string", description: "Folder name, default inbox" },
          limit: { type: "integer", minimum: 1, maximum: 100, description: "Page size, default 20" },
          offset: { type: "integer", minimum: 0, description: "Offset for paging" },
        },
        additionalProperties: false,
      },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        const typed = input as AccountInput & { folder?: string; limit?: number; offset?: number }
        try {
          return {
            content: json(
              await run(typed, (backend) =>
                backend.listMessages({
                  folder: typed.folder,
                  limit: clampInt(typed.limit, 20, 1, 100),
                  offset: clampInt(typed.offset, 0, 0, 1_000_000),
                }),
              ),
            ),
          }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "search",
      description: "Search messages by text (local FTS index when available, otherwise EWS subject/body search).",
      input: {
        type: "object",
        properties: {
          account: accountField,
          query: { type: "string", minLength: 1, maxLength: 512 },
          limit: { type: "integer", minimum: 1, maximum: 50, description: "Default 20" },
        },
        required: ["query"],
        additionalProperties: false,
      },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        const typed = input as AccountInput & { query: string; limit?: number }
        try {
          return {
            content: json(
              await run(typed, (backend) =>
                backend.searchMessages({ query: typed.query, limit: clampInt(typed.limit, 20, 1, 50) }),
              ),
            ),
          }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "get",
      description: "Read one message by id, including the body (truncated to the configured limit).",
      input: {
        type: "object",
        properties: {
          account: accountField,
          id: { type: "string", minLength: 1, description: "EWS item id from mail_list/mail_search" },
        },
        required: ["id"],
        additionalProperties: false,
      },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        const typed = input as AccountInput & { id: string }
        try {
          return { content: json(await run(typed, (backend) => backend.getMessage({ id: typed.id }))) }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "sync",
      description: "Refresh the local index for a mail folder (inbox/sent/drafts/deleted) using EWS SyncFolderItems.",
      input: {
        type: "object",
        properties: { account: accountField, folder: { type: "string", description: "Default inbox" } },
        additionalProperties: false,
      },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        const typed = input as AccountInput & { folder?: string }
        try {
          return { content: json(await run(typed, (backend) => backend.syncFolder(typed.folder ?? "inbox"))) }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "draft",
      description: "Create a draft (does not send). Use this when the user has not explicitly confirmed sending.",
      input: outgoingSchema,
      options: { namespace: "mail", codemode, permission: "mail.draft" },
      execute: async (input) => {
        try {
          return {
            content: json(await run(input as AccountInput, (backend) => backend.saveDraft(input as OutgoingMessage))),
          }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "send",
      description: "Send an email immediately. Requires the `mail.send` permission to be allowed by the user's rules.",
      input: outgoingSchema,
      options: { namespace: "mail", codemode, permission: "mail.send" },
      execute: async (input) => {
        const typed = input as AccountInput & OutgoingMessage
        try {
          // Inside try: a misconfigured account should be an ERROR result, not a thrown tool.
          if (!service.config(typed.account).allowSend) {
            return { content: "ERROR: sending is disabled (allowSend=false)", metadata: { error: true } }
          }
          return { content: json(await run(typed, (backend) => backend.send(typed))) }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "calendar",
      description:
        "List calendar events in a time range (ISO 8601). Default range: now .. +14 days. Use ISO timestamps with explicit offsets.",
      input: {
        type: "object",
        properties: {
          account: accountField,
          from: { type: "string", description: "ISO start, default now" },
          to: { type: "string", description: "ISO end, default +14 days" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50" },
        },
        additionalProperties: false,
      },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        const typed = input as AccountInput & { from?: string; to?: string; limit?: number }
        try {
          return {
            content: json(
              await run(typed, (backend) =>
                backend.listCalendar({
                  from: typed.from,
                  to: typed.to,
                  limit: clampInt(typed.limit, 50, 1, 200),
                }),
              ),
            ),
          }
        } catch (error) {
          return failure(error)
        }
      },
    })

    add({
      name: "contacts",
      description: "List or filter contacts from the mailbox Contacts folder.",
      input: {
        type: "object",
        properties: {
          account: accountField,
          query: { type: "string", description: "Substring of display name or email" },
          limit: { type: "integer", minimum: 1, maximum: 200, description: "Default 50" },
        },
        additionalProperties: false,
      },
      options: { namespace: "mail", codemode, permission: "mail.read" },
      execute: async (input) => {
        const typed = input as AccountInput & { query?: string; limit?: number }
        try {
          return {
            content: json(
              await run(typed, (backend) =>
                backend.listContacts({ query: typed.query, limit: clampInt(typed.limit, 50, 1, 200) }),
              ),
            ),
          }
        } catch (error) {
          return failure(error)
        }
      },
    })
  })

  return registration
}

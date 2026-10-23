/**
 * Round-2 live repro: recipients in cached list, SOAP escaping of addresses/queries,
 * item-id validation, sync `complete`/`skipped`, router disposal.
 * Read-only apart from one draft that is hard-deleted; sends nothing.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { ConfigurationApi, DeleteMode, EmailMessage, ItemId } from "ews-javascript-api"
import { resolveAccounts } from "../src/config"
import { createEwsService } from "../src/ews"
import { MailService } from "../src/service"
import { registerTools } from "../src/tools"
import { disposeXhrRouter, installXhrRouter } from "../src/xhr-router"

installXhrRouter()
const self = process.env.MAIL_SELF ?? ""
const dir = mkdtempSync(path.join(tmpdir(), "round2-"))

const make = (storage: "off" | "metadata") => {
  const accounts = resolveAccounts({ storage, dataDir: dir, accounts: [{ id: "primary" }] })
  const service = new MailService(accounts)
  const tools: Record<string, { execute: (input?: unknown) => Promise<{ content?: string }> }> = {}
  registerTools(
    {
      tool: {
        transform: (callback: (editor: unknown) => void) => {
          callback({
            namespace: () => {},
            add: (tool: { name: string }) => {
              tools[tool.name] = tool as never
            },
            update: () => {},
            remove: () => {},
          })
          return Promise.resolve({ dispose: async () => {} })
        },
      },
    } as never,
    service,
  )
  return { service, tools, account: accounts[0]! }
}

const parse = (result: { content?: string }) => JSON.parse(String(result.content))
const brief = (result: { content?: string }) => String(result.content).replace(/\s+/g, " ").slice(0, 140)
const summarize = (page: Array<{ subject: string; to: string[]; cc?: string[]; recipientsKnown?: boolean }>) =>
  page.map((entry) => ({
    subject: String(entry.subject).slice(0, 24),
    to: entry.to,
    cc: entry.cc ?? null,
    known: entry.recipientsKnown,
  }))

const meta = make("metadata")
const syncInbox = parse(await meta.tools.sync.execute({ folder: "inbox" }))
console.log(JSON.stringify({ sync_inbox: syncInbox }))
console.log(JSON.stringify({ sync_calendar: parse(await meta.tools.sync.execute({ folder: "calendar" })) }))

const before = parse(await meta.tools.list.execute({ limit: 3 }))
console.log(JSON.stringify({ list_before_get: summarize(before) }))

if (before[0]) {
  const first = parse(await meta.tools.get.execute({ id: before[0].id }))
  const second = parse(await meta.tools.get.execute({ id: before[0].id }))
  console.log(
    JSON.stringify({
      get: { to: first.to, cc: first.cc, fetched: first.fetched, body: first.body.length },
      get_again: { to: second.to, cc: second.cc, fetched: second.fetched },
    }),
  )
  const after = parse(await meta.tools.list.execute({ limit: 3 }))
  console.log(JSON.stringify({ list_after_get: summarize(after) }))
}

const search = String((await meta.tools.search.execute({ query: "R&D", limit: 3 })).content)
console.log(JSON.stringify({ search_amp: { error: search.startsWith("ERROR"), head: search.replace(/\s+/g, " ").slice(0, 100) } }))

const badId = String((await meta.tools.get.execute({ id: 'AAA"onmouseover=x' })).content)
console.log(JSON.stringify({ quote_id: badId.replace(/\s+/g, " ").slice(0, 120) }))

const ampDraft = await meta.tools.draft.execute({
  to: ["a&b@example.com"],
  subject: `round2 amp draft ${Date.now()}`,
  body: "amp recipient probe",
})
const ampText = brief(ampDraft)
console.log(JSON.stringify({ draft_amp: ampText }))
if (!ampText.startsWith("ERROR")) {
  const id = JSON.parse(String(ampDraft.content)).id
  await meta.service.run("primary", async () => {
    const service = createEwsService(meta.account)
    const message = await EmailMessage.Bind(service, new ItemId(id))
    await message.Delete(DeleteMode.HardDelete)
  })
  console.log(JSON.stringify({ draft_amp_deleted: true }))
}

meta.service.close()
console.log(JSON.stringify({ meta_closed: true }))

const off = make("off")
console.log(JSON.stringify({ sync_off: parse(await off.tools.sync.execute({ folder: "inbox" })) }))
off.service.close()

// service.close() must dispose the router: a later install has to reach ConfigureXHR again.
const original = ConfigurationApi.ConfigureXHR
let configured = 0
ConfigurationApi.ConfigureXHR = ((...args: unknown[]) => {
  configured++
  return original.apply(ConfigurationApi, args as never)
}) as typeof ConfigurationApi.ConfigureXHR
disposeXhrRouter()
installXhrRouter()
const afterFirst = configured
disposeXhrRouter()
installXhrRouter()
console.log(JSON.stringify({ router_reinstall_after_dispose: { first: afterFirst, second: configured } }))
ConfigurationApi.ConfigureXHR = original
disposeXhrRouter()

rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ done: true }))

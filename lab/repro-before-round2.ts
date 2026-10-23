/** Pre-fix repro (base commit): recipients in cached list, `R&D` search, item id, sync shape. */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveAccounts } from "../src/config"
import { MailService } from "../src/service"
import { registerTools } from "../src/tools"
import { installXhrRouter } from "../src/xhr-router"

installXhrRouter()
const dir = mkdtempSync(path.join(tmpdir(), "before-round2-"))
const accounts = resolveAccounts({ storage: "metadata", dataDir: dir, accounts: [{ id: "primary" }] })
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

const text = (result: { content?: string }) => String(result.content).replace(/\s+/g, " ").slice(0, 200)
const parse = (result: { content?: string }) => JSON.parse(String(result.content))

console.log(JSON.stringify({ sync_inbox: text(await tools.sync!.execute({ folder: "inbox" })) }))
console.log(JSON.stringify({ sync_calendar: text(await tools.sync!.execute({ folder: "calendar" })) }))
const page = parse(await tools.list!.execute({ limit: 3 }))
console.log(
  JSON.stringify({
    list: page.slice(0, 2).map((entry: { subject: string; to: string[]; cc?: string[]; recipientsKnown?: boolean }) => ({
      subject: String(entry.subject).slice(0, 24),
      to: entry.to,
      cc: entry.cc ?? null,
      known: entry.recipientsKnown ?? "absent",
    })),
  }),
)
console.log(JSON.stringify({ search_amp: text(await tools.search!.execute({ query: "R&D", limit: 3 })) }))
console.log(JSON.stringify({ quote_id: text(await tools.get!.execute({ id: 'AAA"onmouseover=x' })) }))
console.log(JSON.stringify({ draft_amp: text(await tools.draft!.execute({ to: ["a&b@example.com"], subject: "before amp", body: "x" })) }))

service.close()
rmSync(dir, { recursive: true, force: true })
console.log(JSON.stringify({ done: true }))

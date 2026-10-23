/**
 * Live smoke test of the multi-account service (read-only) against EWS.
 * Requires MAIL_EWS_URL / MAIL_USER / MAIL_PASSWORD and NODE_EXTRA_CA_CERTS.
 */
import { resolveAccounts } from "../src/config"
import { MailService } from "../src/service"
import { installXhrRouter } from "../src/xhr-router"

installXhrRouter()
const accounts = resolveAccounts({
  storage: (process.env.MAIL_STORAGE as "metadata") ?? "metadata",
  accounts: [{ id: "primary" }],
})
const service = new MailService(accounts)
const account = service.defaultAccount

const t0 = performance.now()
try {
  const folders = await service.run(account, (backend) => backend.listFolders())
  console.log("folders:", folders.map((folder) => folder.name).join(", "))

  const list = await service.run(account, (backend) => backend.listMessages({ limit: 3 }))
  console.log("list:", list.map((message) => `${message.received} | ${message.subject}`))

  if (list[0]) {
    const detail = await service.run(account, (backend) => backend.getMessage({ id: list[0].id }))
    console.log(`get: ${detail.subject}; body=${detail.body.length} chars; type=${detail.bodyType}`)
  }

  const found = await service.run(account, (backend) => backend.searchMessages({ query: "проверка", limit: 3 }))
  console.log("search:", found.map((message) => message.subject))

  const events = await service.run(account, (backend) => backend.listCalendar({ limit: 3 }))
  console.log("calendar:", events.length)

  const contacts = await service.run(account, (backend) => backend.listContacts({ limit: 3 }))
  console.log("contacts:", contacts.length)
  console.log(`done in ${Math.round(performance.now() - t0)} ms; accounts=${service.ids().join(",")}`)
} finally {
  service.close()
}

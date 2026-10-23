import { env } from "../env"
/**
 * Read-only spike: EWS via NTLM from Bun 1.4.2.
 * Credentials come from EX_USER / EX_PASS env vars; ничего не пишется на диск.
 * Только чтение: папки, inbox, календарь, контакты. Отправка не выполняется.
 */
import {
  ConfigurationApi,
  ExchangeService,
  ExchangeVersion,
  FolderView,
  ItemView,
  PropertySet,
  Uri,
  WebCredentials,
  WellKnownFolderName,
  BasePropertySet,
  CalendarView,
  DateTime,
} from "ews-javascript-api"
import { XhrApi } from "@ewsjs/xhr"

const user = env("EX_USER")
const pass = env("EX_PASS")
const url = env("EX_URL")

if (!user || !pass) {
  console.error("EX_USER / EX_PASS are required")
  process.exit(2)
}

const step = async <T>(name: string, fn: () => Promise<T>): Promise<T | undefined> => {
  const started = performance.now()
  try {
    const value = await fn()
    console.log(`OK   ${name} (${Math.round(performance.now() - started)} ms)`)
    return value
  } catch (error) {
    const e = error as { message?: string; stack?: string }
    console.log(`FAIL ${name} (${Math.round(performance.now() - started)} ms): ${e.message ?? error}`)
    if (process.env.EX_DEBUG) console.log(e.stack)
    return undefined
  }
}

console.log(`bun ${Bun.version}; user=${user.split("\\")[0]}\\***; url=${url}`)

const xhr = new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass)
ConfigurationApi.ConfigureXHR(xhr)

const service = new ExchangeService(ExchangeVersion.Exchange2016)
service.Credentials = new WebCredentials(user, pass)
service.Url = new Uri(url)

const folders = await step("FindFolders(MsgFolderRoot)", async () => {
  const result = await service.FindFolders(WellKnownFolderName.MsgFolderRoot, new FolderView(25))
  return result.Folders.map((folder) => folder.DisplayName)
})
if (folders) console.log(`     folders (${folders.length}): ${folders.join(", ")}`)

const inbox = await step("FindItems(Inbox, top 3) + load Subject", async () => {
  const result = await service.FindItems(WellKnownFolderName.Inbox, new ItemView(3))
  await service.LoadPropertiesForItems(result.Items, new PropertySet(BasePropertySet.FirstClassProperties))
  return {
    total: result.TotalCount,
    items: result.Items.map((item) => ({
      subject: String(item.Subject ?? "").slice(0, 60),
      received: item.DateTimeReceived?.toString() ?? "",
    })),
  }
})
if (inbox) {
  console.log(`     inbox total=${inbox.total}`)
  for (const item of inbox.items) console.log(`     - ${item.received} | ${item.subject}`)
}

const calendar = await step("FindAppointments(Calendar, next 7 days)", async () => {
  const start = DateTime.Now
  const end = start.AddDays(7)
  const result = await service.FindAppointments(WellKnownFolderName.Calendar, new CalendarView(start, end))
  return result.Items.length
})
if (calendar !== undefined) console.log(`     appointments next 7d: ${calendar}`)

const contacts = await step("FindItems(Contacts, top 3)", async () => {
  const result = await service.FindItems(WellKnownFolderName.Contacts, new ItemView(3))
  return result.TotalCount
})
if (contacts !== undefined) console.log(`     contacts total=${contacts}`)

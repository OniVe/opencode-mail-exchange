import { env } from "../env"
/**
 * Write-path spike: draft with attachment, hard delete, send-to-self, verify in Inbox.
 * Usage: bun run mail-ops.ts draft|send|read
 */
import {
  BasePropertySet,
  BodyType,
  CalendarView,
  ConfigurationApi,
  DateTime,
  DeleteMode,
  EmailMessage,
  ExchangeService,
  ExchangeVersion,
  ItemView,
  MessageBody,
  PropertySet,
  Uri,
  WebCredentials,
  WellKnownFolderName,
} from "ews-javascript-api"
import { XhrApi } from "@ewsjs/xhr"

const user = env("EX_USER")
const pass = env("EX_PASS")
const url = env("EX_URL")
const self = env("EX_SELF")
const mode = process.argv[2] ?? "read"

if (!user || !pass) {
  console.error("EX_USER / EX_PASS are required")
  process.exit(2)
}

ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass))
const service = new ExchangeService(ExchangeVersion.Exchange2016)
service.Credentials = new WebCredentials(user, pass)
service.Url = new Uri(url)

const stamp = new Date().toISOString()
const subject = `opencode-mail-exchange spike ${stamp}`

if (mode === "draft") {
  const message = new EmailMessage(service)
  message.Subject = subject
  message.Body = new MessageBody(BodyType.HTML, "<p>spike draft — safe to delete</p>")
  message.ToRecipients.Add(self)
  message.Attachments.AddFileAttachment("spike.txt", Buffer.from("spike attachment\n").toString("base64"))

  await message.Save()
  console.log(`draft saved id=${message.Id?.UniqueId ?? "?"} subject=${message.Subject}`)

  const bound = await EmailMessage.Bind(service, message.Id, new PropertySet(BasePropertySet.FirstClassProperties))
  console.log(
    `draft bound subject=${bound.Subject} attachments=${bound.Attachments.Count} bodyLength=${bound.Body?.Text?.length ?? 0}`,
  )

  await message.Delete(DeleteMode.HardDelete)
  console.log("draft hard-deleted")
}

if (mode === "send") {
  const message = new EmailMessage(service)
  message.Subject = subject
  message.Body = new MessageBody(BodyType.HTML, `<p>spike send at ${stamp}</p>`)
  message.ToRecipients.Add(self)

  const started = performance.now()
  await message.Send()
  console.log(`sent in ${Math.round(performance.now() - started)} ms, subject=${subject}`)

  let found = false
  for (let attempt = 1; attempt <= 12 && !found; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 5000))
    const page = await service.FindItems(WellKnownFolderName.Inbox, new ItemView(25))
    await service.LoadPropertiesForItems(page.Items, new PropertySet(BasePropertySet.FirstClassProperties))
    const hit = page.Items.find((item) => item.Subject === subject)
    if (hit) {
      found = true
      console.log(`delivered after ~${attempt * 5}s; received=${hit.DateTimeReceived}`)
      await hit.Delete(DeleteMode.HardDelete)
      console.log("test message hard-deleted from Inbox")
    }
  }
  if (!found) console.log("NOT DELIVERED within 60s (send itself succeeded)")
}

if (mode === "read") {
  const page = await service.FindItems(WellKnownFolderName.Inbox, new ItemView(5))
  await service.LoadPropertiesForItems(page.Items, new PropertySet(BasePropertySet.FirstClassProperties))
  for (const item of page.Items) {
    console.log(`${item.DateTimeReceived} | ${item.Subject} | body=${item.Body?.Text?.length ?? 0} chars`)
  }
  const calendar = await service.FindAppointments(
    WellKnownFolderName.Calendar,
    new CalendarView(DateTime.Now, DateTime.Now.AddDays(14)),
  )
  console.log(`appointments next 14d: ${calendar.Items.length}`)
}

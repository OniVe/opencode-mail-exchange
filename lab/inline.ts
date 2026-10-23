import { env } from "./env"
/**
 * Inline-image probe: HTML body with cid: image, draft round-trip, send-to-self and read back.
 * Deletes the draft, the sent copy and the received copy afterwards.
 */
import {
  BasePropertySet,
  BodyType,
  ConfigurationApi,
  DeleteMode,
  EmailMessage,
  ExchangeService,
  ExchangeVersion,
  EmailMessageSchema,
  ItemSchema,
  ItemView,
  MessageBody,
  PropertySet,
  Uri,
  WebCredentials,
  WellKnownFolderName,
} from "ews-javascript-api"
import { XhrApi } from "@ewsjs/xhr"

// 1x1 transparent PNG
const PNG_1PX =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z0ZkAAAAASUVORK5CYII="

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const user = env("MAIL_USER")
const pass = env("MAIL_PASSWORD")
ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass))
const service = new ExchangeService(ExchangeVersion.Exchange2016)
service.Credentials = new WebCredentials(user, pass)
service.Url = new Uri(env("MAIL_EWS_URL"))
const self = env("MAIL_SELF")
const subject = `spike inline ${new Date().toISOString()}`

const build = (): EmailMessage => {
  const message = new EmailMessage(service)
  message.Subject = subject
  message.Body = new MessageBody(
    BodyType.HTML,
    escapeXml('<html><body><p>inline image below</p><img src="cid:spike-image" alt="pixel" /></body></html>'),
  )
  message.ToRecipients.Add(self)
  const inline = message.Attachments.AddFileAttachment("pixel.png", PNG_1PX)
  inline.ContentId = "spike-image"
  inline.IsInline = true
  return message
}

const FULL = new PropertySet(BasePropertySet.FirstClassProperties, [EmailMessageSchema.Body, ItemSchema.MimeContent])

const mimeOf = (message: EmailMessage) => {
  const raw = message.MimeContent?.Content ?? ""
  const text = raw ? Buffer.from(raw, "base64").toString("utf8") : ""
  if (process.env.MIME_DUMP && text) console.log(text.slice(0, 3000))
  return {
    mimeLength: text.length,
    mimeHasCid: text.includes("cid:spike-image"),
    mimeContentId: /Content-ID:\s*<([^>]+)>/i.exec(text)?.[1] ?? null,
    bodyLength: message.Body?.Text?.length ?? 0,
    bodySnippet: (message.Body?.Text ?? "").slice(0, 120),
  }
}

const draft = build()
await draft.Save()
const bound = await EmailMessage.Bind(service, draft.Id, FULL)
const savedAttachment = bound.Attachments.GetEnumerator()[0]
console.log(
  JSON.stringify({
    draft: {
      ...mimeOf(bound),
      attachments: bound.Attachments.Count,
      contentId: savedAttachment?.ContentId ?? null,
      isInline: savedAttachment?.IsInline ?? null,
      size: savedAttachment?.Size ?? null,
    },
  }),
)
await draft.Delete(DeleteMode.HardDelete)

const message = build()
await message.Send()
console.log(JSON.stringify({ sent: true, subject }))

let received: EmailMessage | undefined
for (let attempt = 1; attempt <= 12 && !received; attempt++) {
  await new Promise((resolve) => setTimeout(resolve, 5000))
  const page = await service.FindItems(WellKnownFolderName.Inbox, new ItemView(25))
  if (page.Items.length > 0) {
    await service.LoadPropertiesForItems(page.Items, new PropertySet(BasePropertySet.FirstClassProperties))
  }
  const hit = page.Items.find((item) => item.Subject === subject)
  if (hit) received = await EmailMessage.Bind(service, hit.Id, FULL)
}

if (!received) {
  console.log(JSON.stringify({ received: false }))
} else {
  const attachment = received.Attachments.GetEnumerator()[0]
  console.log(
    JSON.stringify({
      received: true,
      ...mimeOf(received),
      attachments: received.Attachments.Count,
      contentId: attachment?.ContentId ?? null,
      isInline: attachment?.IsInline ?? null,
      size: attachment?.Size ?? null,
    }),
  )
  await received.Delete(DeleteMode.HardDelete)
}

for (let attempt = 0; attempt < 6; attempt++) {
  const sentPage = await service.FindItems(WellKnownFolderName.SentItems, new ItemView(25))
  if (sentPage.Items.length > 0) {
    await service.LoadPropertiesForItems(sentPage.Items, new PropertySet(BasePropertySet.FirstClassProperties))
    const matches = sentPage.Items.filter((item) => item.Subject === subject)
    for (const item of matches) await item.Delete(DeleteMode.HardDelete)
    if (matches.length > 0) break
  }
  await new Promise((resolve) => setTimeout(resolve, 2000))
}

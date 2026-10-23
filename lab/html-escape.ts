import { env } from "./env"
/** Probe: HTML body needs XML-escaping because the library writes raw text into SOAP. */
import {
  BasePropertySet,
  BodyType,
  ConfigurationApi,
  DeleteMode,
  EmailMessage,
  ExchangeService,
  ExchangeVersion,
  ItemSchema,
  MessageBody,
  PropertySet,
  Uri,
  WebCredentials,
} from "ews-javascript-api"
import { XhrApi } from "@ewsjs/xhr"

const user = env("MAIL_USER")
const pass = env("MAIL_PASSWORD")
ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass))
const service = new ExchangeService(ExchangeVersion.Exchange2016)
service.Credentials = new WebCredentials(user, pass)
service.Url = new Uri(env("MAIL_EWS_URL"))
const self = env("MAIL_SELF")
const FULL = new PropertySet(BasePropertySet.FirstClassProperties, [ItemSchema.MimeContent])

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

const html = '<html><body><p>escaped html</p><img src="cid:spike-image" alt="pixel" /></body></html>'

for (const [name, body] of [
  ["raw", html],
  ["escaped", escapeXml(html)],
] as const) {
  const message = new EmailMessage(service)
  message.Subject = `html escape probe ${name} ${Date.now()}`
  message.ToRecipients.Add(self)
  message.Body = new MessageBody(BodyType.HTML, body)
  await message.Save()
  const bound = await EmailMessage.Bind(service, message.Id, FULL)
  const mime = Buffer.from(bound.MimeContent?.Content ?? "", "base64").toString("utf8")
  const htmlPart = mime.slice(mime.indexOf("text/html"), mime.indexOf("text/html") + 400)
  console.log(
    JSON.stringify({
      variant: name,
      htmlPart,
      bodyLength: bound.Body?.Text?.length ?? 0,
      bodyPreview: (bound.Body?.Text ?? "").slice(0, 80),
    }),
  )
  await message.Delete(DeleteMode.HardDelete)
}

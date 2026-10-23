import { env } from "./env"
/** Probe: HTML body persistence. */
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
const FULL = new PropertySet(BasePropertySet.FirstClassProperties, [ItemSchema.MimeContent, ItemSchema.Body])

const variants: Array<[string, string]> = [
  ["html-simple", "<html><body><p>hello html</p></body></html>"],
  ["html-div", "<div>hello div</div>"],
  ["html-img", '<html><body><p>pic</p><img src="cid:spike-image" alt="pixel" /></body></html>'],
]

for (const [name, html] of variants) {
  const message = new EmailMessage(service)
  message.Subject = `html probe ${name} ${Date.now()}`
  message.ToRecipients.Add(self)
  message.Body = new MessageBody(BodyType.HTML, html)
  try {
    await message.Save()
    const bound = await EmailMessage.Bind(service, message.Id, FULL)
    const mime = Buffer.from(bound.MimeContent?.Content ?? "", "base64").toString("utf8")
    console.log(
      JSON.stringify({
        variant: name,
        bodyLength: bound.Body?.Text?.length ?? 0,
        bodyText: (bound.Body?.Text ?? "").slice(0, 80),
        mimeHasHtmlText: mime.includes("hello") || mime.includes("pic"),
        mimeLength: mime.length,
        htmlPart: mime.slice(mime.indexOf("text/html"), mime.indexOf("text/html") + 300),
      }),
    )
    await message.Delete(DeleteMode.HardDelete)
  } catch (error) {
    console.log(JSON.stringify({ variant: name, error: error instanceof Error ? error.message : String(error) }))
  }
}

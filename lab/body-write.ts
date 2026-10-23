import { env } from "./env"
/** Probe: how to persist a body through EWS Save(). */
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

const variants: Array<[string, (message: EmailMessage) => void]> = [
  ["ctor(type,text)", (message) => (message.Body = new MessageBody(BodyType.Text, "hello ctor"))],
  ["ctor(text)", (message) => (message.Body = new MessageBody("hello one-arg"))],
  [
    "setters",
    (message) => {
      message.Body = new MessageBody()
      message.Body.BodyType = BodyType.Text
      message.Body.Text = "hello setters"
    },
  ],
]

for (const [name, apply] of variants) {
  const message = new EmailMessage(service)
  message.Subject = `body probe ${name} ${Date.now()}`
  message.ToRecipients.Add(self)
  apply(message)
  try {
    await message.Save()
    const bound = await EmailMessage.Bind(service, message.Id, FULL)
    const mime = Buffer.from(bound.MimeContent?.Content ?? "", "base64").toString("utf8")
    const bodyLine = mime
      .split(/\r?\n/)
      .findIndex((line) => line.startsWith("hello"))
    console.log(JSON.stringify({ variant: name, bodyInMime: bodyLine >= 0 }))
    console.log(mime.split(/\r?\n/).filter((line) => line.startsWith("hello")).join(" | "))
    await message.Delete(DeleteMode.HardDelete)
  } catch (error) {
    console.log(JSON.stringify({ variant: name, error: error instanceof Error ? error.message : String(error) }))
  }
}

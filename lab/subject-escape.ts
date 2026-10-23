import { env } from "./env"
import {
  BasePropertySet,
  BodyType,
  ConfigurationApi,
  DeleteMode,
  EmailMessage,
  ExchangeService,
  ExchangeVersion,
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

const escapeXml = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
const original = "subject & <tags> test"
const message = new EmailMessage(service)
message.Subject = escapeXml(original)
message.ToRecipients.Add(env("MAIL_SELF"))
message.Body = new MessageBody(BodyType.Text, escapeXml("body & <tags>"))
await message.Save()
const bound = await EmailMessage.Bind(service, message.Id, new PropertySet(BasePropertySet.FirstClassProperties))
console.log(
  JSON.stringify({
    original,
    stored: bound.Subject,
    match: bound.Subject === original,
  }),
)
await message.Delete(DeleteMode.HardDelete)

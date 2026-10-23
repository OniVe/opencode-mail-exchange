import { env } from "../env"
import {
  BasePropertySet,
  ConfigurationApi,
  EmailMessage,
  EmailMessageSchema,
  ExchangeService,
  ExchangeVersion,
  ItemView,
  PropertySet,
  Uri,
  WebCredentials,
  WellKnownFolderName,
} from "ews-javascript-api"
import { XhrApi } from "@ewsjs/xhr"

const user = env("EX_USER")
const pass = env("EX_PASS")
ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass))
const service = new ExchangeService(ExchangeVersion.Exchange2016)
service.Credentials = new WebCredentials(user, pass)
service.Url = new Uri(env("EX_URL"))

const page = await service.FindItems(WellKnownFolderName.Inbox, new ItemView(1))
const id = page.Items[0].Id
const msg = await EmailMessage.Bind(
  service,
  id,
  new PropertySet(BasePropertySet.FirstClassProperties, [EmailMessageSchema.Body]),
)
console.log(`subject=${msg.Subject}`)
console.log(`bodyType=${msg.Body?.BodyType} textLength=${msg.Body?.Text?.length ?? 0}`)
console.log(`preview=${JSON.stringify((msg.Body?.Text ?? "").slice(0, 120))}`)

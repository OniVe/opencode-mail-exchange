import { env } from "./env"
/**
 * Large-attachment probe: create a draft with an attachment of size N, read it back, hard-delete.
 * Usage: bun run lab/attachments.ts [sizesMB...]
 */
import { randomBytes } from "node:crypto"
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

const sizes = process.argv.slice(2).map(Number).filter((n) => Number.isFinite(n) && n > 0)
const targets = sizes.length > 0 ? sizes : [5, 10, 20, 30]

const user = env("MAIL_USER")
const pass = env("MAIL_PASSWORD")
ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass))
const service = new ExchangeService(ExchangeVersion.Exchange2016)
service.Credentials = new WebCredentials(user, pass)
service.Url = new Uri(env("MAIL_EWS_URL"))

const self = env("MAIL_SELF")

for (const mb of targets) {
  const bytes = mb * 1024 * 1024
  const payload = randomBytes(bytes).toString("base64")
  const message = new EmailMessage(service)
  message.Subject = `spike attachment ${mb}MB ${new Date().toISOString()}`
  message.Body = new MessageBody(BodyType.Text, `attachment probe ${mb}MB`)
  message.ToRecipients.Add(self)
  message.Attachments.AddFileAttachment(`probe-${mb}mb.bin`, payload)

  const started = performance.now()
  try {
    await message.Save()
    const saveMs = Math.round(performance.now() - started)

    const bound = await EmailMessage.Bind(
      service,
      message.Id,
      new PropertySet(BasePropertySet.FirstClassProperties, []),
    )
    const attachment = bound.Attachments.GetEnumerator()[0]
    console.log(
      JSON.stringify({
        sizeMB: mb,
        ok: true,
        saveMs,
        base64MB: Math.round(payload.length / 1024 / 1024),
        attachments: bound.Attachments.Count,
        storedBytes: attachment?.Size ?? null,
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      }),
    )
    await message.Delete(DeleteMode.HardDelete)
  } catch (error) {
    const typed = error as {
      message?: string
      statusCode?: number
      status?: number
      responseText?: string
      HttpStatusCode?: number
      faultString?: unknown
      responseCode?: number
      errorDetails?: unknown
      response?: { status?: number; statusText?: string; body?: string }
      responseBody?: string
    }
    console.log(
      JSON.stringify({
        sizeMB: mb,
        ok: false,
        elapsedMs: Math.round(performance.now() - started),
        httpStatus: typed.HttpStatusCode ?? typed.status ?? typed.statusCode ?? typed.response?.status ?? null,
        faultString: typed.faultString ?? null,
        responseCode: typed.responseCode ?? null,
        errorDetails: typed.errorDetails ?? null,
        responseText: (typed.responseText ?? typed.responseBody ?? typed.response?.body ?? "").slice(0, 300),
        error: typed.message ?? String(error),
      }),
    )
  }
}

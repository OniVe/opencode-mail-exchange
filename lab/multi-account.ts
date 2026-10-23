import { env } from "./env"
/** Probe: can two accounts coexist in one process? Global XHR vs AsyncLocalStorage routing. */
import { AsyncLocalStorage } from "node:async_hooks"
import { ConfigurationApi, ExchangeService, ExchangeVersion, FolderView, FolderId, Uri, WebCredentials, WellKnownFolderName } from "ews-javascript-api"
import { XhrApi } from "@ewsjs/xhr"

const valid = { user: env("MAIL_USER"), pass: env("MAIL_PASSWORD") }
// Same domain as the real account, a mailbox that cannot exist: no real domain in the repo.
const invalid = { user: `${valid.user.split("\\")[0]}\\__nobody__`, pass: "wrong" }
const url = env("MAIL_EWS_URL")

const service = (creds: { user: string; pass: string }) => {
  const s = new ExchangeService(ExchangeVersion.Exchange2016)
  s.Credentials = new WebCredentials(creds.user, creds.pass)
  s.Url = new Uri(url)
  return s
}

const probe = async (name: string, fn: () => Promise<unknown>) => {
  const started = performance.now()
  try {
    const value = await fn()
    console.log(JSON.stringify({ name, ok: true, ms: Math.round(performance.now() - started), value }))
  } catch (error) {
    const typed = error as { HttpStatusCode?: number; message?: string }
    console.log(
      JSON.stringify({
        name,
        ok: false,
        ms: Math.round(performance.now() - started),
        status: typed.HttpStatusCode ?? null,
        error: typed.message ?? String(error),
      }),
    )
  }
}

const folders = (s: ExchangeService) => s.FindFolders(new FolderId(WellKnownFolderName.MsgFolderRoot), new FolderView(2))

// 1. Global provider: last configured credentials win.
ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(valid.user, valid.pass))
const serviceA = service(valid)
ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(invalid.user, invalid.pass))
const serviceB = service(invalid)

await probe("global: service A after B configured", async () => (await folders(serviceA)).Folders.length)
await probe("global: service B", async () => (await folders(serviceB)).Folders.length)

// 2. Per-call routing via AsyncLocalStorage.
const als = new AsyncLocalStorage<{ user: string; pass: string }>()
const cache = new Map<string, XhrApi>()
const xhrFor = (creds: { user: string; pass: string }) => {
  const key = `${creds.user}\u0000${creds.pass}`
  let xhr = cache.get(key)
  if (!xhr) {
    xhr = new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(creds.user, creds.pass)
    cache.set(key, xhr)
  }
  return xhr
}

const routed = {
  apiName: "routed",
  xhr: (options: unknown, progress?: unknown) => {
    const creds = als.getStore()
    if (!creds) return Promise.reject(new Error("no account context"))
    return xhrFor(creds).xhr(options as never, progress as never)
  },
  xhrStream: (options: unknown, progress?: unknown) => {
    const creds = als.getStore()
    if (!creds) return Promise.reject(new Error("no account context"))
    return xhrFor(creds).xhrStream(options as never, progress as never)
  },
  disconnect: () => {},
}
ConfigurationApi.ConfigureXHR(routed as never)

await probe("als: valid account", async () => {
  return als.run(valid, async () => (await folders(serviceA)).Folders.length)
})
await probe("als: invalid account", async () => {
  return als.run(invalid, async () => (await folders(serviceB)).Folders.length)
})
await probe("als: no context", async () => (await folders(serviceA)).Folders.length)

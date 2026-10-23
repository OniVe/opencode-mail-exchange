import { env } from "./env"
/**
 * Cold-start measurement: import -> service -> first EWS call.
 * Run in a fresh process each time: `bun run lab/perf-cold.ts`.
 */
const t0 = performance.now()

const ews = await import("ews-javascript-api")
const t1 = performance.now()

const { XhrApi } = await import("@ewsjs/xhr")
const t2 = performance.now()

const user = env("MAIL_USER")
const pass = env("MAIL_PASSWORD")
ews.ConfigurationApi.ConfigureXHR(new XhrApi({ rejectUnauthorized: true }).useNtlmAuthentication(user, pass))
const service = new ews.ExchangeService(ews.ExchangeVersion.Exchange2016)
service.Credentials = new ews.WebCredentials(user, pass)
service.Url = new ews.Uri(env("MAIL_EWS_URL"))
const t3 = performance.now()

const view = new ews.FolderView(5)
view.PropertySet = new ews.PropertySet(ews.BasePropertySet.FirstClassProperties, [ews.FolderSchema.TotalCount])
const folders = await service.FindFolders(new ews.FolderId(ews.WellKnownFolderName.MsgFolderRoot), view)
const t4 = performance.now()

console.log(
  JSON.stringify({
    importEwsMs: Math.round(t1 - t0),
    importXhrMs: Math.round(t2 - t1),
    serviceMs: Math.round(t3 - t2),
    firstCallMs: Math.round(t4 - t3),
    totalMs: Math.round(t4 - t0),
    folders: folders.Folders.length,
    rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
    bun: Bun.version,
  }),
)

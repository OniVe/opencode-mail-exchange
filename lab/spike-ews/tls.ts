import { env } from "../env"
const url = env("MAIL_EWS_URL")

const show = (label: string, e: any) => {
  console.log(`${label}: ${e?.name ?? ""} ${e?.code ?? ""} ${e?.message ?? e}`)
  if (e?.cause) console.log(`  cause: ${e.cause?.code ?? ""} ${e.cause?.message ?? e.cause}`)
}

try {
  const res = await fetch(url)
  console.log(`fetch: ${res.status}`)
} catch (e) {
  show("fetch", e)
}

const axios = (await import("axios")).default
const https = await import("node:https")

for (const rejectUnauthorized of [true, false]) {
  try {
    const res = await axios.get(url, { httpsAgent: new https.Agent({ rejectUnauthorized }), validateStatus: () => true })
    console.log(`axios rejectUnauthorized=${rejectUnauthorized}: ${res.status} www-authenticate=${res.headers["www-authenticate"]}`)
  } catch (e) {
    show(`axios rejectUnauthorized=${rejectUnauthorized}`, e)
  }
}

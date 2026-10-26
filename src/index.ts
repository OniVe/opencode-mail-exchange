import { Plugin } from "@opencode/plugin"
import { ConfigError, resolveAccounts } from "./config"
import { MailService } from "./service"
import { applyCaFiles } from "./tls"
import { registerTools } from "./tools"
import { installXhrRouter } from "./xhr-router"

export default Plugin.define({
  id: "mail.exchange",
  async setup(ctx) {
    let accounts: ReturnType<typeof resolveAccounts>
    try {
      accounts = resolveAccounts(ctx.options)
    } catch (error) {
      const message = error instanceof ConfigError ? error.message : String(error)
      console.error(`[mail.exchange] not configured: ${message}`)
      return
    }

    try {
      const ca = applyCaFiles(accounts)
      for (const issue of ca.issues) {
        console.error(`[mail.exchange] ${issue.id}: caFile ${issue.file} not applied: ${issue.message}`)
      }
      if (ca.unsupported) {
        for (const account of accounts) {
          if (account.caFile) {
            console.warn(
              `[mail.exchange] ${account.id}: runtime CA API unavailable; set NODE_EXTRA_CA_CERTS=${account.caFile} before starting OpenCode`,
            )
          }
        }
      } else if (ca.applied.length > 0) {
        console.log(`[mail.exchange] caFile applied at runtime: ${ca.applied.join(", ")}`)
      }
    } catch (error) {
      // Bad caFile must be visible, but a system-trusted CA can still make EWS work.
      const message = error instanceof Error ? error.message : String(error)
      console.error(`[mail.exchange] caFile ignored: ${message}`)
    }

    installXhrRouter()
    const service = new MailService(accounts)
    const registration = await registerTools(ctx, service)

    console.log(
      `[mail.exchange] ready: accounts=${accounts.map((account) => `${account.id}(${account.storage})`).join(", ")}; ` +
        `default=${service.defaultAccount}`,
    )

    return async () => {
      try {
        await registration.dispose()
      } finally {
        // Release SQLite handles and the global XHR router even if tool disposal failed.
        service.close()
      }
    }
  },
})

import { Plugin } from "@opencode/plugin"
import { ConfigError, resolveAccounts } from "./config"
import { MailService } from "./service"
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

    for (const account of accounts) {
      if (account.caFile && process.env.NODE_EXTRA_CA_CERTS !== account.caFile) {
        console.warn(
          `[mail.exchange] ${account.id}: caFile is set but NODE_EXTRA_CA_CERTS is not. ` +
            `Set NODE_EXTRA_CA_CERTS=${account.caFile} before starting OpenCode, or TLS to the private CA will fail.`,
        )
      }
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

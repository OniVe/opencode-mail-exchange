import { describe, expect, test } from "bun:test"
import { createServer } from "node:http"
import { XhrApi } from "@ewsjs/xhr"
import { ConfigurationApi } from "ews-javascript-api"
import { disposeXhrRouter, installXhrRouter, withAccount } from "../src/xhr-router"

describe("xhr router lifecycle", () => {
  test("install is idempotent and dispose allows a reinstall", () => {
    const original = ConfigurationApi.ConfigureXHR
    let calls = 0
    ConfigurationApi.ConfigureXHR = ((...args: unknown[]) => {
      calls++
      return original.apply(ConfigurationApi, args as never)
    }) as typeof ConfigurationApi.ConfigureXHR

    try {
      disposeXhrRouter()
      installXhrRouter()
      installXhrRouter()
      expect(calls).toBe(1)

      disposeXhrRouter()
      installXhrRouter()
      expect(calls).toBe(2)
    } finally {
      ConfigurationApi.ConfigureXHR = original
      disposeXhrRouter()
    }
  })

  test("the tool signal aborts an in-flight XhrApi request", async () => {
    installXhrRouter()
    const server = createServer(() => {})
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
    const address = server.address()
    const port = typeof address === "object" && address ? address.port : 0

    const controller = new AbortController()
    const started = Date.now()
    const pending = withAccount({ username: "u", password: "p", signal: controller.signal }, () =>
      new XhrApi().xhr({ url: `http://127.0.0.1:${port}/hang`, type: "GET" }),
    )
    setTimeout(() => controller.abort(), 50)

    let code: string | undefined
    try {
      await pending
    } catch (error) {
      code = (error as { code?: string }).code
    } finally {
      server.close()
    }
    expect(code).toBe("ERR_CANCELED")
    expect(Date.now() - started).toBeLessThan(2_000)
  })
})

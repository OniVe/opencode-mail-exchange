import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { MailConfig } from "../src/config"
import { MailService } from "../src/service"

const config = (requestTimeoutMs: number): MailConfig => ({
  id: "default",
  ewsUrl: "https://mail.example.com/EWS/Exchange.asmx",
  username: "CORP\\bot",
  password: "secret",
  selfAddress: "bot@example.com",
  storage: "off",
  dataDir: mkdtempSync(path.join(tmpdir(), "mail-service-")),
  maxMessages: 100,
  retentionDays: 365,
  maxBodyBytes: 1000,
  syncIntervalMinutes: 5,
  allowSend: true,
  requestTimeoutMs,
  codemode: false,
})

/** The shape `@ewsjs/xhr` really produces on Bun for both a timeout and a TLS rejection. */
const xhrSymptom = () => ({
  message: "undefined is not an object (evaluating 'response.headers')",
  ErrorCode: 0,
})

/** Run one failing action and return the thrown value plus how long it took. */
const runFailing = async (requestTimeoutMs: number, action: () => Promise<unknown>) => {
  const cfg = config(requestTimeoutMs)
  const service = new MailService([cfg])
  const started = Date.now()
  try {
    await service.run("default", action)
    throw new Error("expected the action to fail")
  } catch (thrown) {
    return { thrown, elapsed: Date.now() - started, cfg, service }
  }
}

describe("transport error messages", () => {
  test("the real xhr symptom after the timeout budget is reported as a timeout", async () => {
    const { thrown, cfg, service } = await runFailing(1_000, async () => {
      await new Promise((resolve) => setTimeout(resolve, 900))
      throw xhrSymptom()
    })
    expect((thrown as Error).message).toMatch(/EWS timeout after 1000 ms/)
    expect((thrown as Error).message).toContain("undefined is not an object")
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("the same symptom without elapsed time is reported as TLS/CA", async () => {
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw xhrSymptom()
    })
    expect((thrown as Error).message).toMatch(/EWS TLS\/CA handshake failed; check NODE_EXTRA_CA_CERTS/)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a fast axios certificate failure is reported as TLS/CA", async () => {
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw Object.assign(new Error("unable to verify the first certificate"), {
        code: "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
      })
    })
    expect((thrown as Error).message).toMatch(/EWS TLS\/CA handshake failed; check NODE_EXTRA_CA_CERTS/)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("an allowlisted timeout code is a timeout even when elapsed is short", async () => {
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw Object.assign(new Error("opaque"), { code: "ETIMEDOUT" })
    })
    expect((thrown as Error).message).toMatch(/EWS timeout after 30000 ms/)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("local storage failures are never dressed up as TLS", async () => {
    for (const code of ["SQLITE_BUSY", "SQLITE_CORRUPT", "ENOENT", "EACCES"]) {
      const error = Object.assign(new Error(`${code}: underlying failure`), { code })
      const { thrown, cfg, service } = await runFailing(30_000, async () => {
        throw error
      })
      expect(thrown).toBe(error)
      expect((thrown as Error).message).not.toContain("TLS")
      service.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("a local storage code with a transport-looking message is still local", async () => {
    const error = Object.assign(new Error("connection timeout while acquiring database lock"), {
      code: "SQLITE_BUSY",
    })
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw error
    })
    expect(thrown).toBe(error)
    expect((thrown as Error).message).not.toContain("EWS TLS")
    expect((thrown as Error).message).not.toContain("EWS timeout")
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a canceled request is reported as cancellation, not TLS", async () => {
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw Object.assign(new Error("canceled"), { code: "ERR_CANCELED", name: "CanceledError" })
    })
    expect((thrown as Error).message).toMatch(/EWS request cancelled/)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("an aborted signal does not relabel a real timeout", async () => {
    const cfg = config(1_000)
    const service = new MailService([cfg])
    const controller = new AbortController()
    controller.abort()
    try {
      await service.run(
        "default",
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 900))
          throw Object.assign(new Error("opaque"), { code: "ETIMEDOUT" })
        },
        controller.signal,
      )
      throw new Error("expected the action to fail")
    } catch (thrown) {
      expect((thrown as Error).message).toMatch(/EWS timeout after 1000 ms/)
      expect((thrown as Error).message).not.toContain("cancelled")
    } finally {
      service.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("an abort swallowed by the NTLM preCall is reported as cancellation", async () => {
    const cfg = config(30_000)
    const service = new MailService([cfg])
    const controller = new AbortController()
    controller.abort()
    try {
      await service.run(
        "default",
        async () => {
          throw xhrSymptom()
        },
        controller.signal,
      )
      throw new Error("expected the action to fail")
    } catch (thrown) {
      expect((thrown as Error).message).toMatch(/EWS request cancelled/)
    } finally {
      service.close()
      rmSync(cfg.dataDir, { recursive: true, force: true })
    }
  })

  test("duplicate symptom parts are de-duplicated", async () => {
    const symptom = "undefined is not an object (evaluating 'response.headers')"
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw { message: symptom, Message: symptom, ErrorCode: 0 }
    })
    const message = (thrown as Error).message
    expect(message.split(symptom).length - 1).toBe(1)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("a SOAP domain error is passed through unchanged", async () => {
    // Real SOAP faults arrive as SoapFaultDetails with a non-zero ErrorCode.
    const error = { Message: "Запрос не прошел проверку на соответствие схеме.", ErrorCode: 5 }
    const { thrown, cfg, service } = await runFailing(30_000, async () => {
      throw error
    })
    expect(thrown).toBe(error)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })

  test("domain errors are passed through unchanged", async () => {
    const cfg = config(30_000)
    const service = new MailService([cfg])

    const result = service.run("default", async () => {
      throw new Error('invalid item id: "x"')
    })
    await expect(result).rejects.toThrow(/^invalid item id/)
    service.close()
    rmSync(cfg.dataDir, { recursive: true, force: true })
  })
})

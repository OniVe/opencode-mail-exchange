import { EwsBackend } from "./backend"
import type { MailConfig } from "./config"
import { openStore, type Store } from "./store"
import type { MailBackend } from "./types"
import { disposeXhrRouter, withAccount } from "./xhr-router"

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error))

/**
 * Transport symptoms. `@ewsjs/xhr` on Bun reports both a TLS/CA rejection and a timeout as
 * `SoapFaultDetails` with `ErrorCode 0` and the inner TypeError
 * `undefined is not an object (evaluating 'response.headers')`, so the wording matters more
 * than the shape. Codes below are the axios allowlist; anything else is not "the wire failed".
 */
const TRANSPORT_CODES =
  /^(?:ECONNABORTED|ETIMEDOUT|ECONNRESET|ENOTFOUND|CERT_[A-Z0-9_]+|UNABLE_TO_VERIFY_LEAF_SIGNATURE|DEPTH_ZERO_SELF_SIGNED_CERT)$/

/** Local/storage failures also carry a string `code`; they never come from the network. */
const LOCAL_FAILURE_CODES = /^(?:SQLITE_[A-Z0-9_]+|ENOENT|EACCES)$/

const TRANSPORT_HINT =
  /timeout|ETIMEDOUT|ECONNABORTED|ECONNRESET|ECONNREFUSED|socket hang up|self[- ]signed|certificate|CERT_|handshake|TLS|SSL|undefined is not an object \(evaluating ['"]?response\.headers/i

/** Every place a transport symptom can hide: `SoapFaultDetails.Message`, `InnerException`, `cause`. */
const symptomText = (error: unknown): string => {
  const typed = error as {
    message?: unknown
    Message?: unknown
    exceptionType?: unknown
    InnerException?: { message?: unknown; Message?: unknown; exceptionType?: unknown }
    cause?: { message?: unknown }
  } | null
  const parts: string[] = []
  const push = (value: unknown): void => {
    if (typeof value === "string" && value !== "" && !parts.includes(value)) parts.push(value)
  }
  push(typed?.message)
  push(typed?.Message)
  push(typed?.exceptionType)
  push(typed?.InnerException?.message)
  push(typed?.InnerException?.Message)
  push(typed?.InnerException?.exceptionType)
  push(typed?.cause?.message)
  if (parts.length === 0) parts.push(String(error))
  return parts.join(" | ")
}

/**
 * A failed TLS handshake, a hung request and a broken index all surface as errors without a
 * SOAP body. Only the first two are transport failures; a SOAP fault with a real ErrorCode,
 * `SQLITE_*`/`ENOENT`/`EACCES` and any answered HTTP request are passed through untouched.
 */
const isTransportFailure = (error: unknown): boolean => {
  const typed = error as {
    response?: { status?: unknown; HttpStatusCode?: unknown; ErrorCode?: unknown } | undefined
    ErrorCode?: unknown
    HttpStatusCode?: unknown
    isAxiosError?: unknown
    code?: unknown
  } | null

  const code = typeof typed?.code === "string" ? typed.code : undefined
  if (code && LOCAL_FAILURE_CODES.test(code)) return false

  // EWS domain errors carry a real (non-zero) ErrorCode or an actual HTTP answer.
  const soapCode = typed?.ErrorCode ?? typed?.response?.ErrorCode
  if (typeof soapCode === "number" && soapCode !== 0) return false
  for (const status of [typed?.HttpStatusCode, typed?.response?.status, typed?.response?.HttpStatusCode]) {
    if (typeof status === "number" && status > 0) return false
  }

  if (code && TRANSPORT_CODES.test(code)) return true
  if (typed?.isAxiosError === true) return true
  return TRANSPORT_HINT.test(symptomText(error))
}

/**
 * A hung request and a rejected TLS handshake both surface as a bare socket error without a
 * response; elapsed time is the only reliable discriminator (0.8× the configured timeout,
 * but never a tighter discriminator than 500 ms).
 */
const TIMEOUT_FLOOR_MS = 500

const describeTransportFailure = (
  message: string,
  elapsedMs: number,
  timeoutMs: number,
  forceTimeout = false,
): Error => {
  const threshold = Math.max(TIMEOUT_FLOOR_MS, Math.round(timeoutMs * 0.8))
  if (forceTimeout || elapsedMs >= threshold) {
    return new Error(`EWS timeout after ${timeoutMs} ms (no response in ${elapsedMs} ms): ${message}`, {
      cause: message,
    })
  }
  return new Error(
    `EWS TLS/CA handshake failed; check NODE_EXTRA_CA_CERTS (failed after ${elapsedMs} ms): ${message}`,
    { cause: message },
  )
}

/**
 * Owns one EWS backend + SQLite store per configured account and routes each
 * call through the account's credentials (AsyncLocalStorage).
 */
export class MailService {
  private readonly backends = new Map<string, EwsBackend>()

  constructor(readonly accounts: MailConfig[]) {
    for (const account of accounts) {
      let store: Store | undefined
      try {
        store = openStore(account)
      } catch (error) {
        // A broken/unwritable index degrades the account to EWS-only, not the whole plugin.
        console.warn(`[mail.exchange] ${account.id}: local index disabled: ${messageOf(error)}`)
      }
      this.backends.set(account.id, new EwsBackend(account, store))
    }
  }

  get defaultAccount(): string {
    return this.accounts[0]?.id ?? "default"
  }

  ids(): string[] {
    return [...this.backends.keys()]
  }

  config(account?: string): MailConfig {
    const id = account ?? this.defaultAccount
    const config = this.accounts.find((candidate) => candidate.id === id)
    if (!config) throw new Error(`Unknown account: ${id}. Configured: ${this.ids().join(", ")}`)
    return config
  }

  async run<T>(
    account: string | undefined,
    action: (backend: MailBackend) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const config = this.config(account)
    const backend = this.backends.get(config.id)
    if (!backend) throw new Error(`Backend not initialized: ${config.id}`)
    const started = Date.now()
    try {
      return await withAccount(
        { username: config.username, password: config.password, timeoutMs: config.requestTimeoutMs, signal },
        () => action(backend),
      )
    } catch (error) {
      const typed = error as { code?: unknown; name?: unknown } | null
      if (typed?.code === "ERR_CANCELED" || typed?.name === "CanceledError" || typed?.name === "AbortError") {
        throw new Error("EWS request cancelled", { cause: error })
      }
      // `@ewsjs/xhr`'s NTLM preCall swallows CanceledError: the abort surfaces as a bare
      // `response.headers` TypeError without a code. Treat that as cancellation too.
      if (signal?.aborted && typed?.code === undefined && isTransportFailure(error)) {
        throw new Error("EWS request cancelled", { cause: error })
      }
      const message = messageOf(error)
      if (!isTransportFailure(error)) throw error
      const code = (error as { code?: unknown } | null)?.code
      const forceTimeout = typeof code === "string" && /^(?:ETIMEDOUT|ECONNABORTED)$/.test(code)
      const described = describeTransportFailure(
        symptomText(error),
        Date.now() - started,
        config.requestTimeoutMs,
        forceTimeout,
      )
      // Keep the original wording in the log: the wrapper only makes it actionable.
      console.warn(`[mail.exchange] ${config.id}: ${described.message} (original error: ${message})`)
      throw described
    }
  }

  close(): void {
    for (const backend of this.backends.values()) backend.close()
    // The process-wide XHR router owns per-account NTLM clients; do not leak them.
    disposeXhrRouter()
  }
}

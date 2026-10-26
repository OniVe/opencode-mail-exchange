import { AsyncLocalStorage } from "node:async_hooks"
import http from "node:http"
import https from "node:https"
import { StringDecoder } from "node:string_decoder"
import { createType1Message, createType3Message, decodeType2Message } from "@ewsjs/ntlm-client"
import axios, { type AxiosRequestConfig, type AxiosResponse } from "axios"
import { ConfigurationApi } from "ews-javascript-api"

export interface AccountCredentials {
  /** Stable account id; scopes `disconnect()` to the account that owns a stream. */
  accountId?: string
  username: string
  password: string
  /**
   * Deadline for a regular EWS call, covering both NTLM round-trips. Also used as
   * the per-request inactivity timeout. Hanging `xhrStream` subscriptions are not
   * deadline-bounded: they end on `signal`, `disconnect()` or socket idleness.
   */
  timeoutMs?: number
  /** Tool-call cancellation; attached to every EWS request made under this context. */
  signal?: AbortSignal
}

interface XhrOptions {
  type?: string
  url: string
  headers?: Record<string, unknown>
  data?: unknown
  allowRedirect?: boolean
}

export interface XhrResponse {
  responseText: string
  status?: number
  statusText: string
  headers: Record<string, unknown>
  finalUrl: string
  /** True when an error body was capped or the socket closed before the end. */
  truncated: boolean
  getAllResponseHeaders(): string
  getResponseHeader(name: string): string | null
}

interface XhrProgress {
  type: "data" | "header" | "end" | "error"
  data?: string
  headers?: unknown
  error?: unknown
}

const storage = new AsyncLocalStorage<AccountCredentials>()

const accountKey = (credentials: AccountCredentials): string => credentials.accountId ?? credentials.username

/**
 * A stream may legitimately stay silent between heartbeats; EWS heartbeats every
 * ~30 s while the default call timeout is also 30 s. Giving streams twice the call
 * deadline keeps a healthy idle subscription alive without letting it hang forever.
 */
const streamIdleBudget = (timeoutMs: number | undefined): number | undefined =>
  timeoutMs === undefined || timeoutMs <= 0 ? undefined : timeoutMs * 2

const splitUsername = (value: string): { user: string; domain: string } => {
  const slash = value.indexOf("\\")
  if (slash < 0) return { user: value, domain: "" }
  return { user: value.slice(slash + 1), domain: value.slice(0, slash).toUpperCase() }
}

const headerValue = (headers: unknown, name: string): string | undefined => {
  const record = headers as Record<string, unknown> | undefined
  const value = record?.[name] ?? record?.[name.toLowerCase()]
  if (value === undefined) return undefined
  const values = Array.isArray(value)
    ? value.map((entry) => String(entry))
    : String(value)
        .split(/,\s*(?=[A-Za-z])/)
        .map((entry) => entry.trim())
  return values.find((entry) => /^NTLM\s+\S/i.test(entry)) ?? values[0]
}

const stripHeaders = (headers: Record<string, unknown>, names: string[]): Record<string, unknown> => {
  const lower = new Set(names.map((name) => name.toLowerCase()))
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !lower.has(key.toLowerCase())))
}

interface ReadStreamOptions {
  /** Collect the body into `text`; false for hanging streams (progress only). */
  collect?: boolean
  /** Upper bound for collected bytes; the rest is dropped and `truncated` is set. */
  maxBytes?: number
  /** Inactivity budget: no data for this long aborts the stream. */
  idleMs?: number
  /** Resolve with the partial body on a socket error/close instead of rejecting. */
  tolerant?: boolean
  onChunk?: (text: string) => void
}

interface ReadStreamResult {
  text: string
  truncated: boolean
}

const readStream = (
  body: NodeJS.ReadableStream,
  signal: AbortSignal | undefined,
  options: ReadStreamOptions = {},
): Promise<ReadStreamResult> => {
  const collect = options.collect !== false
  const maxBytes = options.maxBytes ?? Number.POSITIVE_INFINITY
  const canceledError = (): XhrResponse =>
    networkError(Object.assign(new Error("canceled"), { code: "ERR_CANCELED", isAxiosError: true }))
  return new Promise((resolve, reject) => {
    const decoder = new StringDecoder("utf8")
    const parts: string[] = []
    let bytes = 0
    let truncated = false
    let settled = false
    let idleTimer: ReturnType<typeof setTimeout> | undefined
    const clearIdle = (): void => {
      if (idleTimer !== undefined) {
        clearTimeout(idleTimer)
        idleTimer = undefined
      }
    }
    const cleanup = (): void => {
      clearIdle()
      signal?.removeEventListener("abort", onAbort)
    }
    const armIdle = (): void => {
      if (options.idleMs === undefined || options.idleMs <= 0) return
      clearIdle()
      idleTimer = setTimeout(() => {
        if (options.tolerant) {
          // The status and headers are already known; keep the partial body rather
          // than downgrading a confirmed HTTP error to a status-less timeout.
          truncated = true
          ;(body as { destroy?: () => void }).destroy?.()
          settleText()
          return
        }
        fail(
          networkError(
            Object.assign(new Error(`timeout of ${options.idleMs}ms exceeded`), {
              code: "ECONNABORTED",
              isAxiosError: true,
            }),
          ),
        )
        ;(body as { destroy?: () => void }).destroy?.()
      }, options.idleMs)
    }
    const settleText = (): void => {
      if (settled) return
      settled = true
      cleanup()
      const tail = decoder.end()
      // A truncated body may end mid-character; flushing it would invent U+FFFD.
      if (collect && !truncated && tail !== "") parts.push(tail)
      resolve({ text: collect ? parts.join("") : "", truncated })
    }
    const fail = (error: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    function onAbort(): void {
      fail(canceledError())
    }
    if (signal?.aborted) {
      onAbort()
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    body.on("data", (chunk: Buffer | string) => {
      if (settled) return
      armIdle()
      const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk
      bytes += buffer.length
      if (collect && bytes > maxBytes) {
        truncated = true
        const allowed = Math.max(0, maxBytes - (bytes - buffer.length))
        if (allowed > 0) {
          const text = decoder.write(buffer.subarray(0, allowed))
          if (text !== "") {
            parts.push(text)
            options.onChunk?.(text)
          }
        }
        ;(body as { destroy?: () => void }).destroy?.()
        settleText()
        return
      }
      const text = decoder.write(buffer)
      if (collect) parts.push(text)
      if (text !== "") options.onChunk?.(text)
    })
    body.on("end", () => settleText())
    body.on("error", (error: unknown) => {
      if (settled) return
      if (signal?.aborted) {
        fail(canceledError())
        return
      }
      if (options.tolerant) {
        truncated = true
        settleText()
      } else {
        fail(error)
      }
    })
    body.on("close", () => {
      if (settled) return
      if (signal?.aborted) {
        fail(canceledError())
        return
      }
      if (options.tolerant) {
        truncated = true
        settleText()
      } else {
        fail(new Error("EWS stream closed before end"))
      }
    })
    // Headers may arrive with no body bytes at all; the transport timeout is not
    // reliable there, so the watchdog is armed immediately and re-armed on data.
    armIdle()
  })
}

const xhrResponse = (response: AxiosResponse, url: string, truncated = false): XhrResponse => {
  const headers = response.headers as unknown as Record<string, string>
  const body = typeof response.data === "string" ? response.data : String(response.data ?? "")
  const result = {
    responseText: body,
    status: response.status,
    statusText: response.statusText,
    headers,
    finalUrl: (response.request as { res?: { responseUrl?: string } } | undefined)?.res?.responseUrl ?? url,
    truncated,
    getAllResponseHeaders: () =>
      Object.entries(headers)
        .map(([key, value]) => `${key}: ${value}\r\n`)
        .join(""),
    getResponseHeader: (name: string) => headers[name] ?? headers[name.toLowerCase()] ?? null,
  }
  return result
}

const networkError = (error: unknown): XhrResponse => {
  const typed = error as {
    message?: string
    code?: string
    isAxiosError?: boolean
  } | null
  const result: XhrResponse & { message: string; code?: string; isAxiosError: boolean; cause: unknown } = {
    responseText: "",
    status: undefined,
    statusText: typed?.message ?? String(error),
    message: typed?.message ?? String(error),
    headers: {},
    finalUrl: "",
    truncated: false,
    getAllResponseHeaders: () => "",
    getResponseHeader: () => null,
    code: typed?.code,
    isAxiosError: typed?.isAxiosError === true,
    cause: { message: typed?.message ?? String(error), code: typed?.code },
  }
  return result
}

/**
 * EWS transport with its own NTLM handshake. It intentionally does not use
 * `@ewsjs/xhr`: that package builds axios clients internally, so cancellation and
 * per-account routing used to require a process-global axios patch. Here every EWS
 * request creates its own agent, performs the NTLM type1/type2/type3 exchange, and
 * carries the AsyncLocalStorage signal/timeout directly.
 */
export class MailXhrProvider {
  readonly apiName = "mail-ntlm"
  private readonly active = new Set<AbortController>()
  private readonly streams = new Map<AbortController, string>()

  xhr(options: XhrOptions, progress?: (value: XhrProgress) => void): Promise<XhrResponse> {
    return this.request(options, false, progress)
  }

  xhrStream(options: XhrOptions, progress: (value: XhrProgress) => void): Promise<XhrResponse> {
    return this.request(options, true, progress)
  }

  /** EWS calls this for a hanging subscription: stop streams of the current account only. */
  disconnect(): void {
    const current = storage.getStore()
    // EWS always disconnects from inside an account context. Without one there is no
    // owner to scope the abort to, so do not touch other accounts' streams.
    if (!current) return
    const key = accountKey(current)
    for (const [controller, owner] of [...this.streams]) {
      if (owner === key) {
        this.streams.delete(controller)
        controller.abort()
      }
    }
  }

  /** Plugin teardown: abort every active request, including normal calls. */
  dispose(): void {
    for (const controller of this.active) controller.abort()
    this.active.clear()
    this.streams.clear()
  }

  private async request(
    options: XhrOptions,
    stream: boolean,
    progress?: (value: XhrProgress) => void,
  ): Promise<XhrResponse> {
    const credentials = storage.getStore()
    if (!credentials) return Promise.reject(new Error("mail: no account context for EWS request"))

    const controller = new AbortController()
    this.active.add(controller)
    if (stream) this.streams.set(controller, accountKey(credentials))
    const external = credentials.signal
    const abort = (): void => controller.abort()
    if (external?.aborted) controller.abort()
    else external?.addEventListener("abort", abort, { once: true })
    let timedOut = false
    // A hanging stream must be able to outlive the call deadline; only regular calls
    // get the whole-call timer. Streams still honour the external signal, disconnect()
    // and the per-request inactivity timeout.
    const timer =
      !stream && credentials.timeoutMs !== undefined && credentials.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true
            controller.abort()
          }, credentials.timeoutMs)
        : undefined

    try {
      return await this.send(options, stream, progress, credentials, controller.signal)
    } catch (error) {
      const responseLike =
        error !== null && typeof error === "object" && "responseText" in error
          ? (error as { status?: number })
          : undefined
      if (responseLike?.status !== undefined) throw error
      if (timedOut) {
        throw networkError(
          Object.assign(new Error(`timeout of ${credentials.timeoutMs}ms exceeded`), {
            code: "ECONNABORTED",
            isAxiosError: true,
          }),
        )
      }
      if (responseLike) throw error
      if (axios.isAxiosError(error)) {
        if (error.response) {
          const mapped = xhrResponse(error.response, options.url)
          if (error.response.status !== 200) throw mapped
          return mapped
        }
        throw networkError(error)
      }
      throw error
    } finally {
      if (timer !== undefined) clearTimeout(timer)
      external?.removeEventListener("abort", abort)
      this.active.delete(controller)
      this.streams.delete(controller)
    }
  }

  private async handshake(
    options: XhrOptions,
    credentials: AccountCredentials,
    stream: boolean,
    signal: AbortSignal,
    callerHeaders: Record<string, unknown>,
    type1: string,
    user: string,
    domain: string,
  ): Promise<{ response: AxiosResponse; agent: http.Agent }> {
    const secure = new URL(options.url).protocol === "https:"
    const agent = secure ? new https.Agent({ keepAlive: true }) : new http.Agent({ keepAlive: true })
    const idleBudget = streamIdleBudget(credentials.timeoutMs)
    // For streams the axios timeout is the pre-first-byte bound (2x, same as the
    // readStream watchdog); once data flows the watchdog owns the inactivity window.
    const transportTimeout = stream ? idleBudget : credentials.timeoutMs
    const request = (extra: AxiosRequestConfig): Promise<AxiosResponse> =>
      axios.request({
        url: options.url,
        method: (options.type ?? "POST") as AxiosRequestConfig["method"],
        data: options.data,
        timeout: transportTimeout,
        signal,
        maxRedirects: options.allowRedirect ? 5 : 0,
        validateStatus: () => true,
        ...(secure ? { httpsAgent: agent } : { httpAgent: agent }),
        ...extra,
      })

    try {
      const preflight = await request({
        method: "GET",
        data: undefined,
        responseType: "text",
        headers: {
          ...callerHeaders,
          Authorization: type1,
          Connection: "keep-alive",
        } as AxiosRequestConfig["headers"],
      })
      const challenge = headerValue(preflight.headers, "www-authenticate")
      if (!challenge) throw new Error("www-authenticate not found on response of NTLM request")

      const type3 = createType3Message(decodeType2Message(challenge), user, credentials.password, ".", domain)
      const response = await request({
        responseType: stream ? "stream" : "text",
        headers: {
          ...callerHeaders,
          Authorization: type3,
          Connection: "Close",
        } as AxiosRequestConfig["headers"],
      })
      return { response, agent }
    } catch (error) {
      agent.destroy()
      throw error
    }
  }

  private async send(
    options: XhrOptions,
    stream: boolean,
    progress: ((value: XhrProgress) => void) | undefined,
    credentials: AccountCredentials,
    signal: AbortSignal,
  ): Promise<XhrResponse> {
    const headers = { ...(options.headers ?? {}) }
    const { user, domain } = splitUsername(credentials.username)
    const type1 = createType1Message(".", domain)
    // One allowlist for both requests: the caller never owns framing, host or auth.
    const callerHeaders = stripHeaders(headers, [
      "authorization",
      "connection",
      "content-length",
      "transfer-encoding",
      "host",
    ])

    let { response, agent } = await this.handshake(
      options,
      credentials,
      stream,
      signal,
      callerHeaders,
      type1,
      user,
      domain,
    )

    try {
      // A server that closed the type1 connection may lose the NTLM state before
      // type3 arrives. One fresh handshake separates a transient drop from a
      // credential failure; a second 401 is reported as-is.
      if (response.status === 401) {
        agent.destroy()
        const retry = await this.handshake(options, credentials, stream, signal, callerHeaders, type1, user, domain)
        response = retry.response
        agent = retry.agent
      }

      if (!stream) {
        const mapped = xhrResponse(response, options.url)
        if (response.status === 200) return mapped
        throw mapped
      }
      if (response.status !== 200) {
        const { text, truncated } = await readStream(response.data as NodeJS.ReadableStream, signal, {
          maxBytes: 64 * 1024,
          tolerant: true,
          idleMs: streamIdleBudget(credentials.timeoutMs),
        })
        throw xhrResponse({ ...response, data: text }, options.url, truncated)
      }

      progress?.({ type: "header", headers: response.headers })
      try {
        // Hanging streams are unbounded: report chunks as they arrive and do not
        // keep the body (a long subscription would grow memory without a limit).
        const result = await readStream(response.data as NodeJS.ReadableStream, signal, {
          collect: false,
          idleMs: streamIdleBudget(credentials.timeoutMs),
          onChunk: (chunk) => progress?.({ type: "data", data: chunk }),
        })
        progress?.({ type: "end" })
        return xhrResponse({ ...response, data: result.text }, options.url, result.truncated)
      } catch (error) {
        progress?.({ type: "error", error })
        throw error
      }
    } finally {
      agent.destroy()
    }
  }
}

const provider = new MailXhrProvider()
let installed = false

export function installXhrRouter(): void {
  if (installed) return
  ConfigurationApi.ConfigureXHR(provider as never)
  installed = true
}

/** Release active EWS requests and allow a later `installXhrRouter()` to install again. */
export function disposeXhrRouter(): void {
  provider.dispose()
  installed = false
}

export function withAccount<T>(credentials: AccountCredentials, run: () => Promise<T>): Promise<T> {
  return storage.run(credentials, run)
}

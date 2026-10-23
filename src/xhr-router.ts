import { AsyncLocalStorage } from "node:async_hooks"
import { createRequire } from "node:module"
import { XhrApi } from "@ewsjs/xhr"
import { ConfigurationApi } from "ews-javascript-api"

export interface AccountCredentials {
  username: string
  password: string
  /** Per-request timeout (axios `timeout`); without it a hung EWS call never resolves. */
  timeoutMs?: number
  /** Tool-call cancellation; attached to every axios request made under this context. */
  signal?: AbortSignal
}

/**
 * `@ewsjs/xhr` keeps one global NTLM provider per process, so switching accounts
 * globally would race between concurrent calls. Instead we install a router once
 * and pick the account from AsyncLocalStorage for the duration of a call.
 */
const storage = new AsyncLocalStorage<AccountCredentials>()
const cache = new Map<string, XhrApi>()

const keyOf = (credentials: AccountCredentials): string =>
  `${credentials.username}\u0000${credentials.password}\u0000${credentials.timeoutMs ?? ""}`

const xhrFor = (credentials: AccountCredentials): XhrApi => {
  const key = keyOf(credentials)
  let xhr = cache.get(key)
  if (!xhr) {
    xhr = new XhrApi({ rejectUnauthorized: true, timeout: credentials.timeoutMs }).useNtlmAuthentication(
      credentials.username,
      credentials.password,
    )
    cache.set(key, xhr)
  }
  return xhr
}

const router = {
  apiName: "mail-account-router",
  xhr(options: unknown, progress?: unknown) {
    const credentials = storage.getStore()
    if (!credentials) return Promise.reject(new Error("mail: no account context for EWS request"))
    return xhrFor(credentials).xhr(options as never, progress as never)
  },
  xhrStream(options: unknown, progress?: unknown) {
    const credentials = storage.getStore()
    if (!credentials) return Promise.reject(new Error("mail: no account context for EWS request"))
    return xhrFor(credentials).xhrStream(options as never, progress as never)
  },
  disconnect() {
    for (const xhr of cache.values()) xhr.disconnect?.()
    cache.clear()
  },
}

let installed = false
let axiosSignalInstalled = false

/**
 * `@ewsjs/xhr` is CJS and builds every request with `axios.create()` from the CJS axios
 * instance, which does not inherit interceptors from the ESM import. Patch that instance
 * (and its `create`) so the ALS signal reaches the actual socket.
 */
type AxiosLike = {
  interceptors: { request: { use: (fn: (config: Record<string, unknown>) => unknown) => void } }
  create: (config?: unknown) => AxiosLike
}

const installAxiosSignal = (): void => {
  if (axiosSignalInstalled) return
  try {
    const cjsAxios = createRequire(import.meta.url)("axios") as AxiosLike
    const attach = (config: Record<string, unknown>): Record<string, unknown> => {
      const signal = storage.getStore()?.signal
      if (signal) config.signal = signal
      return config
    }
    cjsAxios.interceptors.request.use(attach)
    const originalCreate = cjsAxios.create.bind(cjsAxios)
    cjsAxios.create = (config?: unknown): AxiosLike => {
      const instance = originalCreate(config)
      instance.interceptors.request.use(attach)
      return instance
    }
  } catch (error) {
    // Bundled hosts without node_modules can fail this resolve; keep the plugin alive,
    // cancellation is then unavailable and requestTimeoutMs remains the only bound.
    console.warn(`[mail.exchange] request cancellation disabled: ${String(error)}`)
  }
  axiosSignalInstalled = true
}

export function installXhrRouter(): void {
  if (installed) return
  installAxiosSignal()
  ConfigurationApi.ConfigureXHR(router as never)
  installed = true
}

/**
 * Release the global router: drop per-account XHR clients (and their NTLM connections)
 * and allow a later `installXhrRouter()` (e.g. a plugin reload) to install it again.
 */
export function disposeXhrRouter(): void {
  router.disconnect()
  installed = false
}

export function withAccount<T>(credentials: AccountCredentials, run: () => Promise<T>): Promise<T> {
  return storage.run(credentials, run)
}

import { createHash } from "node:crypto"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { StorageMode } from "./types"

export interface MailConfig {
  id: string
  ewsUrl: string
  username: string
  password: string
  selfAddress: string
  caFile?: string
  storage: StorageMode
  dataDir: string
  maxMessages: number
  retentionDays: number
  maxBodyBytes: number
  syncIntervalMinutes: number
  allowSend: boolean
  requestTimeoutMs: number
  /** Global tool visibility: false = direct calls, true = only through Code Mode `execute`. */
  codemode: boolean
}

export class ConfigError extends Error {}

/** Account ids become directory names, so they may not contain separators or `..`. */
const ACCOUNT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/** Extended-length (`\\?\`) and device (`\\.\`) paths keep trailing dots; do not normalize them. */
const EXTENDED_WIN32_PATH = /^[\\/]{2}\?[\\/]/
const DEVICE_WIN32_PATH = /^[\\/]{2}\.[\\/]/

/** Windows drops trailing dots/spaces from path components; mirror that before path comparisons. */
const normalizeWin32Path = (value: string): string => {
  if (process.platform !== "win32" || EXTENDED_WIN32_PATH.test(value) || DEVICE_WIN32_PATH.test(value)) return value
  const resolved = path.resolve(value)
  const root = path.parse(resolved).root
  const parts = resolved
    .slice(root.length)
    .split(/[\\/]+/)
    .filter(Boolean)
  let changed = false
  const normalized = parts.map((part) => {
    const next = part.replace(/[. ]+$/, "")
    if (next !== part) changed = true
    return next
  })
  if (!changed) return value
  return path.join(root, ...normalized.filter(Boolean))
}

const pathKey = (value: string): string => {
  if (process.platform !== "win32") return path.resolve(value)
  if (DEVICE_WIN32_PATH.test(value)) return value.toLowerCase()
  if (EXTENDED_WIN32_PATH.test(value)) {
    // `\\?\C:\dir` is the same file as `C:\dir`, but `\\?\C:\dir.` is not.
    const rest = /^[\\/]{2}\?[\\/]UNC[\\/]/i.test(value) ? `\\\\${value.slice(8)}` : value.slice(4)
    return path.resolve(rest.replace(/\//g, "\\")).toLowerCase()
  }
  return path.resolve(normalizeWin32Path(value)).toLowerCase()
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.trim() !== "" ? value.trim() : undefined

const asNumber = (value: unknown, fallback: number): number => {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : fallback
}

const asInt = (value: unknown, fallback: number): number => Math.max(1, Math.trunc(asNumber(value, fallback)))

const TRUE_VALUES = new Set(["true", "1", "yes", "on"])
const FALSE_VALUES = new Set(["false", "0", "no", "off"])

const parseBool = (value: unknown): boolean | undefined => {
  if (typeof value === "boolean") return value
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined
  if (typeof value === "string") {
    const raw = value.trim().toLowerCase()
    if (TRUE_VALUES.has(raw)) return true
    if (FALSE_VALUES.has(raw)) return false
  }
  return undefined
}

const asBool = (value: unknown, fallback: boolean): boolean => parseBool(value) ?? fallback

/** `allowSend` guards sending: an unrecognized value must not silently open the gate. */
const asAllowSend = (value: unknown): boolean => {
  if (value === undefined || value === null || value === "") return true
  const parsed = parseBool(value)
  if (parsed === undefined) {
    throw new ConfigError(`allowSend must be a boolean (true/false/1/0/yes/no/on/off), got ${JSON.stringify(value)}`)
  }
  return parsed
}

const asStorageMode = (value: unknown): StorageMode | undefined => {
  if (value === undefined || value === null || value === "") return undefined
  const raw = asString(value)?.toLowerCase()
  if (raw === "off" || raw === "metadata" || raw === "full") return raw
  throw new ConfigError(`storage must be one of: off, metadata, full; got ${JSON.stringify(value)}`)
}

export const accountKey = (username: string): string =>
  createHash("sha256").update(username.toLowerCase()).digest("hex").slice(0, 16)

export const defaultDataDir = (username: string): string => {
  const base = process.env.LOCALAPPDATA ?? path.join(homedir(), ".local", "share")
  return path.join(base, "opencode", "mail-exchange", accountKey(username))
}

/**
 * One or many accounts. `accounts: [...]` entries inherit top-level options;
 * each account always gets its own data directory (`<root>/<id>`), because a
 * shared directory would mix two SQLite indexes and FTS rows.
 */
export function resolveAccounts(options: unknown, env: NodeJS.ProcessEnv = process.env): MailConfig[] {
  const opts = (options ?? {}) as Record<string, unknown>
  const raw = Array.isArray(opts.accounts) ? opts.accounts : []
  const entries = raw.length > 0 ? raw.map((entry) => (entry ?? {}) as Record<string, unknown>) : [opts]
  const root = asString(opts.dataDir) ?? asString(env.MAIL_DATA_DIR)
  const listProvided = raw.length > 0
  const seen = new Set<string>()
  const dirs = new Map<string, string>()
  // Tool visibility is global: tools are registered once, not per account.
  const codemode = asBool(opts.codemode ?? env.MAIL_CODEMODE, false)

  return entries.map((entry, index) => {
    const id = asString(entry.id) ?? (entries.length === 1 ? "default" : `account-${index + 1}`)
    if (!ACCOUNT_ID_PATTERN.test(id)) {
      throw new ConfigError(
        `invalid account id: "${id}" (allowed: letters, digits, ".", "_", "-"; must start with a letter or digit)`,
      )
    }
    // Pass the resolved id down so `MAIL_PASSWORD_<ID>` works for auto-generated account-N ids too.
    const config = resolveConfig({ ...opts, ...entry, id, accounts: undefined }, env)
    if (seen.has(id)) throw new ConfigError(`duplicate account id: ${id}`)
    seen.add(id)

    const explicitDataDir = asString(entry.dataDir)
    const dataDir = normalizeWin32Path(
      explicitDataDir
        ? config.dataDir
        : listProvided
          ? path.join(root ?? defaultDataDir(config.username), id)
          : config.dataDir,
    )

    // Windows paths are case-insensitive: `Mail` and `mail` hit the same directory.
    const dirKey = pathKey(dataDir)
    const clash = dirs.get(dirKey)
    if (clash) {
      throw new ConfigError(`accounts "${clash}" and "${id}" resolve to the same dataDir: ${dataDir}`)
    }
    dirs.set(dirKey, id)
    return { ...config, id, dataDir, codemode }
  })
}

/**
 * Reads plugin options (`opencode.json` → plugins[].options) with env fallback.
 * Throws ConfigError with a user-facing message when required values are missing.
 */
export function resolveConfig(options: unknown, env: NodeJS.ProcessEnv = process.env): MailConfig {
  const opts = (options ?? {}) as Record<string, unknown>
  const id = asString(opts.id) ?? "default"
  const passwordEnv = `MAIL_PASSWORD_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`

  const ewsUrl = asString(opts.ewsUrl) ?? asString(env.MAIL_EWS_URL)
  if (!ewsUrl) throw new ConfigError("ewsUrl is required (plugin option `ewsUrl` or env MAIL_EWS_URL)")
  if (!/^https?:\/\//i.test(ewsUrl)) throw new ConfigError(`ewsUrl must be an absolute http(s) URL: ${ewsUrl}`)

  const username = asString(opts.username) ?? asString(env.MAIL_USER)
  if (!username) throw new ConfigError("username is required (plugin option `username` or env MAIL_USER)")
  if (!username.includes("\\")) {
    throw new ConfigError("username must include the domain, e.g. DOMAIN\\user (NTLM requires it)")
  }

  const password = asString(opts.password) ?? asString(env[passwordEnv]) ?? asString(env.MAIL_PASSWORD)
  if (!password) {
    throw new ConfigError(`password is required (plugin option \`password\`, env ${passwordEnv} or MAIL_PASSWORD)`)
  }

  const selfAddress = asString(opts.selfAddress) ?? asString(env.MAIL_SELF) ?? username.split("\\")[1]
  const caFile = asString(opts.caFile) ?? asString(env.MAIL_CA_FILE)
  if (caFile && !existsSync(caFile)) throw new ConfigError(`caFile does not exist: ${caFile}`)

  return {
    id,
    ewsUrl,
    username,
    password,
    selfAddress,
    caFile,
    storage: asStorageMode(opts.storage ?? env.MAIL_STORAGE) ?? "metadata",
    dataDir: normalizeWin32Path(asString(opts.dataDir) ?? asString(env.MAIL_DATA_DIR) ?? defaultDataDir(username)),
    maxMessages: Math.min(asInt(opts.maxMessages ?? env.MAIL_MAX_MESSAGES, 2000), 20_000),
    retentionDays: Math.min(asInt(opts.retentionDays ?? env.MAIL_RETENTION_DAYS, 365), 3650),
    maxBodyBytes: Math.min(asInt(opts.maxBodyBytes ?? env.MAIL_MAX_BODY_BYTES, 100_000), 1_000_000),
    syncIntervalMinutes: Math.min(asInt(opts.syncIntervalMinutes ?? env.MAIL_SYNC_INTERVAL_MINUTES, 5), 1440),
    allowSend: asAllowSend(opts.allowSend ?? env.MAIL_ALLOW_SEND),
    requestTimeoutMs: Math.min(asInt(opts.requestTimeoutMs ?? env.MAIL_REQUEST_TIMEOUT_MS, 30_000), 120_000),
    codemode: asBool(opts.codemode ?? env.MAIL_CODEMODE, false),
  }
}

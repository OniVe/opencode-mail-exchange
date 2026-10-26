import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import * as nodeTls from "node:tls"

interface TlsApi {
  getCACertificates?: (kind: "default" | "system" | "bundled") => string[]
  setDefaultCACertificates?: (certificates: string[]) => void
  rootCertificates?: string[]
}

export interface CaApplyIssue {
  /** Account that referenced the file. */
  id: string
  file: string
  message: string
}

export interface CaApplyResult {
  /** CA files present in the runtime trust store (deduplicated by path). */
  applied: string[]
  /** The runtime has no `tls.setDefaultCACertificates`; use `NODE_EXTRA_CA_CERTS`. */
  unsupported: boolean
  /** Files that were skipped; the remaining valid files are still applied. */
  issues: CaApplyIssue[]
}

/** file path -> sha256 of the PEM last installed, so a rotated file is re-applied. */
const installedFiles = new Map<string, string>()

const normalizePem = (pem: string): string => pem.replace(/\r\n/g, "\n").trim()
const digestOf = (pem: string): string => createHash("sha256").update(pem).digest("hex")
const isPemCertificate = (pem: string): boolean =>
  pem.includes("-----BEGIN CERTIFICATE-----") && pem.includes("-----END CERTIFICATE-----")

/**
 * Adds each account's `caFile` to the process-wide TLS trust store.
 *
 * `@ewsjs/xhr` builds its own `https.Agent` from `rejectUnauthorized` only, so an EWS
 * request has no per-request `ca` hook. Bun (and recent Node) expose
 * `tls.setDefaultCACertificates`, which applies to `node:https`/axios and therefore to
 * EWS. This keeps `caFile` useful without requiring `NODE_EXTRA_CA_CERTS` before start.
 *
 * The mutation is process-global and is not undone on plugin unload; adding a private
 * CA only extends trust. A file that cannot be read or parsed is reported in `issues`
 * without blocking the other accounts. Content hashes make a rotated PEM re-applied even
 * when the path is unchanged.
 */
export function applyCaFiles(
  accounts: ReadonlyArray<{ id: string; caFile?: string }>,
  tls: TlsApi = nodeTls as unknown as TlsApi,
): CaApplyResult {
  const files = accounts.flatMap((account) => (account.caFile ? [{ id: account.id, file: account.caFile }] : []))
  if (files.length === 0) return { applied: [], unsupported: false, issues: [] }
  if (typeof tls.setDefaultCACertificates !== "function") {
    return { applied: [], unsupported: true, issues: [] }
  }

  const detected = tls.getCACertificates?.("default")
  const bundled = tls.rootCertificates ?? []
  // A runtime that reports an empty default store must not lose the bundled roots
  // that may still be used for TLS; prefer them when they are available.
  const existing = detected && detected.length > 0 ? detected : bundled.length > 0 ? bundled : (detected ?? [])
  const canInspect = typeof tls.getCACertificates === "function"

  const issues: CaApplyIssue[] = []
  const applied: string[] = []
  const appliedSet = new Set<string>()
  const markApplied = (file: string): void => {
    if (appliedSet.has(file)) return
    appliedSet.add(file)
    applied.push(file)
  }
  const seenFiles = new Set<string>()
  const pending: Array<{ id: string; file: string; pem: string; digest: string }> = []

  for (const { id, file } of files) {
    if (seenFiles.has(file)) {
      if (appliedSet.has(file)) markApplied(file)
      continue
    }
    seenFiles.add(file)

    let pem: string
    try {
      pem = readFileSync(file, "utf8")
    } catch (error) {
      issues.push({ id, file, message: `cannot read: ${String(error)}` })
      continue
    }
    if (pem.trim() === "") {
      issues.push({ id, file, message: "file is empty" })
      continue
    }
    if (!isPemCertificate(pem)) {
      issues.push({ id, file, message: "not a PEM certificate (BEGIN/END CERTIFICATE missing)" })
      continue
    }

    const digest = digestOf(pem)
    const present = existing.some((cert) => normalizePem(cert) === normalizePem(pem))
    // Without `getCACertificates` the hash is the only signal that this path was
    // installed before; with it, a wiped runtime store is detected and re-applied.
    if (installedFiles.get(file) === digest && (!canInspect || present)) {
      markApplied(file)
      continue
    }
    pending.push({ id, file, pem, digest })
  }

  if (pending.length === 0) return { applied, unsupported: false, issues }

  const installed: typeof pending = []
  try {
    tls.setDefaultCACertificates([...existing, ...pending.map((entry) => entry.pem)])
    installed.push(...pending)
  } catch {
    // One malformed PEM can make the runtime reject the whole array. Apply the
    // remaining files one by one so a single bad account does not block the others.
    for (const entry of pending) {
      try {
        tls.setDefaultCACertificates([...existing, ...installed.map((appliedEntry) => appliedEntry.pem), entry.pem])
        installed.push(entry)
      } catch (error) {
        issues.push({ id: entry.id, file: entry.file, message: `install failed: ${String(error)}` })
      }
    }
  }

  for (const entry of installed) {
    installedFiles.set(entry.file, entry.digest)
    markApplied(entry.file)
  }
  return { applied, unsupported: false, issues }
}

/** Test seam: forget which files were already installed into the runtime trust store. */
export function resetAppliedCaFiles(): void {
  installedFiles.clear()
}

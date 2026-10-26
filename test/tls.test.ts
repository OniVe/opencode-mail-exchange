import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { applyCaFiles, resetAppliedCaFiles } from "../src/tls"

const dirs: string[] = []

const pemFile = (name: string, content: string): string => {
  const dir = mkdtempSync(path.join(tmpdir(), "mail-ca-"))
  dirs.push(dir)
  const file = path.join(dir, name)
  writeFileSync(file, content)
  return file
}

const fakeTls = (initial: string[]) => {
  const certs = [...initial]
  const calls: string[][] = []
  return {
    certs,
    calls,
    api: {
      getCACertificates: () => [...certs],
      setDefaultCACertificates: (certificates: string[]) => {
        calls.push(certificates)
        certs.splice(0, certs.length, ...certificates)
      },
      rootCertificates: [...initial],
    },
  }
}

afterEach(() => {
  resetAppliedCaFiles()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe("applyCaFiles", () => {
  test("adds the account CA to the runtime default store", () => {
    const file = pemFile("root.pem", "-----BEGIN CERTIFICATE-----\nPEM-ROOT\n-----END CERTIFICATE-----\n")
    const tls = fakeTls(["BUNDLED"])

    const result = applyCaFiles([{ id: "primary", caFile: file }], tls.api)
    expect(result).toEqual({ applied: [file], unsupported: false, issues: [] })
    expect(tls.certs).toEqual(["BUNDLED", "-----BEGIN CERTIFICATE-----\nPEM-ROOT\n-----END CERTIFICATE-----\n"])
  })

  test("installs a shared CA file once and keeps separate files", () => {
    const shared = pemFile("shared.pem", "-----BEGIN CERTIFICATE-----\nPEM-SHARED\n-----END CERTIFICATE-----")
    const second = pemFile("second.pem", "-----BEGIN CERTIFICATE-----\nPEM-SECOND\n-----END CERTIFICATE-----")
    const tls = fakeTls(["BUNDLED"])

    applyCaFiles(
      [
        { id: "one", caFile: shared },
        { id: "two", caFile: shared },
        { id: "three", caFile: second },
      ],
      tls.api,
    )
    expect(tls.calls).toHaveLength(1)
    expect(tls.calls[0]).toEqual([
      "BUNDLED",
      "-----BEGIN CERTIFICATE-----\nPEM-SHARED\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\nPEM-SECOND\n-----END CERTIFICATE-----",
    ])

    applyCaFiles([{ id: "one", caFile: shared }], tls.api)
    expect(tls.calls).toHaveLength(1)
  })

  test("reports runtimes without setDefaultCACertificates", () => {
    const file = pemFile("root.pem", "-----BEGIN CERTIFICATE-----\nPEM\n-----END CERTIFICATE-----")
    const result = applyCaFiles([{ id: "primary", caFile: file }], { rootCertificates: [] })
    expect(result).toEqual({ applied: [], unsupported: true, issues: [] })
  })

  test("skips a bad file without blocking the valid account", () => {
    const empty = pemFile("empty.pem", " \n")
    const garbage = pemFile("garbage.pem", "not a certificate")
    const valid = pemFile("valid.pem", "-----BEGIN CERTIFICATE-----\nPEM-VALID\n-----END CERTIFICATE-----")
    const tls = fakeTls(["BUNDLED"])

    const result = applyCaFiles(
      [
        { id: "empty", caFile: empty },
        { id: "garbage", caFile: garbage },
        { id: "valid", caFile: valid },
      ],
      tls.api,
    )
    expect(result.applied).toEqual([valid])
    expect(result.unsupported).toBe(false)
    expect(result.issues.map((issue) => issue.id)).toEqual(["empty", "garbage"])
    expect(result.issues[0]?.message).toContain("empty")
    expect(result.issues[1]?.message).toContain("PEM")
    expect(tls.calls).toEqual([["BUNDLED", "-----BEGIN CERTIFICATE-----\nPEM-VALID\n-----END CERTIFICATE-----"]])
  })

  test("re-applies a rotated PEM at the same path", () => {
    const file = pemFile("root.pem", "-----BEGIN CERTIFICATE-----\nPEM-OLD\n-----END CERTIFICATE-----")
    const tls = fakeTls(["BUNDLED"])

    applyCaFiles([{ id: "primary", caFile: file }], tls.api)
    expect(tls.calls).toHaveLength(1)

    writeFileSync(file, "-----BEGIN CERTIFICATE-----\nPEM-NEW\n-----END CERTIFICATE-----")
    const result = applyCaFiles([{ id: "primary", caFile: file }], tls.api)
    expect(result.applied).toEqual([file])
    expect(tls.calls).toHaveLength(2)
    expect(tls.calls[1]).toEqual([
      "BUNDLED",
      "-----BEGIN CERTIFICATE-----\nPEM-OLD\n-----END CERTIFICATE-----",
      "-----BEGIN CERTIFICATE-----\nPEM-NEW\n-----END CERTIFICATE-----",
    ])
  })

  test("re-applies a rotated PEM when the runtime cannot inspect the store", () => {
    const file = pemFile("root.pem", "-----BEGIN CERTIFICATE-----\nPEM-OLD\n-----END CERTIFICATE-----")
    const calls: string[][] = []
    const api = {
      setDefaultCACertificates: (certificates: string[]) => calls.push(certificates),
      rootCertificates: ["BUNDLED"],
    }

    applyCaFiles([{ id: "primary", caFile: file }], api)
    writeFileSync(file, "-----BEGIN CERTIFICATE-----\nPEM-NEW\n-----END CERTIFICATE-----")
    const result = applyCaFiles([{ id: "primary", caFile: file }], api)
    expect(result.applied).toEqual([file])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(["BUNDLED", "-----BEGIN CERTIFICATE-----\nPEM-NEW\n-----END CERTIFICATE-----"])
  })

  test("uses bundled roots when the default store reports empty", () => {
    const file = pemFile("root.pem", "-----BEGIN CERTIFICATE-----\nPEM-ROOT\n-----END CERTIFICATE-----")
    const calls: string[][] = []
    const result = applyCaFiles([{ id: "primary", caFile: file }], {
      getCACertificates: () => [],
      setDefaultCACertificates: (certificates: string[]) => calls.push(certificates),
      rootCertificates: ["BUNDLED"],
    })
    expect(result).toEqual({ applied: [file], unsupported: false, issues: [] })
    expect(calls).toEqual([["BUNDLED", "-----BEGIN CERTIFICATE-----\nPEM-ROOT\n-----END CERTIFICATE-----"]])
  })

  test("applies valid CAs one by one when a batch is rejected", () => {
    const bad = pemFile("bad.pem", "-----BEGIN CERTIFICATE-----\nPEM-BAD\n-----END CERTIFICATE-----")
    const valid = pemFile("valid.pem", "-----BEGIN CERTIFICATE-----\nPEM-VALID\n-----END CERTIFICATE-----")
    const certs = ["BUNDLED"]
    const calls: string[][] = []
    const api = {
      getCACertificates: () => [...certs],
      setDefaultCACertificates: (certificates: string[]) => {
        if (certificates.some((certificate) => certificate.includes("PEM-BAD"))) {
          throw new Error("ASN.1 encoding error")
        }
        calls.push(certificates)
        certs.splice(0, certs.length, ...certificates)
      },
      rootCertificates: ["BUNDLED"],
    }

    const result = applyCaFiles(
      [
        { id: "bad", caFile: bad },
        { id: "valid", caFile: valid },
      ],
      api,
    )
    expect(result.applied).toEqual([valid])
    expect(result.issues).toHaveLength(1)
    expect(result.issues[0]?.id).toBe("bad")
    expect(result.issues[0]?.message).toContain("install failed")
    expect(certs).toEqual(["BUNDLED", "-----BEGIN CERTIFICATE-----\nPEM-VALID\n-----END CERTIFICATE-----"])
  })

  test("reports a missing file instead of throwing", () => {
    const missing = path.join(tmpdir(), `mail-ca-missing-${process.pid}`, "root.pem")
    const result = applyCaFiles([{ id: "primary", caFile: missing }], fakeTls(["BUNDLED"]).api)
    expect(result.applied).toEqual([])
    expect(result.issues[0]?.message).toContain("cannot read")
  })
})

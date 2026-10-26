import { describe, expect, test } from "bun:test"
import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from "node:http"
import { ConfigurationApi } from "ews-javascript-api"
import { disposeXhrRouter, installXhrRouter, MailXhrProvider, withAccount } from "../src/xhr-router"

const ntlmType2 =
  "TlRMTVNTUAACAAAACQAJADgAAAAGgokC/Hzgw9rWstUAAAAAAAAAAJoAmgBBAAAABgOAJQAAAA9SVVNGT1JFU1QCABIAUgBVAFMARgBPAFIARQBTAFQAAQAKAFIARgBFAFgAMAAEABoAcgB1AHMAZgBvAHIAZQBzAHQALgBsAG8AYwADACYAUgBGAEUAWAAwAC4AcgB1AHMAZgBvAHIAZQBzAHQALgBsAG8AYwAFABoAcgB1AHMAZgBvAHIAZQBzAHQALgBsAG8AYwAHACAAeup4MxVl3QEAAAAA"

const credentials = (overrides: Record<string, unknown> = {}) => ({
  username: "D\\u",
  password: "p",
  timeoutMs: 5_000,
  ...overrides,
})

const listen = async (handler: (req: IncomingMessage, res: ServerResponse) => void) => {
  const server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  const port = typeof address === "object" && address ? address.port : 0
  return {
    port,
    url: (path: string) => `http://127.0.0.1:${port}${path}`,
    close: () => {
      server.closeAllConnections?.()
      server.close()
    },
  }
}

interface Seen {
  method?: string
  body: string
  headers: IncomingHttpHeaders
}

const readBody = (req: IncomingMessage, done: (body: string) => void): void => {
  const chunks: Buffer[] = []
  req.on("data", (chunk) => chunks.push(chunk))
  req.on("end", () => done(Buffer.concat(chunks).toString("utf8")))
}

const isType1 = (headers: IncomingHttpHeaders): boolean => (headers.authorization ?? "").startsWith("NTLM TlRMTVNTUAAB")

/** Minimal NTLM stub: answers type1 with a challenge, then runs `final` for type3. */
const ntlmServer = async (final: (req: IncomingMessage, res: ServerResponse, body: string) => void, seen?: Seen[]) => {
  const server = await listen((req, res) => {
    readBody(req, (body) => {
      seen?.push({ method: req.method, body, headers: req.headers })
      const auth = req.headers.authorization ?? ""
      if (!auth.startsWith("NTLM ") || isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      final(req, res, body)
    })
  })
  return server
}

const hangServer = () => listen((req) => req.resume())

/** Await a rejection; a resolved promise fails the test instead of passing it. */
const rejection = async (promise: Promise<unknown>): Promise<Record<string, unknown>> => {
  try {
    await promise
  } catch (error) {
    return error as Record<string, unknown>
  }
  throw new Error("expected the request to reject")
}

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

  test("preflight is a bodyless GET and the final request carries the SOAP body", async () => {
    const seen: Seen[] = []
    const server = await ntlmServer((_req, res, body) => {
      expect(body).toBe("<soap/>")
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.end("<ok/>")
    }, seen)

    try {
      const result = await withAccount(credentials(), () =>
        new MailXhrProvider().xhr({
          url: server.url("/EWS"),
          type: "POST",
          headers: { "Content-Type": "text/xml; charset=utf-8", Accept: "text/xml" },
          data: "<soap/>",
        }),
      )
      expect(result.status).toBe(200)
      expect(seen.map((entry) => [entry.method, entry.body])).toEqual([
        ["GET", ""],
        ["POST", "<soap/>"],
      ])
    } finally {
      server.close()
    }
  })

  test("the installed XHR api aborts an in-flight request", async () => {
    const original = ConfigurationApi.ConfigureXHR
    let installed: { xhr: MailXhrProvider["xhr"] } | undefined
    ConfigurationApi.ConfigureXHR = ((api: unknown) => {
      installed = api as { xhr: MailXhrProvider["xhr"] }
      return original.call(ConfigurationApi, api as never)
    }) as typeof ConfigurationApi.ConfigureXHR
    disposeXhrRouter()
    installXhrRouter()
    const server = await hangServer()

    const controller = new AbortController()
    const started = Date.now()
    try {
      const api = installed
      if (!api) throw new Error("provider was not installed")
      const pending = withAccount(credentials({ signal: controller.signal }), () =>
        api.xhr({ url: server.url("/hang"), type: "GET" }),
      )
      setTimeout(() => controller.abort(), 50)
      await expect(pending).rejects.toMatchObject({ code: "ERR_CANCELED" })
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      ConfigurationApi.ConfigureXHR = original
      disposeXhrRouter()
      server.close()
    }
  })
})

describe("xhr router transport", () => {
  test("non-200 responses reject with a mapped XHR object and the body", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/xml" })
      res.end("<fault>boom</fault>")
    })
    try {
      const error = (await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhr({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }),
        ),
      )) as {
        status?: number
        responseText?: string
        getResponseHeader: (name: string) => string | null
      }
      expect(error.status).toBe(500)
      expect(error.responseText).toBe("<fault>boom</fault>")
      expect(error.getResponseHeader("Content-Type")).toBe("text/xml")
    } finally {
      server.close()
    }
  })

  test("caller headers cannot break framing, host or auth", async () => {
    const seen: Seen[] = []
    const server = await ntlmServer((_req, res) => {
      res.writeHead(200)
      res.end("<ok/>")
    }, seen)
    try {
      const result = await withAccount(credentials(), () =>
        new MailXhrProvider().xhr({
          url: server.url("/EWS"),
          type: "POST",
          headers: {
            Authorization: "Bearer evil",
            "Content-Length": "999",
            "Transfer-Encoding": "chunked",
            Host: "evil.example",
          },
          data: "<soap/>",
        }),
      )
      expect(result.status).toBe(200)
      const [preflight, final] = seen
      expect(preflight.method).toBe("GET")
      expect(preflight.body).toBe("")
      expect(preflight.headers.authorization).toStartWith("NTLM TlRMTVNTUAAB")
      expect(preflight.headers.host).toBe(`127.0.0.1:${server.port}`)
      expect(preflight.headers["transfer-encoding"]).toBeUndefined()
      expect(preflight.headers["content-length"]).toBeUndefined()
      expect(final.headers.authorization).toStartWith("NTLM TlRMTVNTUAAD")
      expect(final.headers.host).toBe(`127.0.0.1:${server.port}`)
      expect(final.headers["content-length"]).toBe("7")
    } finally {
      server.close()
    }
  })

  test("a 401 on the final request retries the handshake once", async () => {
    let finals = 0
    let preflights = 0
    const server = await listen((req, res) => {
      readBody(req, () => {
        if (isType1(req.headers)) {
          preflights++
          res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
          res.end()
          return
        }
        finals++
        if (finals === 1) {
          res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
          res.end()
          return
        }
        res.writeHead(200)
        res.end("<ok/>")
      })
    })
    try {
      const result = await withAccount(credentials(), () =>
        new MailXhrProvider().xhr({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }),
      )
      expect(result.status).toBe(200)
      expect(preflights).toBe(2)
      expect(finals).toBe(2)
    } finally {
      server.close()
    }
  })

  test("a persistent 401 stops after one retry", async () => {
    let preflights = 0
    let finals = 0
    const server = await listen((req, res) => {
      readBody(req, () => {
        if (isType1(req.headers)) {
          preflights++
          res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
          res.end()
          return
        }
        finals++
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
      })
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhr({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }),
        ),
      )
      expect(error.status).toBe(401)
      expect(preflights).toBe(2)
      expect(finals).toBe(2)
    } finally {
      server.close()
    }
  })

  test("a retry does not wait for the body of the first 401", async () => {
    let finals = 0
    const server = await listen((req, res) => {
      readBody(req, () => {
        if (isType1(req.headers)) {
          res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
          res.end()
          return
        }
        finals++
        if (finals === 1) {
          res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
          res.write("<fault>slow 401 body")
          // The body never ends: the retry must not wait for it.
          return
        }
        res.writeHead(200)
        res.end("<ok/>")
      })
    })
    try {
      const result = await withAccount(credentials({ timeoutMs: 2_000 }), () =>
        new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
      )
      expect(result.status).toBe(200)
      expect(finals).toBe(2)
    } finally {
      server.close()
    }
  })

  test("the per-call deadline rejects a hung request", async () => {
    const server = await hangServer()
    const started = Date.now()
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 120 }), () =>
          new MailXhrProvider().xhr({ url: server.url("/hang"), type: "GET" }),
        ),
      )
      expect(error.code).toBe("ECONNABORTED")
      expect(String(error.message)).toContain("timeout of 120ms exceeded")
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      server.close()
    }
  })

  test("the deadline covers both NTLM round-trips", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        setTimeout(() => {
          res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
          res.end()
        }, 150)
      }
      // The final request never answers: only a per-call deadline can stop it.
    })
    const started = Date.now()
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 200 }), () =>
          new MailXhrProvider().xhr({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }),
        ),
      )
      expect(error.code).toBe("ECONNABORTED")
      expect(Date.now() - started).toBeLessThan(330)
    } finally {
      server.close()
    }
  })

  test("timeout errors carry no credentials or SOAP body", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
      }
      // Final request (type3) hangs after the challenge.
    })
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 150 }), () =>
          new MailXhrProvider().xhr({ url: server.url("/EWS"), type: "POST", data: "<soap>secret</soap>" }),
        ),
      )
      const serialized = JSON.stringify(error)
      expect(serialized).not.toContain("TlRMTV")
      expect(serialized).not.toContain("secret")
      expect(error.cause).toEqual({ message: "timeout of 150ms exceeded", code: "ECONNABORTED" })
    } finally {
      server.close()
    }
  })

  test("a multi-scheme WWW-Authenticate header still completes NTLM", async () => {
    const server = await listen((req, res) => {
      readBody(req, () => {
        if ((req.headers.authorization ?? "").startsWith("NTLM TlRMTVNTUAAD")) {
          res.writeHead(200)
          res.end("<ok/>")
          return
        }
        res.setHeader("WWW-Authenticate", ["Negotiate", `NTLM ${ntlmType2}`])
        res.writeHead(401)
        res.end()
      })
    })
    try {
      const result = await withAccount(credentials(), () =>
        new MailXhrProvider().xhr({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }),
      )
      expect(result.status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("xhrStream reports progress, does not buffer, and outlives the call deadline", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.write("<a>")
      let ticks = 0
      const timer = setInterval(() => {
        ticks++
        if (ticks < 6) {
          res.write(".")
          return
        }
        clearInterval(timer)
        res.end("</a>")
      }, 30)
    })
    const events: string[] = []
    try {
      const result = await withAccount(credentials({ timeoutMs: 120 }), () =>
        new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, (event) =>
          events.push(event.type),
        ),
      )
      expect(result.status).toBe(200)
      expect(result.responseText).toBe("")
      expect(events[0]).toBe("header")
      expect(events.at(-1)).toBe("end")
      expect(events).toContain("data")
    } finally {
      server.close()
    }
  })

  test("an idle stream is aborted by the inactivity budget", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.write("<a/>")
      // The body never ends: only the inactivity budget can settle the stream.
    })
    const started = Date.now()
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 150 }), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
        ),
      )
      expect(error.code).toBe("ECONNABORTED")
      expect(String(error.message)).toContain("timeout of 300ms exceeded")
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      server.close()
    }
  })

  test("a stream with headers and no data at all is aborted by the inactivity budget", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.flushHeaders()
      // Headers only: the initial watchdog arm must cover this case.
    })
    const started = Date.now()
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 150 }), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
        ),
      )
      const elapsed = Date.now() - started
      expect(error.code).toBe("ECONNABORTED")
      expect(String(error.message)).toContain("timeout of 300ms exceeded")
      expect(elapsed).toBeGreaterThan(200)
      expect(elapsed).toBeLessThan(560)
    } finally {
      server.close()
    }
  })

  test("a non-200 stream with headers and no body is bounded too", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(500, { "Content-Type": "text/xml", "X-Err": "1" })
      res.flushHeaders()
      // No body bytes: the initial watchdog arm still bounds the call.
    })
    const started = Date.now()
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 150 }), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
        ),
      )
      expect(error.status).toBe(500)
      expect(error.truncated).toBe(true)
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      server.close()
    }
  })

  test("a stream whose response never starts is bounded", async () => {
    const server = await listen((req) => {
      req.resume()
      // Accept the connection and never answer: the transport timeout must fire.
    })
    const started = Date.now()
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 150 }), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
        ),
      )
      expect(error.code).toBe("ECONNABORTED")
      expect(Date.now() - started).toBeLessThan(2_000)
    } finally {
      server.close()
    }
  })

  test("the first body byte may arrive later than the call timeout", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/xml" })
      setTimeout(() => res.write("<a/>"), 200)
      setTimeout(() => res.end(), 400)
    })
    try {
      const result = await withAccount(credentials({ timeoutMs: 150 }), () =>
        new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
      )
      expect(result.status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("the inactivity watchdog re-arms on every chunk", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.write("<a>")
      let ticks = 0
      const timer = setInterval(() => {
        ticks++
        if (ticks < 6) {
          res.write(".")
          return
        }
        clearInterval(timer)
        res.end("</a>")
      }, 100)
    })
    try {
      const result = await withAccount(credentials({ timeoutMs: 100 }), () =>
        new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
      )
      expect(result.status).toBe(200)
    } finally {
      server.close()
    }
  })

  test("an idle non-200 body keeps its status and the partial body", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(500, { "Content-Type": "text/xml", "X-Err": "1" })
      res.write("<fault>partial")
    })
    try {
      const error = await rejection(
        withAccount(credentials({ timeoutMs: 150 }), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
        ),
      )
      expect(error.status).toBe(500)
      expect(String(error.responseText)).toStartWith("<fault>partial")
      expect(error.truncated).toBe(true)
    } finally {
      server.close()
    }
  })

  test("xhrStream reads a non-200 body before rejecting", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(404, { "Content-Type": "text/xml" })
      res.end("<fault>missing</fault>")
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
        ),
      )
      expect(error.status).toBe(404)
      expect(error.responseText).toBe("<fault>missing</fault>")
      expect(error.truncated).toBe(false)
    } finally {
      server.close()
    }
  })

  test("a truncated non-200 body keeps its status and a partial body", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/xml" })
      res.write("<fault>")
      res.write("x".repeat(100_000))
      res.end("</fault>")
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
        ),
      )
      expect(error.status).toBe(500)
      expect(error.truncated).toBe(true)
      expect(String(error.responseText).length).toBeGreaterThan(0)
      expect(String(error.responseText).length).toBeLessThanOrEqual(64 * 1024)
    } finally {
      server.close()
    }
  })

  test("an abort during a non-200 body is reported as cancellation", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(500, { "Content-Type": "text/xml" })
      res.write("<fault>partial")
    })
    const provider = new MailXhrProvider()
    const controller = new AbortController()
    try {
      const pending = withAccount(credentials({ timeoutMs: 2_000, signal: controller.signal }), () =>
        provider.xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
      )
      setTimeout(() => controller.abort(), 100)
      const error = await rejection(pending)
      expect(error.code).toBe("ERR_CANCELED")
    } finally {
      provider.dispose()
      server.close()
    }
  })

  test("an oversized first non-200 chunk is truncated, not dropped", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/xml" })
      // One write larger than the cap: subarray must keep exactly the budget.
      res.write("y".repeat(100_000))
      res.end()
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
        ),
      )
      expect(error.status).toBe(500)
      expect(error.truncated).toBe(true)
      expect(String(error.responseText).length).toBe(64 * 1024)
    } finally {
      server.close()
    }
  })

  test("a cap on a UTF-8 boundary does not invent a replacement character", async () => {
    const body = `<fault>${"a".repeat(65_528)}Жtail`
    const server = await ntlmServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/xml" })
      res.write(body)
      res.end()
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
        ),
      )
      expect(error.status).toBe(500)
      expect(error.truncated).toBe(true)
      expect(String(error.responseText)).not.toContain("\uFFFD")
      expect(String(error.responseText).length).toBeLessThanOrEqual(64 * 1024)
    } finally {
      server.close()
    }
  })

  test("a socket close mid non-200 body keeps the status and the partial body", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(500, { "Content-Type": "text/xml" })
      res.write("<fault>partial")
      setTimeout(() => res.destroy(), 20)
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
        ),
      )
      expect(error.status).toBe(500)
      expect(String(error.responseText)).toStartWith("<fault>partial")
      expect(error.truncated).toBe(true)
    } finally {
      server.close()
    }
  })

  test("a premature close rejects the stream", async () => {
    const server = await ntlmServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.write("<a>")
      setTimeout(() => res.destroy(), 20)
    })
    try {
      const error = await rejection(
        withAccount(credentials(), () =>
          new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, () => {}),
        ),
      )
      expect(String(error.message)).toMatch(/closed before end|aborted/i)
    } finally {
      server.close()
    }
  })

  test("an external abort settles a streaming request", async () => {
    const server = await listen((req, res) => {
      req.resume()
      if (isType1(req.headers)) {
        res.writeHead(401, { "WWW-Authenticate": `NTLM ${ntlmType2}` })
        res.end()
        return
      }
      res.writeHead(200, { "Content-Type": "text/xml" })
      res.write("<a/>")
    })
    const provider = new MailXhrProvider()
    const controller = new AbortController()
    try {
      const pending = withAccount(credentials({ signal: controller.signal }), () =>
        provider.xhrStream({ url: server.url("/EWS"), type: "GET" }, () => {}),
      )
      setTimeout(() => controller.abort(), 80)
      const error = await rejection(pending)
      expect(error.code).toBe("ERR_CANCELED")
    } finally {
      provider.dispose()
      server.close()
    }
  })
})

describe("stream ownership", () => {
  test("disconnect stops only the streams of the calling account", async () => {
    const server = await hangServer()
    const provider = new MailXhrProvider()
    const normalController = new AbortController()
    try {
      const normal = withAccount(credentials({ accountId: "a", signal: normalController.signal }), () =>
        provider.xhr({ url: server.url("/normal"), type: "GET" }),
      )
      const streamA = withAccount(credentials({ accountId: "a" }), () =>
        provider.xhrStream({ url: server.url("/stream-a"), type: "GET" }, () => {}),
      )
      const streamB = withAccount(credentials({ accountId: "b" }), () =>
        provider.xhrStream({ url: server.url("/stream-b"), type: "GET" }, () => {}),
      )
      const settled = { normal: false, streamB: false }
      void normal.then(
        () => {
          settled.normal = true
        },
        () => {
          settled.normal = true
        },
      )
      void streamB.then(
        () => {
          settled.streamB = true
        },
        () => {
          settled.streamB = true
        },
      )
      await new Promise((resolve) => setTimeout(resolve, 80))

      await withAccount(credentials({ accountId: "a" }), async () => provider.disconnect())
      await rejection(streamA)

      // No ALS context: disconnect has no owner to scope to and must not touch B.
      provider.disconnect()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(settled.streamB).toBe(false)
      expect(settled.normal).toBe(false)

      normalController.abort()
      await rejection(normal)
      provider.dispose()
      await rejection(streamB)
    } finally {
      provider.dispose()
      server.close()
    }
  })
})

describe("stream progress encoding", () => {
  test("splits a UTF-8 character across chunks without replacement characters", async () => {
    const text = "<a>Ж</a>"
    const bytes = Buffer.from(text, "utf8")
    const split = bytes.indexOf(0xd0) + 1
    const server = await ntlmServer((_req, res) => {
      res.writeHead(200, { "Content-Type": "text/xml; charset=utf-8" })
      res.write(bytes.subarray(0, split))
      setTimeout(() => {
        res.write(bytes.subarray(split))
        res.end()
      }, 20)
    })
    const chunks: string[] = []
    try {
      const result = await withAccount(credentials(), () =>
        new MailXhrProvider().xhrStream({ url: server.url("/EWS"), type: "POST", data: "<soap/>" }, (event) => {
          if (event.type === "data" && event.data !== undefined) chunks.push(event.data)
        }),
      )
      expect(result.status).toBe(200)
      expect(chunks.join("")).toBe(text)
      expect(chunks.join("")).not.toContain("\uFFFD")
    } finally {
      server.close()
    }
  })
})

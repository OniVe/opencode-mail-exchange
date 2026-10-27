import { isMainThread, Worker } from "node:worker_threads"
import type { Unzipped } from "fflate"
import { fromBuffer, type ZipFile } from "yauzl"
import {
  extractDocxText,
  extractXlsxText,
  MAX_SHEET_CELLS,
  MAX_SHEET_COLUMNS,
  MAX_SHEET_ROWS,
  MAX_SHEETS,
} from "./ooxml"

/** Reading is bounded independently from sending: a huge attachment must not exhaust the plugin. */
export const MAX_READ_ATTACHMENT_BYTES = 20 * 1024 * 1024
export const MIN_MAX_CHARS = 1_000
export const DEFAULT_MAX_CHARS = 100_000
export const MAX_MAX_CHARS = 500_000
export const MAX_PDF_PAGES = 200

const MAX_ZIP_ENTRY_BYTES = 32 * 1024 * 1024
const MAX_ZIP_TOTAL_BYTES = 64 * 1024 * 1024
const MAX_ZIP_ENTRIES = 1_000

const TEXT_EXTENSIONS = new Set([
  "txt",
  "text",
  "log",
  "csv",
  "tsv",
  "md",
  "markdown",
  "json",
  "xml",
  "html",
  "htm",
  "yaml",
  "yml",
  "ini",
  "cfg",
  "conf",
  "sql",
])

export interface ExtractInput {
  filename: string
  contentType: string
  data: Uint8Array
  maxChars: number
  signal?: AbortSignal
  /** @internal Set inside the office worker so it does not spawn another worker. */
  fromWorker?: boolean
}

export interface ExtractResult {
  kind: "word" | "excel" | "pdf" | "text"
  text: string
  truncated: boolean
  pages?: number
  sheets?: string[]
  note?: string
}

interface ZipResult {
  files: Unzipped
  oversized: Set<string>
  tooMany: boolean
}

const messageOf = (error: unknown): string => {
  const typed = error as { message?: unknown; Message?: unknown } | null
  if (typeof typed?.message === "string" && typed.message !== "") return typed.message
  if (typeof typed?.Message === "string" && typed.Message !== "") return typed.Message
  return String(error)
}

const extensionOf = (filename: string): string => {
  const match = /\.([a-z0-9]{1,8})$/i.exec(filename.trim())
  return match?.[1]?.toLowerCase() ?? ""
}

const mimeOf = (contentType: string): string => contentType.split(";")[0]?.trim().toLowerCase() ?? ""

const charsetOf = (contentType: string): string | undefined =>
  /charset\s*=\s*"?([^";]+)/i.exec(contentType)?.[1]?.trim() || undefined

const decodeText = (data: Uint8Array, charset?: string): string => {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data.subarray(2))
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data.subarray(2))
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(data.subarray(3))
  }
  if (charset && charset.toLowerCase() !== "utf-8") {
    try {
      return new TextDecoder(charset as ConstructorParameters<typeof TextDecoder>[0]).decode(data)
    } catch {
      // Unknown charset: fall back to UTF-8 below.
    }
  }
  return new TextDecoder("utf-8").decode(data)
}

const isUnsafeCode = (code: number): boolean =>
  code === 0 ||
  code === 0x7f ||
  (code < 0x20 && code !== 0x09 && code !== 0x0a) ||
  (code >= 0x80 && code <= 0x9f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069)

export const sanitizeText = (value: string): string => {
  const normalized = (value.includes("\r") ? value.split("\r\n").join("\n").split("\r").join("\n") : value)
    .replace(/_x000D_/gi, "\n")
    .replace(/_x000A_/gi, "\n")
    .replace(/_x0009_/gi, "\t")
  let dirty = false
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index)
    if (isUnsafeCode(code)) {
      dirty = true
      break
    }
  }
  if (!dirty) return normalized
  const parts: string[] = []
  let start = 0
  for (let index = 0; index < normalized.length; index++) {
    const code = normalized.charCodeAt(index)
    if (!isUnsafeCode(code)) continue
    if (index > start) parts.push(normalized.slice(start, index))
    start = index + 1
  }
  if (start < normalized.length) parts.push(normalized.slice(start))
  return parts.join("")
}

const truncateChars = (value: string, maxChars: number): { text: string; truncated: boolean } => {
  let count = 0
  let end = 0
  for (const char of value) {
    if (count >= maxChars) return { text: value.slice(0, end), truncated: true }
    count++
    end += char.length
  }
  return { text: value, truncated: false }
}

export const truncateAttachmentText = (value: string, maxChars: number): { text: string; truncated: boolean } =>
  truncateChars(value, maxChars)

export const displayAttachmentName = (value: string): string => sanitizeText(value).replace(/\s+/g, " ").trim()

/** For error messages only: display form plus a hard length cap. */
export const safeAttachmentName = (value: string): string => displayAttachmentName(value).slice(0, 120)

const readZip = (data: Uint8Array, wanted: (name: string) => boolean, signal?: AbortSignal): Promise<ZipResult> =>
  new Promise((resolve, reject) => {
    if (data.length < 4 || data[0] !== 0x50 || data[1] !== 0x4b) {
      reject(new Error("cannot unpack attachment: not a ZIP archive"))
      return
    }
    let zip: ZipFile | undefined
    let settled = false
    let stopped = false
    let selected = 0
    let total = 0
    let tooMany = false
    const oversized = new Set<string>()
    const files: Unzipped = {}
    const abortError = (): Error => {
      const error = new Error("canceled")
      error.name = "AbortError"
      return error
    }
    const cleanup = (): void => signal?.removeEventListener("abort", onAbort)
    const finish = (error?: unknown): void => {
      if (settled) return
      settled = true
      cleanup()
      if (error !== undefined) {
        reject(error)
        return
      }
      resolve({ files, oversized, tooMany })
    }
    const close = (): void => {
      stopped = true
      try {
        zip?.close()
      } catch {
        // Already closed.
      }
    }
    function onAbort(): void {
      close()
      finish(abortError())
    }
    if (signal?.aborted) {
      finish(abortError())
      return
    }
    signal?.addEventListener("abort", onAbort, { once: true })

    fromBuffer(
      Buffer.from(data.buffer, data.byteOffset, data.byteLength),
      { lazyEntries: true },
      (openError, opened) => {
        if (settled) {
          opened?.close()
          return
        }
        if (openError) {
          finish(new Error(`cannot unpack attachment: ${messageOf(openError)}`))
          return
        }
        zip = opened
        zip.on("error", (error) => {
          if (settled || stopped) return
          finish(new Error(`cannot unpack attachment: ${messageOf(error)}`))
        })
        zip.on("end", () => finish())
        zip.on("entry", (entry) => {
          if (settled || stopped) return
          if (!wanted(entry.fileName)) {
            zip?.readEntry()
            return
          }
          selected++
          if (selected > MAX_ZIP_ENTRIES) {
            tooMany = true
            close()
            finish()
            return
          }
          zip?.openReadStream(entry, (streamError, stream) => {
            if (settled || stopped) return
            if (streamError) {
              finish(new Error(`cannot unpack attachment: ${messageOf(streamError)}`))
              return
            }
            const chunks: Uint8Array[] = []
            let bytes = 0
            stream.on("data", (chunk: Buffer) => {
              if (settled || stopped) return
              bytes += chunk.length
              if (bytes > MAX_ZIP_ENTRY_BYTES || total + bytes > MAX_ZIP_TOTAL_BYTES) {
                oversized.add(entry.fileName)
                close()
                finish()
                return
              }
              chunks.push(chunk)
            })
            stream.on("end", () => {
              if (settled || stopped) return
              if (signal?.aborted) {
                close()
                finish(abortError())
                return
              }
              const output = new Uint8Array(bytes)
              let offset = 0
              for (const part of chunks) {
                output.set(part, offset)
                offset += part.length
              }
              files[entry.fileName] = output
              total += bytes
              zip?.readEntry()
            })
            stream.on("error", (error) => {
              if (settled || stopped) return
              finish(new Error(`cannot unpack attachment: ${messageOf(error)}`))
            })
          })
        })
        try {
          zip.readEntry()
        } catch (error) {
          finish(new Error(`cannot unpack attachment: ${messageOf(error)}`))
        }
      },
    )
  })

const zipEntry = (zip: ZipResult, name: string): Uint8Array => {
  if (zip.oversized.has(name)) throw new Error(`attachment part is too large: ${name}`)
  const file = zip.files[name]
  if (!file) throw new Error(`attachment is missing ${name}`)
  return file
}

const extractDocx = async (data: Uint8Array, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> => {
  const zip = await readZip(data, (name) => name === "word/document.xml", signal)
  if (zip.tooMany) throw new Error("attachment has too many ZIP entries")
  const xml = decodeText(zipEntry(zip, "word/document.xml"))
  const result = extractDocxText(xml, maxChars, signal)
  return { kind: "word", text: result.text, truncated: result.truncated }
}

const extractXlsx = async (data: Uint8Array, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> => {
  const zip = await readZip(
    data,
    (name) =>
      name === "xl/workbook.xml" ||
      name === "xl/sharedStrings.xml" ||
      name === "xl/_rels/workbook.xml.rels" ||
      /^xl\/worksheets\/sheet\d+\.xml$/.test(name),
    signal,
  )
  const oversized = [...zip.oversized].find((name) => name.startsWith("xl/"))
  if (oversized) throw new Error(`attachment part is too large: ${oversized}`)
  if (zip.tooMany) throw new Error("attachment has too many ZIP entries")
  const result = extractXlsxText(zip.files, maxChars, signal)
  const notes: string[] = []
  if (result.limited || result.truncated) notes.push("Content beyond the extraction limits is omitted.")
  if (result.columnsLimited) notes.push(`Columns beyond ${MAX_SHEET_COLUMNS} are omitted.`)
  return {
    kind: "excel",
    text: result.text,
    truncated: result.truncated,
    sheets: result.sheets,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  }
}

const legacyError = (format: string, error: unknown): Error => {
  if (error instanceof Error && error.name === "AbortError") return error
  return new Error(`cannot read legacy ${format}: ${messageOf(error)}`)
}

const extractLegacyDoc = async (data: Uint8Array, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> => {
  signal?.throwIfAborted()
  try {
    const { default: WordExtractor } = await import("word-extractor")
    const extractor = new WordExtractor()
    const document = await extractor.extract(Buffer.from(data.buffer, data.byteOffset, data.byteLength))
    signal?.throwIfAborted()
    const text = document.getBody() ?? ""
    const limit = Math.max(maxChars * 4, 4096)
    return { kind: "word", text: text.slice(0, limit), truncated: text.length > limit }
  } catch (error) {
    throw legacyError("Word document", error)
  }
}

const OLE2_SIGNATURE = [0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]

const isOle2 = (data: Uint8Array): boolean =>
  data.length >= OLE2_SIGNATURE.length && OLE2_SIGNATURE.every((byte, index) => data[index] === byte)

const extractLegacyXls = async (
  data: Uint8Array,
  maxChars: number,
  signal?: AbortSignal,
  contentType = "",
): Promise<ExtractResult> => {
  signal?.throwIfAborted()
  if (!isOle2(data)) {
    const utf16 = (data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)
    if (utf16 || !data.includes(0)) {
      const text = decodeText(data, charsetOf(contentType))
      const textual = [...text].every((char) => {
        const code = char.codePointAt(0) ?? 0
        return code === 0x09 || code === 0x0a || code === 0x0d || (code >= 0x20 && code !== 0x7f)
      })
      if (textual && text.trim() !== "") {
        return {
          kind: "text",
          text,
          truncated: false,
          note: "Attachment has an .xls extension but is plain text (CSV/HTML); parsed as text.",
        }
      }
    }
    throw new Error("cannot read legacy Excel workbook: not an OLE2 compound file")
  }
  try {
    const XLSX = await import("@e965/xlsx")
    let workbook: Awaited<ReturnType<typeof XLSX.read>>
    const originalError = console.error
    const originalWarn = console.warn
    try {
      console.error = () => {}
      console.warn = () => {}
      workbook = XLSX.read(new Uint8Array(data), {
        type: "array",
        cellDates: false,
        cellText: true,
        cellNF: false,
      })
    } finally {
      console.error = originalError
      console.warn = originalWarn
    }
    const limit = Math.max(maxChars * 4, 4096)
    const sheets = workbook.SheetNames.slice(0, MAX_SHEETS)
    let truncated = workbook.SheetNames.length > MAX_SHEETS
    let limited = workbook.SheetNames.length > MAX_SHEETS
    let columnsLimited = false
    const blocks: string[] = []
    let chars = 0
    for (const name of sheets) {
      signal?.throwIfAborted()
      const sheet = workbook.Sheets[name]
      if (!sheet?.["!ref"]) {
        blocks.push(`### Sheet: ${name}`)
        continue
      }
      const range = XLSX.utils.decode_range(sheet["!ref"])
      const rowCount = Math.min(range.e.r - range.s.r + 1, MAX_SHEET_ROWS)
      const colCount = Math.min(range.e.c - range.s.c + 1, MAX_SHEET_COLUMNS)
      if (range.e.r - range.s.r + 1 > MAX_SHEET_ROWS || range.e.c - range.s.c + 1 > MAX_SHEET_COLUMNS) {
        limited = true
      }
      if (range.e.c - range.s.c + 1 > MAX_SHEET_COLUMNS) columnsLimited = true
      const rows: string[] = []
      let cells = 0
      for (let r = 0; r < rowCount; r++) {
        signal?.throwIfAborted()
        const values: string[] = []
        for (let c = 0; c < colCount; c++) {
          if (cells++ >= MAX_SHEET_CELLS) {
            limited = true
            break
          }
          const address = XLSX.utils.encode_cell({ r: range.s.r + r, c: range.s.c + c })
          const cell = sheet[address] as { v?: unknown; w?: string } | undefined
          const value = cell ? (typeof cell.w === "string" ? cell.w : cell.v == null ? "" : String(cell.v)) : ""
          values.push(value)
        }
        const row = values.join("\t")
        rows.push(row)
        chars += row.length
        if (chars >= limit || cells >= MAX_SHEET_CELLS) {
          truncated = true
          limited = true
          break
        }
      }
      blocks.push(`### Sheet: ${name}\n${rows.join("\n")}`)
      if (chars >= limit) break
    }
    const notes: string[] = []
    if (limited) notes.push("Content beyond the extraction limits is omitted.")
    if (columnsLimited) notes.push(`Columns beyond ${MAX_SHEET_COLUMNS} are omitted.`)
    return {
      kind: "excel",
      text: blocks.join("\n\n"),
      truncated,
      sheets,
      ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
    }
  } catch (error) {
    throw legacyError("Excel workbook", error)
  }
}

const PDF_WORKER_TIMEOUT_MS = 15_000

const extractPdf = (data: Uint8Array, maxChars: number, signal?: AbortSignal): Promise<ExtractResult> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      const error = new Error("canceled")
      error.name = "AbortError"
      reject(error)
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL("./pdf-worker.ts", import.meta.url), {
        workerData: { data, maxChars, maxPages: MAX_PDF_PAGES },
        // Bun ignores resourceLimits; memory is input-bound, not heap-capped (see risks.md).
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      })
    } catch (error) {
      reject(new Error(`cannot read PDF: ${messageOf(error)}`))
      return
    }
    let settled = false
    const finish = (error?: unknown, value?: ExtractResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener("abort", onAbort)
      if (error !== undefined) {
        void worker.terminate()
        reject(error)
        return
      }
      resolve(value as ExtractResult)
    }
    const timer = setTimeout(() => {
      const error = new Error(`PDF extraction timed out after ${PDF_WORKER_TIMEOUT_MS} ms`)
      finish(error)
    }, PDF_WORKER_TIMEOUT_MS)
    const onAbort = (): void => {
      const error = new Error("canceled")
      error.name = "AbortError"
      finish(error)
    }
    signal?.addEventListener("abort", onAbort, { once: true })
    worker.on(
      "message",
      (message: { ok?: boolean; text?: string; pages?: number; truncated?: boolean; error?: string }) => {
        if (message.ok === true && typeof message.text === "string") {
          finish(undefined, {
            kind: "pdf",
            text: message.text,
            truncated: message.truncated === true,
            pages: message.pages ?? 0,
          })
          return
        }
        finish(new Error(`cannot read PDF: ${message.error ?? "worker failed"}`))
      },
    )
    worker.on("error", (error) => finish(new Error(`cannot read PDF: ${messageOf(error)}`)))
    worker.on("exit", (code) => {
      if (!settled) finish(new Error(`PDF worker exited with code ${code}`))
    })
  })

const detectKind = (
  filename: string,
  contentType: string,
):
  | { kind: "word" | "excel" | "pdf" | "text" }
  | { kind: "legacy"; format: "doc" | "xls" }
  | { kind: "unsupported" } => {
  const extension = extensionOf(filename)
  const mime = mimeOf(contentType)
  if (extension === "docx" || extension === "docm" || mime.includes("wordprocessingml")) {
    return { kind: "word" }
  }
  if (extension === "xlsx" || extension === "xlsm" || mime.includes("spreadsheetml")) {
    return { kind: "excel" }
  }
  if (extension === "pdf" || mime === "application/pdf") return { kind: "pdf" }
  if (extension === "doc" || (extension === "" && mime === "application/msword")) {
    return { kind: "legacy", format: "doc" }
  }
  if (extension === "xls" || (extension === "" && mime === "application/vnd.ms-excel")) {
    return { kind: "legacy", format: "xls" }
  }
  if (mime.startsWith("text/") || TEXT_EXTENSIONS.has(extension)) return { kind: "text" }
  return { kind: "unsupported" }
}

const OFFICE_WORKER_TIMEOUT_MS = 15_000

const extractOfficeInWorker = (input: ExtractInput, maxChars: number): Promise<ExtractResult> =>
  new Promise((resolve, reject) => {
    if (input.signal?.aborted) {
      const error = new Error("canceled")
      error.name = "AbortError"
      reject(error)
      return
    }
    let worker: Worker
    try {
      worker = new Worker(new URL("./office-worker.ts", import.meta.url), {
        workerData: {
          filename: input.filename,
          contentType: input.contentType,
          data: input.data,
          maxChars,
          fromWorker: true,
        },
        // Bun ignores resourceLimits; memory is input-bound, not heap-capped (see risks.md).
        resourceLimits: { maxOldGenerationSizeMb: 256 },
      })
    } catch (error) {
      reject(error instanceof Error ? error : new Error(String(error)))
      return
    }
    let settled = false
    const finish = (error?: unknown, result?: ExtractResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", onAbort)
      if (error !== undefined) {
        void worker.terminate()
        reject(error)
        return
      }
      resolve(result as ExtractResult)
    }
    const timer = setTimeout(() => finish(new Error("attachment extraction timed out")), OFFICE_WORKER_TIMEOUT_MS)
    const onAbort = (): void => {
      const error = new Error("canceled")
      error.name = "AbortError"
      finish(error)
    }
    input.signal?.addEventListener("abort", onAbort, { once: true })
    worker.on("message", (message: { ok?: boolean; result?: ExtractResult; error?: string }) => {
      if (message.ok === true && message.result) {
        finish(undefined, message.result)
        return
      }
      finish(new Error(message.error ?? "attachment extraction failed"))
    })
    worker.on("error", (error) => finish(error instanceof Error ? error : new Error(String(error))))
    worker.on("exit", (code) => {
      if (!settled) finish(new Error(`attachment worker exited with code ${code}`))
    })
  })

export async function extractAttachmentText(input: ExtractInput): Promise<ExtractResult> {
  input.signal?.throwIfAborted()
  if (input.data.length === 0) throw new Error("attachment is empty")
  if (input.data.length > MAX_READ_ATTACHMENT_BYTES) {
    throw new Error(
      `attachment is too large to read: ${Math.ceil(input.data.length / 1024 / 1024)} MB (max ${
        MAX_READ_ATTACHMENT_BYTES / 1024 / 1024
      } MB)`,
    )
  }
  const maxChars = Math.min(Math.max(Math.trunc(input.maxChars) || DEFAULT_MAX_CHARS, MIN_MAX_CHARS), MAX_MAX_CHARS)
  const detected = detectKind(input.filename, input.contentType)
  if (detected.kind === "unsupported") {
    throw new Error(
      `unsupported attachment format: ${safeAttachmentName(input.filename)} (${safeAttachmentName(
        input.contentType || "unknown type",
      )}). Supported: .doc, .docx, .xls, .xlsx, .pdf and plain text`,
    )
  }
  if (
    !input.fromWorker &&
    isMainThread &&
    (detected.kind === "word" || detected.kind === "excel" || detected.kind === "legacy")
  ) {
    return extractOfficeInWorker(input, maxChars)
  }

  const result =
    detected.kind === "legacy"
      ? detected.format === "doc"
        ? await extractLegacyDoc(input.data, maxChars, input.signal)
        : await extractLegacyXls(input.data, maxChars, input.signal, input.contentType)
      : detected.kind === "word"
        ? await extractDocx(input.data, maxChars, input.signal)
        : detected.kind === "excel"
          ? await extractXlsx(input.data, maxChars, input.signal)
          : detected.kind === "pdf"
            ? await extractPdf(input.data, maxChars, input.signal)
            : {
                kind: "text" as const,
                text: decodeText(input.data, charsetOf(input.contentType)),
                truncated: false,
              }

  const cleaned = sanitizeText(result.text)
  input.signal?.throwIfAborted()
  const empty = cleaned.trim() === ""
  const cut = truncateChars(empty ? "" : cleaned, maxChars)
  const note = empty
    ? result.kind === "pdf"
      ? "No text layer in the PDF (a scanned PDF requires OCR)."
      : "No extractable text in the document."
    : result.note
  return {
    ...result,
    text: cut.text,
    truncated: cut.truncated || result.truncated,
    ...(note ? { note } : {}),
  }
}

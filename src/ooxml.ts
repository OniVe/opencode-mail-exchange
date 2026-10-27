import { SaxesParser } from "saxes"

/**
 * Streaming OOXML readers. Regexes with lazy `[\s\S]*?` are quadratic on hostile
 * XML (`<w:t` repeated without `>`), so the extractors use a real linear SAX parser.
 */

class StopParsing extends Error {}

const isStop = (error: unknown): boolean => error instanceof StopParsing

const abortError = (): Error => {
  const error = new Error("canceled")
  error.name = "AbortError"
  return error
}

const checkAbort = (signal: AbortSignal | undefined, counter: { value: number }): void => {
  counter.value++
  if (counter.value % 1024 !== 0) return
  if (signal?.aborted) throw abortError()
}

const invalidXml = (error: unknown): Error => {
  const message = error instanceof Error ? error.message : String(error)
  if (message.startsWith("invalid OOXML XML:")) return error instanceof Error ? error : new Error(message)
  return new Error(`invalid OOXML XML: ${message}`)
}

const parse = (xml: string, setup: (parser: SaxesParser) => void): void => {
  // Namespace-aware parsing: element identity is (uri, local name), so text in a foreign
  // namespace (DrawingML `a:t`, `x14:*`, `foo:t`) is not mistaken for document text.
  const parser = new SaxesParser({ xmlns: true })
  setup(parser)
  const typed = parser as unknown as {
    openTagHandler?: (tag: unknown) => void
    closeTagHandler?: (tag: unknown) => void
    textHandler?: (value: string) => void
  }
  const originalOpen = typed.openTagHandler
  const originalClose = typed.closeTagHandler
  if (typeof originalOpen !== "function") {
    throw new Error("invalid OOXML XML: parser handlers unavailable")
  }
  // SAX reports CDATA through a separate event; extractors treat it as text.
  const textHandler = typed.textHandler
  if (typeof textHandler === "function") parser.on("cdata", (value) => textHandler.call(parser, value))
  let depth = 0
  let rootUri: string | null = null
  let ignored = 0
  parser.on("opentag", (tag) => {
    const current = tag as unknown as NsTag
    depth++
    if (depth > 256) throw new Error("invalid OOXML XML: nesting is too deep")
    if (ignored > 0) {
      ignored++
      return
    }
    if (depth === 1) rootUri = current.uri
    // A namespaced document must not regain text from an element that resets xmlns="".
    if (depth > 1 && rootUri !== null && rootUri !== "" && current.uri === "") {
      ignored = 1
      return
    }
    originalOpen.call(parser, tag)
  })
  parser.on("closetag", (tag) => {
    depth = Math.max(0, depth - 1)
    if (ignored > 0) {
      ignored--
      return
    }
    const current = tag as unknown as NsTag
    if (depth > 0 && rootUri !== null && rootUri !== "" && current.uri === "") return
    originalClose?.call(parser, tag)
  })
  try {
    parser.write(xml).close()
  } catch (error) {
    if (isStop(error) || (error instanceof Error && error.name === "AbortError")) throw error
    throw invalidXml(error)
  }
}

export interface DocxText {
  text: string
  truncated: boolean
}

interface NsAttribute {
  name: string
  prefix: string
  local: string
  uri: string
  value: string
}

interface NsTag {
  name: string
  local: string
  uri: string
  attributes: Record<string, NsAttribute>
}

const asTag = (tag: unknown): NsTag => tag as NsTag

const XMLNS_NS = "http://www.w3.org/2000/xmlns/"
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006"
const REL_ATTR_NS = new Set([
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
])

const WORD_NS = new Set([
  "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
  "http://purl.oclc.org/ooxml/wordprocessingml/main",
  "",
])

const SHEET_NS = new Set([
  "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
  "http://purl.oclc.org/ooxml/spreadsheetml/main",
  "",
])

const RELS_ELEMENT_NS = new Set([
  "http://schemas.openxmlformats.org/package/2006/relationships",
  "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
  "http://purl.oclc.org/ooxml/package/relationships",
  "http://purl.oclc.org/ooxml/officeDocument/relationships",
  "",
])

const inNamespace = (tag: NsTag, namespaces: Set<string>): boolean => namespaces.has(tag.uri)

const attr = (tag: NsTag, local: string): string | undefined => {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.local !== local || attribute.uri === XMLNS_NS) continue
    // Unprefixed attributes carry no namespace; a prefixed attribute on a prefixed
    // document (e.g. `x:r` on `x:c`) inherits the element's namespace and is still
    // the same attribute for extraction purposes.
    if (attribute.prefix === "" || attribute.uri === tag.uri) return attribute.value
  }
  return undefined
}

const attrNs = (tag: NsTag, local: string, uris: Set<string>): string | undefined => {
  for (const attribute of Object.values(tag.attributes)) {
    if (attribute.local === local && uris.has(attribute.uri)) return attribute.value
  }
  return undefined
}

const CELL_SEPARATOR = "\u0001"

export const extractDocxText = (xml: string, maxChars: number, signal?: AbortSignal): DocxText => {
  let text = ""
  let inText = 0
  let inRun = 0
  let meaningful = 0
  let truncated = false
  const counter = { value: 0 }
  const limit = Math.max(maxChars * 4, 4096)
  const stop = (): never => {
    truncated = true
    throw new StopParsing()
  }
  const append = (value: string): void => {
    if (value === "") return
    // Only real text counts as "this branch produced text": structural \n/\t and
    // whitespace-only runs must not suppress a later mc:Choice / mc:Fallback.
    if (value !== CELL_SEPARATOR && /[^\s\p{Cf}]/u.test(value)) meaningful += value.length
    const remaining = limit - text.length
    if (remaining <= 0) stop()
    text += value.length > remaining ? value.slice(0, remaining) : value
    if (text.length >= limit) stop()
  }

  try {
    parse(xml, (parser) => {
      let skip = 0
      // mc:AlternateContent repeats the same visible text in mc:Choice / mc:Fallback and may
      // carry several mc:Choice branches. The first Choice that yields text wins; later
      // Choice branches and the Fallback are then skipped.
      const alternates: Array<{ start: number; textStart: number; produced: boolean }> = []
      parser.on("opentag", (raw) => {
        checkAbort(signal, counter)
        const tag = asTag(raw)
        if (skip > 0) {
          skip++
          return
        }
        if (tag.uri === MC_NS) {
          if (tag.local === "AlternateContent") alternates.push({ start: 0, textStart: 0, produced: false })
          else if (tag.local === "Choice") {
            const current = alternates.at(-1)
            if (!current) return
            if (current.produced) {
              skip = 1
              return
            }
            current.start = meaningful
            current.textStart = text.length
          } else if (tag.local === "Fallback") {
            const current = alternates.at(-1)
            if (current?.produced) skip = 1
          }
          return
        }
        if (!inNamespace(tag, WORD_NS)) return
        if (tag.local === "r") inRun++
        else if (tag.local === "t") inText++
        else if (tag.local === "tab" && inRun > 0) append("\t")
        else if ((tag.local === "br" || tag.local === "cr") && inRun > 0) append("\n")
      })
      parser.on("text", (value) => {
        if (skip > 0) return
        if (inText > 0 && inRun > 0) append(value)
      })
      parser.on("closetag", (raw) => {
        const tag = asTag(raw)
        if (skip > 0) {
          skip--
          return
        }
        if (tag.uri === MC_NS) {
          if (tag.local === "Choice") {
            const current = alternates.at(-1)
            if (!current) return
            if (meaningful > current.start) current.produced = true
            else if (text.length > current.textStart) text = text.slice(0, current.textStart)
          } else if (tag.local === "AlternateContent" && alternates.length > 0) alternates.pop()
          return
        }
        if (!inNamespace(tag, WORD_NS)) return
        if (tag.local === "r") inRun = Math.max(0, inRun - 1)
        else if (tag.local === "t") inText = Math.max(0, inText - 1)
        else if (tag.local === "p") append("\n")
        else if (tag.local === "tc") append(CELL_SEPARATOR)
        else if (tag.local === "tr") {
          // No trailing separator after the last cell of a row.
          if (text.endsWith(CELL_SEPARATOR)) text = text.slice(0, -1)
          append("\n")
        }
      })
    })
  } catch (error) {
    if (!isStop(error)) throw error
  }

  // Linear cleanup: no `[ \t]+\n` regex. The sentinel marks a table-cell boundary;
  // real `w:tab` characters stay intact.
  let normalized = ""
  let pendingSpace = ""
  let newlines = 0
  for (const char of text) {
    if (char === " " || char === "\t") {
      pendingSpace += char
      continue
    }
    if (char === "\n") {
      pendingSpace = ""
      if (newlines < 2) normalized += "\n"
      newlines++
      continue
    }
    if (char === CELL_SEPARATOR) {
      pendingSpace = ""
      if (normalized.endsWith("\n")) normalized = normalized.slice(0, -1)
      normalized += "\t"
      newlines = 0
      continue
    }
    if (pendingSpace !== "") {
      normalized += pendingSpace
      pendingSpace = ""
    }
    normalized += char
    newlines = 0
  }
  return { text: normalized, truncated }
}

export interface XlsxText {
  text: string
  sheets: string[]
  truncated: boolean
  limited: boolean
  columnsLimited: boolean
}

interface SheetName {
  name: string
  relId?: string
}

const columnIndex = (ref: string): number => {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1]?.toUpperCase() ?? ""
  let value = 0
  for (const char of letters) value = value * 26 + (char.charCodeAt(0) - 64)
  return Math.max(0, value - 1)
}

const parseWorkbook = (xml: string, signal?: AbortSignal): SheetName[] => {
  const sheets: SheetName[] = []
  const counter = { value: 0 }
  parse(xml, (parser) => {
    parser.on("opentag", (raw) => {
      checkAbort(signal, counter)
      const tag = asTag(raw)
      if (tag.local !== "sheet" || !inNamespace(tag, SHEET_NS)) return
      const relId = attrNs(tag, "id", REL_ATTR_NS)
      sheets.push({
        name: attr(tag, "name") ?? `Sheet ${sheets.length + 1}`,
        ...(relId ? { relId } : {}),
      })
    })
  })
  return sheets
}

const parseRelationships = (xml: string, signal?: AbortSignal): Map<string, string> => {
  const map = new Map<string, string>()
  const counter = { value: 0 }
  parse(xml, (parser) => {
    parser.on("opentag", (raw) => {
      checkAbort(signal, counter)
      const tag = asTag(raw)
      if (tag.local !== "Relationship" || !inNamespace(tag, RELS_ELEMENT_NS)) return
      const id = attr(tag, "Id")
      const target = attr(tag, "Target")
      if (id && target) map.set(id, target)
    })
  })
  return map
}

const normalizeTarget = (target: string): string => {
  const clean = target.replace(/^\/+/, "")
  if (clean.startsWith("xl/")) return clean
  if (clean.startsWith("../")) return `xl/${clean.replace(/^(\.\.\/)+/, "")}`
  return `xl/${clean}`
}

const sheetFilesFrom = (
  workbook: SheetName[],
  rels: Map<string, string>,
  files: string[],
): Array<{ name: string; file: string }> => {
  const sheets: Array<{ name: string; file: string }> = []
  for (const sheet of workbook) {
    const fromRel = sheet.relId ? rels.get(sheet.relId) : undefined
    const file = fromRel ? normalizeTarget(fromRel) : files[sheets.length]
    if (file) sheets.push({ name: sheet.name, file })
  }
  if (sheets.length > 0) return sheets
  return files.map((file, index) => ({ name: `Sheet ${index + 1}`, file }))
}

export const MAX_SHEETS = 50
export const MAX_SHEET_ROWS = 5_000
export const MAX_SHEET_CELLS = 100_000
export const MAX_SHEET_COLUMNS = 200

const MAX_SHARED_STRINGS = 200_000

const parseSharedStrings = (
  xml: string,
  limit: number,
  signal?: AbortSignal,
): { values: string[]; truncated: boolean } => {
  const values: string[] = []
  const counter = { value: 0 }
  let current: string | null = null
  let inText = 0
  let inPhonetic = 0
  let total = 0
  let truncated = false
  const stop = (): never => {
    truncated = true
    throw new StopParsing()
  }
  try {
    parse(xml, (parser) => {
      parser.on("opentag", (raw) => {
        checkAbort(signal, counter)
        const tag = asTag(raw)
        if (!inNamespace(tag, SHEET_NS)) return
        if (tag.local === "si") current = ""
        else if (tag.local === "rPh") inPhonetic++
        else if (tag.local === "t" && current !== null && inPhonetic === 0) inText++
      })
      parser.on("text", (value) => {
        if (current === null || inText <= 0 || inPhonetic > 0) return
        current += value
        total += value.length
        if (total >= limit) stop()
      })
      parser.on("closetag", (raw) => {
        const tag = asTag(raw)
        if (!inNamespace(tag, SHEET_NS)) return
        if (tag.local === "t") inText = Math.max(0, inText - 1)
        else if (tag.local === "rPh") inPhonetic = Math.max(0, inPhonetic - 1)
        else if (tag.local === "si") {
          values.push(current ?? "")
          current = null
          if (values.length >= MAX_SHARED_STRINGS) stop()
        }
      })
    })
  } catch (error) {
    if (!isStop(error)) throw error
  }
  return { values, truncated }
}

interface CellState {
  type: string
  ref: string
  value: string
  inline: string
  inValue: boolean
  inText: number
  inPhonetic: number
}

const cellValue = (cell: CellState, shared: string[]): string => {
  if (cell.type === "s") {
    const index = Number.parseInt(cell.value, 10)
    return Number.isInteger(index) ? (shared[index] ?? "") : ""
  }
  if (cell.type === "inlineStr") return cell.inline
  if (cell.type === "b") return cell.value === "1" ? "TRUE" : "FALSE"
  return cell.value
}

const parseSheet = (
  xml: string,
  shared: string[],
  maxChars: number,
  signal?: AbortSignal,
): { rows: string[]; chars: number; truncated: boolean; limited: boolean; columnsLimited: boolean } => {
  const rows: string[] = []
  const counter = { value: 0 }
  const limit = Math.max(maxChars * 4, 4096)
  let row: string[] = []
  let sequential = 0
  let cell: CellState | null = null
  let cells = 0
  let chars = 0
  let inRow = false
  let truncated = false
  let limited = false
  let columnsLimited = false
  const stop = (): never => {
    truncated = true
    throw new StopParsing()
  }

  try {
    parse(xml, (parser) => {
      parser.on("opentag", (raw) => {
        checkAbort(signal, counter)
        const tag = asTag(raw)
        if (!inNamespace(tag, SHEET_NS)) return
        if (tag.local === "row") {
          row = []
          sequential = 0
          inRow = true
        } else if (tag.local === "c") {
          cell = {
            type: attr(tag, "t") ?? "n",
            ref: attr(tag, "r") ?? "",
            value: "",
            inline: "",
            inValue: false,
            inText: 0,
            inPhonetic: 0,
          }
        } else if (tag.local === "v" && cell) {
          cell.inValue = true
        } else if (tag.local === "rPh" && cell) {
          cell.inPhonetic++
        } else if (tag.local === "t" && cell && cell.inPhonetic === 0) {
          cell.inText++
        }
      })
      parser.on("text", (value) => {
        if (!cell || cell.inPhonetic > 0) return
        if (cell.inValue) cell.value += value
        if (cell.inText > 0) cell.inline += value
      })
      parser.on("closetag", (raw) => {
        const tag = asTag(raw)
        if (!inNamespace(tag, SHEET_NS)) return
        if (tag.local === "v" && cell) cell.inValue = false
        else if (tag.local === "rPh" && cell) cell.inPhonetic = Math.max(0, cell.inPhonetic - 1)
        else if (tag.local === "t" && cell) cell.inText = Math.max(0, cell.inText - 1)
        else if (tag.local === "c" && cell) {
          const column = cell.ref ? columnIndex(cell.ref) : sequential
          sequential = column + 1
          if (column >= MAX_SHEET_COLUMNS) {
            columnsLimited = true
            cell = null
            return
          }
          const value = cellValue(cell, shared)
          row[column] = value
          cells++
          chars += value.length
          if (cells >= MAX_SHEET_CELLS || chars >= limit) {
            limited = true
            stop()
          }
          cell = null
        } else if (tag.local === "row") {
          if (!inRow) return
          rows.push(row.map((value) => value ?? "").join("\t"))
          inRow = false
          if (rows.length >= MAX_SHEET_ROWS) {
            limited = true
            stop()
          }
        }
      })
    })
  } catch (error) {
    if (!isStop(error)) throw error
  }
  return { rows, chars, truncated, limited, columnsLimited }
}

const decodeXmlBytes = (data: Uint8Array): string => {
  if (data.length >= 2 && data[0] === 0xff && data[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(data.subarray(2))
  }
  if (data.length >= 2 && data[0] === 0xfe && data[1] === 0xff) {
    return new TextDecoder("utf-16be").decode(data.subarray(2))
  }
  if (data.length >= 3 && data[0] === 0xef && data[1] === 0xbb && data[2] === 0xbf) {
    return new TextDecoder("utf-8").decode(data.subarray(3))
  }
  return new TextDecoder("utf-8").decode(data)
}

export const extractXlsxText = (
  entries: Record<string, Uint8Array>,
  maxChars: number,
  signal?: AbortSignal,
): XlsxText => {
  const sheetFiles = Object.keys(entries)
    .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/.test(name))
    .sort((a, b) => {
      const left = Number.parseInt(/sheet(\d+)\.xml$/.exec(a)?.[1] ?? "0", 10)
      const right = Number.parseInt(/sheet(\d+)\.xml$/.exec(b)?.[1] ?? "0", 10)
      return left - right
    })
  if (sheetFiles.length === 0) throw new Error("attachment has no worksheets")

  const decode = (name: string): string => {
    const file = entries[name]
    if (!file) throw new Error(`attachment is missing ${name}`)
    return decodeXmlBytes(file)
  }
  const workbook = entries["xl/workbook.xml"] ? parseWorkbook(decode("xl/workbook.xml"), signal) : []
  const rels = entries["xl/_rels/workbook.xml.rels"]
    ? parseRelationships(decode("xl/_rels/workbook.xml.rels"), signal)
    : new Map<string, string>()
  const allSheets = sheetFilesFrom(workbook, rels, sheetFiles)
  const sheets = allSheets.slice(0, MAX_SHEETS)
  const limitedBySheets = allSheets.length > MAX_SHEETS
  const shared = entries["xl/sharedStrings.xml"]
    ? parseSharedStrings(decode("xl/sharedStrings.xml"), Math.max(maxChars * 4, 4096), signal)
    : { values: [], truncated: false }

  const blocks: string[] = []
  const limit = Math.max(maxChars * 4, 4096)
  let totalChars = 0
  let truncated = shared.truncated
  let limited = limitedBySheets || shared.truncated
  let columnsLimited = false
  for (const sheet of sheets) {
    const file = entries[sheet.file]
    if (!file) continue
    const parsed = parseSheet(decodeXmlBytes(file), shared.values, maxChars, signal)
    truncated ||= parsed.truncated
    limited ||= parsed.limited
    columnsLimited ||= parsed.columnsLimited
    const block = `### Sheet: ${sheet.name}\n${parsed.rows.join("\n")}`
    blocks.push(block)
    totalChars += block.length
    if (totalChars >= limit) {
      truncated = true
      limited = true
      break
    }
    if (parsed.limited) break
  }
  return {
    text: blocks.join("\n\n"),
    sheets: sheets.map((sheet) => sheet.name),
    truncated,
    limited,
    columnsLimited,
  }
}

import { Database } from "bun:sqlite"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { MailConfig } from "./config"
import type { MessageDetail, MessageSummary } from "./types"

interface MessageRow {
  id: string
  folder_id: string | null
  subject: string
  from_addr: string
  to_addrs: string
  cc_addrs: string
  received: string
  received_ts: number
  is_read: number
  has_attachments: number
  preview: string
  conversation_id: string | null
  deleted: number
  recipients_fetched: number
}

const SCHEMA = `
create table if not exists messages (
  id text primary key,
  folder_id text,
  subject text not null default '',
  from_addr text not null default '',
  to_addrs text not null default '',
  cc_addrs text not null default '',
  received text not null default '',
  received_ts integer not null default 0,
  is_read integer not null default 0,
  has_attachments integer not null default 0,
  preview text not null default '',
  conversation_id text,
  deleted integer not null default 0,
  recipients_fetched integer not null default 0,
  updated_ts integer not null default 0
);
create index if not exists idx_messages_folder on messages(folder_id, received_ts desc);
create index if not exists idx_messages_received on messages(received_ts desc);
create table if not exists bodies (
  message_id text primary key,
  body text not null,
  body_type text not null,
  truncated integer not null default 0,
  fetched_ts integer not null
);
create table if not exists sync_state (
  folder_id text primary key,
  token text not null,
  last_sync_ts integer not null
);
create virtual table if not exists messages_fts using fts5(
  msg_id unindexed,
  subject,
  from_addr,
  preview,
  body,
  tokenize = 'unicode61'
);
`

/** Columns added after v0.1: `create table if not exists` does not touch existing databases. */
const ADDED_COLUMNS = [
  "alter table messages add column cc_addrs text not null default ''",
  // Distinguishes "bind returned an empty list" from "recipients never fetched".
  "alter table messages add column recipients_fetched integer not null default 0",
]

const stripControlChars = (value: string): string => {
  let clean = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) clean += " "
    else clean += char
  }
  return clean
}

interface FtsGroup {
  tokens: string[]
  primaryPrefixAll: boolean
  fallbackPrefixAll: boolean
}

interface DateTimeParts {
  year: string
  month: string
  day: string
  hour?: string
  minute?: string
  second?: string
  hminute?: string
  zone?: "Z" | "offset"
  offset?: string
  mode: "all" | "hour" | "hourZ" | "hourH"
  /** A single-digit hour is ambiguous with a count ("5 items"), so text matches too. */
  ambiguousHour?: boolean
}

const HOURS = [
  ...Array.from({ length: 24 }, (_, hour) => String(hour).padStart(2, "0")),
  ...Array.from({ length: 10 }, (_, hour) => String(hour)),
]

/** ISO 8601 allows 24:00 as end-of-day, but only with zero minutes, seconds and fraction. */
const isAllowedHour = (
  hour: number,
  minute?: string,
  second?: string,
  hminute?: string,
  fraction?: string,
): boolean => {
  if (hour < 24) return true
  if (hour !== 24) return false
  return (
    minute === "00" &&
    (second === undefined || second === "00") &&
    hminute === undefined &&
    (fraction === undefined || Number(fraction) === 0)
  )
}

/** Parses a date or date-time query; invalid hours (24+) are not treated as dates. */
const parseDateTime = (value: string): DateTimeParts | undefined => {
  const match =
    /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[Tt](\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?|[Hh](\d{2}))?([Zz]|[+-]\d{2}:?\d{2})?|[Zz])?$/.exec(
      value,
    )
  if (!match) return undefined
  const hour = match[4]
  const minute = match[5]
  const seconds = match[6]
  const fraction = match[7]
  const hminute = match[8]
  if (hour !== undefined && !isAllowedHour(Number(hour), minute, seconds, hminute, fraction)) return undefined
  if (minute !== undefined && Number(minute) > 59) return undefined
  if (seconds !== undefined && Number(seconds) > 59) return undefined
  if (hminute !== undefined && Number(hminute) > 59) return undefined
  const mode = hour === undefined ? "all" : hminute !== undefined ? "hourH" : match[9] !== undefined ? "hourZ" : "hour"
  const zoneRaw = match[9]
  const zone = zoneRaw === undefined ? undefined : /^[Zz]$/.test(zoneRaw) ? "Z" : "offset"
  const offset = zone === "offset" ? zoneRaw.replace(":", "") : undefined
  return { year: match[1], month: match[2], day: match[3], hour, minute, second: seconds, hminute, zone, offset, mode }
}

/** Removes trailing punctuation and zone/offset suffixes in one linear pass. */
const stripTimeSuffixes = (value: string): string => {
  const isDigit = (index: number): boolean => {
    const code = value.charCodeAt(index)
    return code >= 48 && code <= 57
  }
  let end = value.length
  while (end > 0) {
    const char = value[end - 1] ?? ""
    if (char === "." || char === "," || char === ";" || char === ":" || char === "!" || char === "?") {
      end -= 1
      continue
    }
    if (char === "Z" || char === "z") {
      end -= 1
      continue
    }
    const sign = value[end - 6]
    if (
      end >= 6 &&
      (sign === "+" || sign === "-") &&
      isDigit(end - 5) &&
      isDigit(end - 4) &&
      value[end - 3] === ":" &&
      isDigit(end - 2) &&
      isDigit(end - 1)
    ) {
      end -= 6
      continue
    }
    const shortSign = value[end - 5]
    if (
      end >= 5 &&
      (shortSign === "+" || shortSign === "-") &&
      isDigit(end - 4) &&
      isDigit(end - 3) &&
      isDigit(end - 2) &&
      isDigit(end - 1)
    ) {
      end -= 5
      continue
    }
    break
  }
  return value.slice(0, end)
}

/** Date-only or date-time query, including the whitespace form "2026 10 23". */
const parseSearchDate = (query: string): { date: DateTimeParts; text?: string; invalid?: boolean } | undefined => {
  // Sentence punctuation after a valid time is not a text query: "10:00:30,".
  // Other trailing punctuation is left alone ("... report.").
  const trimmedQuery = query.trim()
  const sentenceTrimmed = trimmedQuery.replace(/\s*[.,;!?]+$/, "")
  const normalized = /(?:[Tt]|\s)\d{1,2}(?::\d{2}(?::\d{2}(?:\.\d+)?)?|[Hh]\d{2})(?:[Zz]|[+-]\d{2}:?\d{2})?$/.test(
    sentenceTrimmed,
  )
    ? sentenceTrimmed
    : trimmedQuery
  const compact = parseDateTime(normalized)
  if (compact) return { date: compact }
  // A malformed time component ("T10:0", "T10:00:0", "T24:00.500") is not a date-time,
  // but only when it is the whole query: date+text may contain such a literal. Trailing
  // punctuation and a zone/offset are stripped in any order ("10:00:0,Z"), and a
  // one-digit hour with a one-digit minute is a ratio ("1:2"), not a broken time.
  const malformedProbe = stripTimeSuffixes(normalized).trimEnd()
  const malformedTime =
    /^\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[Tt]|\s+)(?:\d{2}:\d(?!\d)(?:[.:]\d*)?|\d{1,2}:\d{2}::[0-9.]*|\d{1,2}:\d{2}:\.\d*|\d{1,2}:\d{2}\.\d+|\d{1,2}:\d{2}:\d(?!\d)(?:\.\d+)?)(?:[Zz]|[+-]\d{2}:?\d{2})?$/.test(
      malformedProbe,
    )
  if (malformedTime) {
    const base = /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2})/.exec(normalized)?.[1]
    const baseDate = base ? parseDateTime(base) : undefined
    if (baseDate) return { date: baseDate, invalid: true }
  }
  const compactPrefix =
    /^(\d{4}[-/.]\d{1,2}[-/.]\d{1,2}(?:[Tt]\d{1,2}(?::\d{2}(?::\d{2}(?:\.[0-9]+)?)?|[Hh]\d{2})?(?:[Zz]|[+-]\d{2}:?\d{2})?)?)(?:\s+(.*))?$/.exec(
      normalized,
    )
  if (compactPrefix) {
    const date = parseDateTime(compactPrefix[1])
    if (!date) {
      // The prefix looked like a date-time but had invalid components: report an
      // impossible query instead of falling back to a literal text search.
      const baseDate = parseDateTime(compactPrefix[1].replace(/[Tt].*$/, ""))
      return baseDate ? { date: baseDate, invalid: true } : undefined
    }
    const rest = compactPrefix[2]?.trim()
    const timeRest = rest
      ? /^(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?|[Hh](\d{2}))?([Zz]|[+-]\d{2}:?\d{2})?(?:\s+(.*))?$/.exec(rest)
      : undefined
    if (
      timeRest &&
      (timeRest[2] !== undefined ||
        timeRest[3] !== undefined ||
        timeRest[4] !== undefined ||
        timeRest[5] !== undefined ||
        timeRest[6] !== undefined ||
        /^\d{1,2}$/.test(rest ?? ""))
    ) {
      const hour = timeRest[1]
      const minute = timeRest[2]
      const seconds = timeRest[3]
      const fraction = timeRest[4]
      const hminute = timeRest[5]
      const zoneRaw = timeRest[6]
      if (!isAllowedHour(Number(hour), minute, seconds, hminute, fraction)) return { date, invalid: true }
      if (minute !== undefined && Number(minute) > 59) return { date, invalid: true }
      if (seconds !== undefined && Number(seconds) > 59) return { date, invalid: true }
      if (hminute !== undefined && Number(hminute) > 59) return { date, invalid: true }
      const zone = zoneRaw === undefined ? undefined : /^[Zz]$/.test(zoneRaw) ? "Z" : "offset"
      const offset = zone === "offset" ? zoneRaw?.replace(":", "") : undefined
      return {
        date: {
          ...date,
          hour,
          minute,
          second: seconds,
          hminute,
          zone,
          offset,
          mode: hminute !== undefined ? "hourH" : zone !== undefined ? "hourZ" : "hour",
        },
        text: timeRest[7]?.trim() || undefined,
      }
    }
    // A single or double-digit hour followed by text is still a time filter:
    // "2026-10-23 9 report" and "2026-10-23 10 report" both work.
    const leadingHour = /^(\d{1,2})(?:\s+(.*))?$/.exec(rest ?? "")
    if (leadingHour && Number(leadingHour[1]) <= 23) {
      return {
        date: {
          ...date,
          hour: leadingHour[1],
          mode: "hour",
          // "5 items" may be a count, not a time: text matches stay valid too.
          ambiguousHour: leadingHour[1].length === 1,
        },
        text: leadingHour[2]?.trim() || undefined,
      }
    }
    return { date, text: rest || undefined }
  }
  const spaced = /^(\d{4})\s+(\d{1,2})\s+(\d{1,2})(?:\s+[Tt]?(\d{1,2})(?::(\d{2}))?)?(?:\s+(.*))?$/.exec(normalized)
  if (!spaced) return undefined
  const hour = spaced[4]
  if (hour !== undefined && !isAllowedHour(Number(hour), spaced[5])) return undefined
  const minute = spaced[5]
  if (minute !== undefined && Number(minute) > 59) return undefined
  return {
    date: {
      year: spaced[1],
      month: spaced[2],
      day: spaced[3],
      hour,
      minute,
      mode: hour === undefined ? "all" : "hour",
    },
    text: spaced[6]?.trim() || undefined,
  }
}

/** True when the query asks for a date-time that cannot exist (used to skip EWS). */
export const isImpossibleDateQuery = (query: string): boolean => parseSearchDate(query)?.invalid === true

interface ParsedTime {
  hour?: string
  minute?: string
  second?: string
  hminute?: string
  zone?: "Z" | "offset"
  offset?: string
}

/** Reads an ISO time suffix; a letter immediately after it invalidates the match. */
const parseTimeSuffix = (rest: string): ParsedTime | undefined => {
  if (/^[Zz]/.test(rest)) {
    const next = rest[1] ?? ""
    if (/[A-Za-z0-9]/.test(next)) return undefined
    return { zone: "Z" }
  }
  const match =
    /^[Tt ]?(\d{1,2})(?::(\d{2})(?::(\d{2})(?:\.(\d+))?)?|\.(\d{2})|[Hh](\d{2}))?([Zz]|[+-]\d{2}:?\d{2})?/.exec(rest)
  if (!match) return undefined
  const hour = Number(match[1])
  const minute = match[2] ?? match[5]
  const hminute = match[6]
  const seconds = match[3]
  const fraction = match[4]
  if (!isAllowedHour(hour, minute, seconds, hminute, fraction)) return undefined
  if (minute !== undefined && Number(minute) > 59) return undefined
  if (hminute !== undefined && Number(hminute) > 59) return undefined
  if (seconds !== undefined && Number(seconds) > 59) return undefined
  const boundary = rest[match[0].length] ?? ""
  if (/[A-Za-z0-9]/.test(boundary)) return undefined
  // "T10:00:0" (one-digit seconds) and "T24:00.500" (fraction without seconds) are
  // malformed. Ordinary punctuation after a minute-precision time ("T10:00. next",
  // "T10:00: agenda") is not: only punctuation followed directly by a digit is.
  if ((boundary === ":" || boundary === ".") && seconds === undefined) {
    let index = match[0].length + 1
    while (index < rest.length && !/[0-9A-Za-z\s]/.test(rest[index] ?? "")) index++
    if (/[0-9]/.test(rest[index] ?? "")) return undefined
  }
  const zoneRaw = match[7]
  const zone = zoneRaw === undefined ? undefined : /^[Zz]$/.test(zoneRaw) ? "Z" : "offset"
  const offset = zone === "offset" ? zoneRaw.replace(":", "") : undefined
  return { hour: match[1], minute, second: seconds, hminute, zone, offset }
}

const DATE_TEXT = /(?<!\d)(\d{4})[-/. ](\d{1,2})[-/. ](\d{1,2})(?!\d)/g

/** True when the text contains the requested date, with a valid time suffix if present. */
const matchesDateText = (text: string, query: DateTimeParts): boolean => {
  DATE_TEXT.lastIndex = 0
  let match = DATE_TEXT.exec(text)
  while (match) {
    if (Number(match[1]) !== Number(query.year)) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (Number(match[2]) !== Number(query.month)) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (Number(match[3]) !== Number(query.day)) {
      match = DATE_TEXT.exec(text)
      continue
    }
    const rest = text.slice(match.index + match[0].length)
    if (query.hour === undefined) {
      if (rest === "") return true
      if (/^\d/.test(rest)) {
        match = DATE_TEXT.exec(text)
        continue
      }
      // A date followed by whitespace is a hit: "2026-10-23 10:00", "2026-10-23 5 items".
      // A clock-shaped numeric token must still parse: "10:00::0" is not 10:00.
      // "1:2" is a ratio (one-digit hour and minute), and "10:00am"/"1.2" are left alone.
      if (/^\s/.test(rest)) {
        const token = stripTimeSuffixes(rest.trimStart().split(/\s/, 1)[0] ?? "")
        const clockLike = /^\d{2}:\d/.test(token) || /^\d{1,2}:\d{2}/.test(token)
        if (clockLike && /^[0-9:.]+$/.test(token) && !parseTimeSuffix(` ${token}`)) {
          match = DATE_TEXT.exec(text)
          continue
        }
        return true
      }
      if (/^[A-Za-z]/.test(rest) && !/^[TtZz]/.test(rest)) {
        match = DATE_TEXT.exec(text)
        continue
      }
      if (/^[TtZz]/.test(rest) && !parseTimeSuffix(rest)) {
        match = DATE_TEXT.exec(text)
        continue
      }
      return true
    }
    const time = parseTimeSuffix(rest)
    if (!time || time.hour === undefined) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (Number(time.hour) !== Number(query.hour)) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (
      query.minute !== undefined &&
      (time.minute ?? time.hminute ?? (time.hour !== undefined ? "00" : undefined)) !== query.minute
    ) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (query.second !== undefined && (time.second ?? "00") !== query.second) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (query.zone !== undefined) {
      if (query.zone === "Z" ? time.zone !== "Z" : time.zone !== "offset" || time.offset !== query.offset) {
        match = DATE_TEXT.exec(text)
        continue
      }
    }
    if (query.mode === "hourH" && time.hminute === undefined) {
      match = DATE_TEXT.exec(text)
      continue
    }
    if (query.hminute !== undefined && time.hminute !== query.hminute) {
      match = DATE_TEXT.exec(text)
      continue
    }
    return true
  }
  return false
}

/**
 * Exact alternatives for a date: the bare date, date+Z, and every valid clock
 * variant (T10, T10Z, T10h30). Exact hours avoid the old 23* noise (t30/t99/t3text).
 */
const dateTerms = (parts: DateTimeParts): string[] => {
  const base = `${parts.year} ${parts.month} ${parts.day}`
  if (parts.mode === "all") {
    const terms = [`"${base}"`, `"${base}z"`]
    for (const hour of HOURS) {
      terms.push(`"${base}t${hour}"`, `"${base}t${hour}z"`, `"${base}t${hour}h"*`)
    }
    return terms
  }
  if (!parts.hour) return []
  const terms: string[] = []
  if (parts.mode !== "hourH") terms.push(`"${base}t${parts.hour}"`, `"${base}t${parts.hour}z"`)
  if (parts.mode !== "hourZ") terms.push(`"${base}t${parts.hour}h"*`)
  return terms
}

const ftsQueries = (query: string): { primary: string; fallback?: string } | undefined => {
  // A bare date/date-time is a single logical term: match every valid ISO variant
  // (date, dateZ, T10, T10Z, T10h30) without prefix noise.
  const whole = parseDateTime(query.trim())
  if (whole) return { primary: dateTerms(whole).join(" OR ") }

  // Split on whitespace, then normalize each fragment. Punctuation inside a word
  // ("R&D", "O'Brien") marks token boundaries, but the tokens must stay adjacent:
  // `"r d"` matches "R&D" and does not match "Report data". A punctuation-only
  // fragment ("R & D") joins its neighbours into the same phrase.
  const fragments = stripControlChars(query).split(/\s+/).filter(Boolean)
  const groups: FtsGroup[] = []
  let joinNext = false

  for (const fragment of fragments) {
    const tokens = fragment
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .trim()
      .split(/\s+/)
      .filter(Boolean)
    if (tokens.length === 0) {
      if (groups.length > 0) joinNext = true
      continue
    }
    // Dates and email addresses are often typed partially: "202-10" and
    // "j.doe@example.com" must still match "2026-10-23" / "john.doe@...".
    // Dotted words ("v1.2", "j.doe") get a prefix fallback only when the tail is
    // informative (>=2 chars); initials ("R.D", "e.g.") stay exact so they do not
    // fuzzy-match "Report data" / "every good thing".
    const allNumeric = tokens.every((token) => /^\d+$/.test(token))
    const lastToken = tokens[tokens.length - 1] ?? ""
    const primaryPrefixAll = fragment.includes("@") || (allNumeric && tokens.length >= 3)
    const fallbackPrefixAll = primaryPrefixAll || allNumeric || (fragment.includes(".") && lastToken.length >= 2)
    if (joinNext && groups.length > 0) {
      const last = groups[groups.length - 1]
      last.tokens.push(...tokens)
      last.primaryPrefixAll = last.primaryPrefixAll || primaryPrefixAll
      last.fallbackPrefixAll = last.fallbackPrefixAll || fallbackPrefixAll
    } else {
      groups.push({ tokens, primaryPrefixAll, fallbackPrefixAll })
    }
    joinNext = false
  }

  const primary: string[] = []
  const fallback: string[] = []
  let needsFallback = false
  for (const group of groups) {
    if (group.tokens.length === 1) {
      const term = `"${group.tokens[0]}"*`
      primary.push(term)
      fallback.push(term)
      continue
    }
    if (group.tokens.length === 3 && group.tokens.every((token) => /^\d+$/.test(token))) {
      const [year, month, day] = group.tokens
      // Date-only: every valid ISO variant, no all-prefix fallback (that would
      // reintroduce 2345/t30/t99/t3text noise).
      const term = `(${dateTerms({ year, month, day, mode: "all" }).join(" OR ")})`
      primary.push(term)
      fallback.push(term)
      continue
    }
    if (group.primaryPrefixAll) {
      primary.push(`"${group.tokens.join(" ")}"*`)
      fallback.push(group.tokens.map((token) => `"${token}"*`).join(" AND "))
      needsFallback = true
      continue
    }
    const last = group.tokens[group.tokens.length - 1]
    // A prefix on the last token keeps "O'Brien" matching "O'Briens". One-letter
    // tails ("AT&T", "I&T", "R&D") stay exact to avoid matching "at the"/"I think".
    const term = last.length >= 2 ? `"${group.tokens.join(" ")}"*` : `"${group.tokens.join(" ")}"`
    primary.push(term)
    if (group.fallbackPrefixAll) {
      fallback.push(group.tokens.map((token) => `"${token}"*`).join(" AND "))
      needsFallback = true
    } else {
      fallback.push(term)
    }
  }
  if (primary.length === 0) return undefined
  return {
    primary: primary.join(" AND "),
    fallback: needsFallback ? fallback.join(" AND ") : undefined,
  }
}

interface MixedPart {
  token?: string
  punct?: string
}

const splitMixedNeedle = (needle: string): MixedPart[] => {
  const parts: MixedPart[] = []
  let current = ""
  let currentIsToken = false
  for (const char of needle) {
    const isToken = /[\p{L}\p{N}]/u.test(char)
    if (current === "") {
      current = char
      currentIsToken = isToken
      continue
    }
    if (isToken === currentIsToken) {
      current += char
    } else {
      parts.push(currentIsToken ? { token: current } : { punct: current })
      current = char
      currentIsToken = isToken
    }
  }
  if (current !== "") parts.push(currentIsToken ? { token: current } : { punct: current })
  return parts
}

/**
 * Linear comparison for mixed terms ("C++" ↔ "C + +", "R&D" ↔ "R & D").
 * The text is split once into word tokens and the separators between them, so
 * each punctuation character of the needle must occur in the separator before
 * the next token. "C++" therefore cannot match "C# +" or "C + D".
 */
const matchesMixedNeedle = (text: string, needle: string): boolean => {
  // A numeric-first term also matches inside a token ("1.2" in "v1.2"), but only
  // at a number boundary: "1.2" must not match "11.2".
  if (/^\d/.test(needle)) {
    const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    if (new RegExp(`(^|[^0-9])${escaped}(?![0-9])`).test(text)) return true
  }
  const parts = splitMixedNeedle(needle)
  if (parts.length === 0) return text.includes(needle)
  const chunks = text.split(/([^\p{L}\p{N}]+)/u)
  const tokens = chunks.filter((_, index) => index % 2 === 0)
  const separators = chunks.filter((_, index) => index % 2 === 1)

  const tokenMatches = (actual: string | undefined, part: MixedPart, last: boolean): boolean => {
    if (actual === undefined || part.token === undefined) return false
    if (last && /^\p{L}+$/u.test(part.token)) return actual.startsWith(part.token)
    return actual === part.token
  }

  const containsInOrder = (separator: string, symbols: string): boolean => {
    let at = 0
    for (const symbol of symbols) {
      const found = separator.indexOf(symbol, at)
      if (found === -1) return false
      at = found + 1
    }
    return true
  }

  if (parts[0].token !== undefined) {
    for (let start = 0; start < tokens.length; start++) {
      if (!tokenMatches(tokens[start], parts[0], parts.length === 1)) continue
      let tokenIndex = start
      let matches = true
      for (let p = 1; p < parts.length; p++) {
        const part = parts[p]
        if (part.punct !== undefined) {
          if (!containsInOrder(separators[tokenIndex] ?? "", part.punct)) {
            matches = false
            break
          }
          continue
        }
        tokenIndex += 1
        if (!tokenMatches(tokens[tokenIndex], part, p === parts.length - 1)) {
          matches = false
          break
        }
      }
      if (matches) return true
    }
    return false
  }

  // Punctuation-only terms ("***", "..."): the symbols must occur in order in one separator.
  if (parts.length !== 1) return false
  const symbols = parts[0].punct ?? ""
  return separators.some((separator) => containsInOrder(separator, symbols))
}

const splitAddresses = (value: string | null | undefined): string[] =>
  value
    ? value
        .split(";")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : []

const rowToSummary = (row: MessageRow): MessageSummary => {
  const cc = splitAddresses(row.cc_addrs)
  const summary: MessageSummary = {
    id: row.id,
    subject: row.subject,
    from: row.from_addr,
    to: splitAddresses(row.to_addrs),
    // An empty column alone means "unknown", not "no recipients": a bind that returned an
    // empty list sets `recipients_fetched` so the page stops asking EWS again.
    recipientsKnown: row.recipients_fetched === 1 || row.to_addrs !== "" || row.cc_addrs !== "",
    received: row.received,
    isRead: row.is_read === 1,
    hasAttachments: row.has_attachments === 1,
    preview: row.preview,
    conversationId: row.conversation_id ?? undefined,
    folderId: row.folder_id ?? undefined,
  }
  if (cc.length > 0) summary.cc = cc
  return summary
}

export interface Store {
  upsertMessages(folderId: string, messages: MessageSummary[]): void
  tombstone(ids: string[]): void
  markRead(ids: string[], isRead: boolean): void
  updateRecipients(id: string, to: string[], cc: string[]): void
  listMessages(input: { folderId?: string; limit: number; offset?: number }): MessageSummary[]
  search(query: string, limit: number): MessageSummary[]
  getMessage(id: string): MessageDetail | undefined
  hasMessage(id: string): boolean
  /** Returns `false` when the message is not indexed: bodies are never stored on their own. */
  putBody(messageId: string, body: string, bodyType: "html" | "text", truncated: boolean): boolean
  getSyncState(folderId: string): { token: string; lastSync: number } | undefined
  setSyncState(folderId: string, token: string): void
  clearSyncState(folderId: string): void
  count(): number
  prune(maxMessages: number, retentionDays: number): void
  close(): void
}

export function openStore(config: MailConfig): Store | undefined {
  if (config.storage === "off") return undefined

  mkdirSync(config.dataDir, { recursive: true })
  const db = new Database(path.join(config.dataDir, "mail.db"))
  db.run("pragma journal_mode = wal")
  db.run("pragma busy_timeout = 5000")
  db.run("pragma foreign_keys = on")
  db.run(SCHEMA)

  for (const migration of ADDED_COLUMNS) {
    try {
      db.run(migration)
    } catch {
      // Column already exists (fresh schema or a previous run) — nothing to do.
    }
  }

  const dropFts = db.query("delete from messages_fts where msg_id = ?")
  const addFts = db.query(`
    insert into messages_fts (msg_id, subject, from_addr, preview, body)
    values (?, ?, ?, ?, coalesce((select body from bodies where message_id = ?), ''))
  `)

  const findRow = db.query("select * from messages where id = ? and deleted = 0")

  const upsertMessages = db.transaction((folderId: string, messages: MessageSummary[]) => {
    const now = Date.now()
    const insert = db.query(`
      insert into messages (id, folder_id, subject, from_addr, to_addrs, cc_addrs, received, received_ts, is_read,
                            has_attachments, preview, conversation_id, deleted, updated_ts)
      values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)
      on conflict(id) do update set
        folder_id = excluded.folder_id,
        subject = excluded.subject,
        from_addr = excluded.from_addr,
        -- Sync changes carry no recipients: an empty payload must not erase addresses
        -- learned earlier from a bind (mail_get) or a lazy enrichment.
        to_addrs = case when excluded.to_addrs <> '' then excluded.to_addrs else messages.to_addrs end,
        cc_addrs = case when excluded.cc_addrs <> '' then excluded.cc_addrs else messages.cc_addrs end,
        received = excluded.received,
        received_ts = excluded.received_ts,
        is_read = excluded.is_read,
        has_attachments = excluded.has_attachments,
        preview = excluded.preview,
        conversation_id = excluded.conversation_id,
        deleted = 0,
        updated_ts = excluded.updated_ts
    `)
    for (const message of messages) {
      const receivedTs = Number.isFinite(Date.parse(message.received)) ? Date.parse(message.received) : 0
      insert.run(
        message.id,
        folderId,
        message.subject,
        message.from,
        message.to.join(";"),
        (message.cc ?? []).join(";"),
        message.received,
        receivedTs,
        message.isRead ? 1 : 0,
        message.hasAttachments ? 1 : 0,
        message.preview,
        message.conversationId ?? null,
        now,
      )
      dropFts.run(message.id)
      /** Body lives in `bodies`; re-indexing a header must not erase it from the FTS row. */
      addFts.run(message.id, message.subject, message.from, message.preview, message.id)
    }
  })

  const markRead = db.transaction((ids: string[], isRead: boolean) => {
    const update = db.query("update messages set is_read = ?, updated_ts = ? where id = ?")
    const now = Date.now()
    for (const id of ids) update.run(isRead ? 1 : 0, now, id)
  })

  const tombstone = db.transaction((ids: string[]) => {
    const mark = db.query("update messages set deleted = 1, updated_ts = ? where id = ?")
    const dropBody = db.query("delete from bodies where message_id = ?")
    for (const id of ids) {
      mark.run(Date.now(), id)
      dropBody.run(id)
      dropFts.run(id)
    }
  })

  const updateRecipients = db.transaction((id: string, to: string[], cc: string[]) => {
    // `recipients_fetched` is set even for an empty list: a bind that returned no recipients
    // is an answer ("known empty"), not a reason to ask EWS again on every page.
    db.query("update messages set to_addrs = ?, cc_addrs = ?, recipients_fetched = 1, updated_ts = ? where id = ?").run(
      to.join(";"),
      cc.join(";"),
      Date.now(),
      id,
    )
  })

  const searchByDate = (date: DateTimeParts, take: number, rest?: string): MessageSummary[] => {
    const pattern = `%${date.year}%`
    // Keep punctuation inside terms (C++, C#, R&D); strip surrounding quotes and
    // trailing sentence punctuation.
    const needles = rest
      ? rest
          .toLowerCase()
          .split(/\s+/)
          .map((token) => {
            const leading = token.replace(/^[^\p{L}\p{N}]+/gu, "")
            if (!leading) return token
            return leading.replace(/[^\p{L}\p{N}+#&]+$/gu, "") || token
          })
          .filter(Boolean)
      : []
    const stmt = db.prepare(`
        select m.*, b.body from messages m
        left join bodies b on b.message_id = m.id
        where m.deleted = 0 and (m.subject like ? or m.from_addr like ? or m.preview like ? or b.body like ?)
        order by m.received_ts desc, m.id asc
      `)
    const matchesNeedles = (lower: string): boolean =>
      needles.every((needle) => {
        if (needle.length > 256) return lower.includes(needle)
        const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        if (/^\d+$/.test(needle)) {
          return new RegExp(`(^|[^0-9])${escaped}([^0-9]|$)`).test(lower)
        }
        if (/^[\p{L}\p{N}]+$/u.test(needle)) {
          return new RegExp(`(^|[^\\p{L}\\p{N}])${escaped}`, "iu").test(lower)
        }
        // Mixed terms are compared as token sequences: linear, no regex backtracking.
        return matchesMixedNeedle(lower, needle)
      })
    const dateOnly: DateTimeParts | undefined = date.ambiguousHour
      ? {
          ...date,
          hour: undefined,
          minute: undefined,
          second: undefined,
          hminute: undefined,
          zone: undefined,
          offset: undefined,
          mode: "all",
        }
      : undefined
    const hourPattern =
      dateOnly && date.hour !== undefined
        ? new RegExp(`(^|[^0-9])${date.hour.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^0-9]|$)`)
        : undefined
    // Early exit: the query is ordered by received date, so once `take` matches are
    // collected the remaining rows cannot change the page. `iterate` avoids pulling
    // every body into memory.
    const found: MessageSummary[] = []
    try {
      for (const row of stmt.iterate(pattern, pattern, pattern, pattern) as IterableIterator<
        MessageRow & { body: string | null }
      >) {
        const text = [row.subject, row.from_addr, row.preview, row.body ?? ""].join("\n")
        // Ignore the date itself when matching text terms: "2026-10-23 10 report"
        // must not satisfy "10" from the month.
        const withoutDate = text.replace(new RegExp(DATE_TEXT.source, "gu"), " ").toLowerCase()
        if (!matchesNeedles(withoutDate)) continue
        const dateMatches = matchesDateText(text, date)
        let matched = dateMatches
        if (!matched && dateOnly && hourPattern) {
          // "2026-10-23 5 items": the word terms must match, and the digit may be
          // either an hour ("T05:00 items") or a literal count ("total 5 items").
          matched = matchesDateText(text, dateOnly) && hourPattern.test(withoutDate)
        }
        if (!matched) continue
        found.push(rowToSummary(row))
        if (found.length >= take) break
      }
    } finally {
      stmt.finalize()
    }
    return found
  }

  return {
    upsertMessages,
    tombstone,
    markRead,
    updateRecipients,
    listMessages({ folderId, limit, offset = 0 }) {
      const rows = folderId
        ? db
            .query(
              "select * from messages where deleted = 0 and folder_id = ? order by received_ts desc limit ? offset ?",
            )
            .all(folderId, limit, offset)
        : db
            .query("select * from messages where deleted = 0 order by received_ts desc limit ? offset ?")
            .all(limit, offset)
      return (rows as MessageRow[]).map(rowToSummary)
    },
    search(query, limit) {
      const take = Number.isFinite(limit) ? Math.max(0, Math.trunc(limit)) : 0
      if (take === 0) return []
      // Date/time queries get a date-aware scan: FTS tokens cannot represent every
      // ISO variant (padding, Z, h-minutes) without combinatorial alternatives.
      const dateQuery = parseSearchDate(query)
      // A date-time with invalid components is an impossible query, not text.
      if (dateQuery?.invalid) return []
      if (dateQuery) return searchByDate(dateQuery.date, take, dateQuery.text)
      const queries = ftsQueries(query)
      if (!queries) return []
      // Newest first: `searchMessages` merges this page with the EWS page and keeps the
      // newest `limit` rows, so both halves must select by received date, not by rank.
      const select = db.query(`
        select m.* from messages_fts f
        join messages m on m.id = f.msg_id
        where messages_fts match ? and m.deleted = 0
        order by m.received_ts desc, m.id asc
        limit ?
      `)
      // Exact date/email phrase first; only if it finds nothing, retry with prefixes.
      let rows = select.all(queries.primary, take)
      if (rows.length === 0 && queries.fallback) rows = select.all(queries.fallback, take)
      return (rows as MessageRow[]).map(rowToSummary)
    },
    getMessage(id) {
      const row = findRow.get(id) as MessageRow | null
      if (!row) return undefined
      const cached = db.query("select body, body_type, truncated from bodies where message_id = ?").get(id) as {
        body: string
        body_type: string
        truncated: number
      } | null
      const summary = rowToSummary(row)
      return {
        ...summary,
        cc: summary.cc ?? [],
        body: cached?.body ?? "",
        bodyType: cached?.body_type === "html" ? "html" : "text",
        truncated: cached?.truncated === 1,
        // Row presence, not `body !== ""`: a fetched empty body must not be re-bound.
        fetched: cached !== null,
        bodyCached: cached !== null,
      }
    },
    hasMessage(id) {
      return findRow.get(id) !== null
    },
    putBody(messageId, body, bodyType, truncated) {
      const existing = findRow.get(messageId) as MessageRow | null
      // An unindexed message must not leave a body-only row behind: `prune` would never
      // reach it and the index would grow with unreachable bodies.
      if (!existing) return false

      db.query(`
        insert into bodies (message_id, body, body_type, truncated, fetched_ts) values (?, ?, ?, ?, ?)
        on conflict(message_id) do update set body = excluded.body, body_type = excluded.body_type,
          truncated = excluded.truncated, fetched_ts = excluded.fetched_ts
      `).run(messageId, body, bodyType, truncated ? 1 : 0, Date.now())

      dropFts.run(messageId)
      addFts.run(messageId, existing.subject, existing.from_addr, existing.preview, messageId)
      return true
    },
    getSyncState(folderId) {
      const row = db.query("select token, last_sync_ts from sync_state where folder_id = ?").get(folderId) as {
        token: string
        last_sync_ts: number
      } | null
      return row ? { token: row.token, lastSync: row.last_sync_ts } : undefined
    },
    setSyncState(folderId, token) {
      db.query(`
        insert into sync_state (folder_id, token, last_sync_ts) values (?, ?, ?)
        on conflict(folder_id) do update set token = excluded.token, last_sync_ts = excluded.last_sync_ts
      `).run(folderId, token, Date.now())
    },
    clearSyncState(folderId) {
      db.query("delete from sync_state where folder_id = ?").run(folderId)
    },
    count() {
      const row = db.query("select count(*) as n from messages where deleted = 0").get() as { n: number }
      return row.n
    },
    prune(maxMessages, retentionDays) {
      const cutoff = Date.now() - retentionDays * 24 * 3600 * 1000
      db.run(
        "delete from bodies where message_id in (select id from messages where received_ts > 0 and received_ts < ?)",
        [cutoff],
      )
      db.run(
        "delete from messages_fts where msg_id in (select id from messages where received_ts > 0 and received_ts < ?)",
        [cutoff],
      )
      db.run("delete from messages where received_ts > 0 and received_ts < ?", [cutoff])
      const overflow = db
        .query("select id from messages order by received_ts desc limit -1 offset ?")
        .all(maxMessages) as Array<{ id: string }>
      for (const { id } of overflow) {
        dropFts.run(id)
        db.run("delete from bodies where message_id = ?", [id])
        db.run("delete from messages where id = ?", [id])
      }
      // Sweep bodies whose message vanished (tombstoned or pruned by another path).
      db.run("delete from bodies where message_id not in (select id from messages)")
    },
    close() {
      db.close()
    },
  }
}

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

const ftsQuery = (query: string): string | undefined => {
  // Split on whitespace, then normalize each fragment. Punctuation inside a word
  // ("R&D", "O'Brien") marks token boundaries, but the tokens must stay adjacent:
  // `"r d"` matches "R&D" and does not match "Report data". A punctuation-only
  // fragment ("R & D") joins its neighbours into the same phrase.
  const fragments = stripControlChars(query).split(/\s+/).filter(Boolean)
  const groups: Array<{ tokens: string[]; prefixAll: boolean }> = []
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
    const prefixAll = fragment.includes("@") || tokens.every((token) => /^\d+$/.test(token))
    if (joinNext && groups.length > 0) {
      const last = groups[groups.length - 1]
      last.tokens.push(...tokens)
      last.prefixAll = last.prefixAll || prefixAll
    } else {
      groups.push({ tokens, prefixAll })
    }
    joinNext = false
  }

  const terms = groups.map((group) => {
    if (group.tokens.length === 1) return `"${group.tokens[0]}"*`
    // Exact phrases for ordinary words: a prefix here would make "AT&T" match
    // "at the" and "I&T" match "I think".
    if (group.prefixAll) return group.tokens.map((token) => `"${token}"*`).join(" AND ")
    return `"${group.tokens.join(" ")}"`
  })
  if (terms.length === 0) return undefined
  return terms.join(" AND ")
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
      const match = ftsQuery(query)
      const take = Math.max(0, Math.trunc(limit))
      if (!match || take === 0) return []
      // Newest first: `searchMessages` merges this page with the EWS page and keeps the
      // newest `limit` rows, so both halves must select by received date, not by rank.
      const rows = db
        .query(`
          select m.* from messages_fts f
          join messages m on m.id = f.msg_id
          where messages_fts match ? and m.deleted = 0
          order by m.received_ts desc, m.id asc
          limit ?
        `)
        .all(match, take)
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

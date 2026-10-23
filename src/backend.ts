import {
  BasePropertySet,
  BodyType,
  CalendarView,
  ChangeType,
  ContactSchema,
  DateTime,
  EmailAddress,
  EmailMessage,
  EmailMessageSchema,
  FolderId,
  FolderSchema,
  FolderView,
  ItemId,
  ItemSchema,
  ItemView,
  LogicalOperator,
  MessageBody,
  PropertySet,
  SearchFilter,
  ServiceResult,
  SyncFolderItemsScope,
  WellKnownFolderName,
} from "ews-javascript-api"
import type { MailConfig } from "./config"
import {
  address,
  addressList,
  createEwsService,
  iso,
  MESSAGE_PROPERTY_SET,
  resolveFolderId,
  SYNC_PROPERTY_SET,
  toSummary,
  wellKnownFolder,
} from "./ews"
import type { Store } from "./store"
import type {
  CalendarEvent,
  ContactDto,
  FolderDto,
  MailBackend,
  MessageDetail,
  MessageSummary,
  OutgoingMessage,
  SyncResult,
} from "./types"

const CONTACT_PROPERTY_SET = new PropertySet(BasePropertySet.FirstClassProperties, [
  ContactSchema.DisplayName,
  ContactSchema.EmailAddresses,
  ContactSchema.CompanyName,
])

/** Recipients are not part of `SYNC_PROPERTY_SET`, so cached pages bind them in one batch. */
const RECIPIENT_PROPERTY_SET = new PropertySet(BasePropertySet.IdOnly, [
  EmailMessageSchema.ToRecipients,
  EmailMessageSchema.CcRecipients,
])

const MAX_ATTACHMENTS = 10
const MAX_ATTACHMENT_BYTES = 40 * 1024 * 1024

/** Recipient enrichment is a page nicety: it gets its own small budget and a cool-down. */
const ENRICHMENT_BUDGET_MIN_MS = 500
const ENRICHMENT_BUDGET_MAX_MS = 2_000
const ENRICHMENT_COOLDOWN_MS = 60_000

const bodyTypeOf = (value: unknown): "html" | "text" =>
  (value as number | undefined) === (BodyType.HTML as unknown as number) ? "html" : "text"

const folderKey = (folder: string | undefined): string => {
  const known = wellKnownFolder(folder)
  switch (known) {
    case WellKnownFolderName.SentItems:
      return "wk:sent"
    case WellKnownFolderName.Drafts:
      return "wk:drafts"
    case WellKnownFolderName.DeletedItems:
      return "wk:deleted"
    case WellKnownFolderName.Calendar:
      return "wk:calendar"
    case WellKnownFolderName.Contacts:
      return "wk:contacts"
    case WellKnownFolderName.Tasks:
      return "wk:tasks"
    case WellKnownFolderName.Inbox:
      return "wk:inbox"
    default:
      return `wk:${folder?.trim().toLowerCase() ?? "inbox"}`
  }
}

const MAIL_FOLDERS = new Set(["wk:inbox", "wk:sent", "wk:drafts", "wk:deleted"])

/**
 * Local FTS covers four indexed folders; the EWS fallback covers Inbox subject/body.
 * Merge both so a cached body cannot hide an uncached match.
 */
export function mergeSearchResults(
  local: readonly MessageSummary[],
  remote: readonly MessageSummary[],
  limit: number,
): MessageSummary[] {
  const byId = new Map<string, MessageSummary>()
  for (const message of local) byId.set(message.id, message)
  for (const message of remote) {
    const existing = byId.get(message.id)
    if (!existing) {
      byId.set(message.id, message)
      continue
    }
    byId.set(message.id, {
      ...existing,
      to: existing.to.length > 0 ? existing.to : message.to,
      cc: existing.cc && existing.cc.length > 0 ? existing.cc : message.cc,
      recipientsKnown: existing.recipientsKnown === true || message.recipientsKnown === true,
      preview: existing.preview || message.preview,
      hasAttachments: existing.hasAttachments || message.hasAttachments,
    })
  }
  return [...byId.values()]
    .sort((a, b) => (Date.parse(b.received) || 0) - (Date.parse(a.received) || 0) || a.id.localeCompare(b.id))
    .slice(0, limit)
}

const safe = <T>(read: () => T, fallback: T): T => {
  try {
    return read() ?? fallback
  } catch {
    return fallback
  }
}

/** XML 1.0 forbids most C0 controls; keeping them in a SOAP text node breaks the request. */
const XML_ALLOWED_CONTROLS = new Set([0x09, 0x0a, 0x0d])

const stripControlChars = (value: string): string => {
  let clean = ""
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code >= 0x20 && code !== 0x7f) clean += char
    else if (XML_ALLOWED_CONTROLS.has(code)) clean += char
  }
  return clean
}

/**
 * ews-javascript-api writes body/subject/recipient text into SOAP without XML-escaping:
 * raw `<` breaks the request and the server silently stores an empty body.
 */
export const escapeXml = (value: string): string =>
  stripControlChars(value).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

export interface ParsedRecipient {
  name?: string
  address: string
}

const hasControlChars = (value: string): boolean => {
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0
    if (code < 0x20 || code === 0x7f) return true
  }
  return false
}
const ADDRESS_PATTERN = /^[^\s@]+@[^\s@]+$/

const checkAddress = (address: string): string => {
  if (!ADDRESS_PATTERN.test(address)) throw new Error(`Invalid recipient address: ${JSON.stringify(address)}`)
  return address
}

/**
 * Accepts `addr@example.com` and `Name <addr@example.com>`.
 * Rejects control characters and stray angle brackets so a recipient can never inject a
 * second mailbox or extra SOAP markup.
 */
export function parseRecipient(value: string): ParsedRecipient {
  const raw = typeof value === "string" ? value.trim() : ""
  if (!raw) throw new Error("Recipient address is empty")
  if (hasControlChars(raw)) {
    throw new Error(`Recipient contains forbidden characters: ${JSON.stringify(raw)}`)
  }
  const bracketed = /^(.*?)\s*<([^<>]*)>$/.exec(raw)
  if (bracketed) {
    const name = (bracketed[1] ?? "").trim()
    if (name.includes("<") || name.includes(">")) {
      throw new Error(`Recipient contains forbidden characters: ${JSON.stringify(raw)}`)
    }
    const address = checkAddress((bracketed[2] ?? "").trim())
    return name ? { name, address } : { address }
  }
  if (raw.includes("<") || raw.includes(">")) {
    throw new Error(`Recipient contains forbidden characters: ${JSON.stringify(raw)}`)
  }
  return { address: checkAddress(raw) }
}

/**
 * Both the display name and the address itself end up as SOAP text: `a&b@example.com`
 * is a legal address and must be escaped like any other text node.
 */
const toEmailAddress = (value: string): EmailAddress => {
  const parsed = parseRecipient(value)
  return parsed.name
    ? new EmailAddress(escapeXml(parsed.name), escapeXml(parsed.address))
    : new EmailAddress(escapeXml(parsed.address))
}

/** Truncation is a byte budget (`maxBodyBytes`), not a UTF-16 length budget. */
const truncateToBytes = (text: string, maxBytes: number): { body: string; truncated: boolean } => {
  const buffer = Buffer.from(text, "utf8")
  if (buffer.byteLength <= maxBytes) return { body: text, truncated: false }
  const cut = buffer.subarray(0, maxBytes).toString("utf8")
  return { body: cut.replace(/\uFFFD+$/, ""), truncated: true }
}

const errorText = (error: unknown): string => {
  const typed = error as { Message?: unknown; message?: unknown } | null
  if (typeof typed?.Message === "string") return typed.Message
  if (typeof typed?.message === "string") return typed.message
  return String(error)
}

/** EWS `UniqueId` is base64-like; anything else cannot be an item id and must not reach SOAP. */
const ITEM_ID_PATTERN = /^[A-Za-z0-9+/=_-]+$/

const checkItemId = (id: unknown): string => {
  const value = typeof id === "string" ? id.trim() : ""
  if (!value || !ITEM_ID_PATTERN.test(value)) throw new Error(`invalid item id: ${JSON.stringify(id)}`)
  return value
}

/**
 * ErrorInvalidSyncStateData (237) or a message that explicitly ties a *synchronization
 * state* to corruption. A bare "поврежден" (e.g. about an attachment) must not reset tokens.
 */
const INVALID_SYNC_STATE_PATTERN =
  /(?:(?:sync(?:hronization)?\s*state|состояни[а-яё]*\s+синхронизации)[\s\S]{0,80}?(?:invalid|corrupt|поврежд[а-яё]*|недействительн[а-яё]*)|(?:invalid|corrupt|поврежд[а-яё]*|недействительн[а-яё]*)[\s\S]{0,40}?(?:sync(?:hronization)?\s*state|состояни[а-яё]*\s+синхронизации))/i

const isInvalidSyncState = (error: unknown): boolean => {
  const typed = error as { ErrorCode?: unknown } | null
  if (typed?.ErrorCode === 237) return true
  return INVALID_SYNC_STATE_PATTERN.test(errorText(error))
}

export class EwsBackend implements MailBackend {
  private readonly service: ReturnType<typeof createEwsService>
  private readonly inflight = new Map<string, Promise<SyncResult>>()
  /** After one enrichment overruns its budget, pages are served envelope-only for a minute. */
  private enrichmentBlockedUntil = 0

  constructor(
    private readonly config: MailConfig,
    private readonly store?: Store,
  ) {
    this.service = createEwsService(config)
  }

  async listFolders(): Promise<FolderDto[]> {
    const view = new FolderView(300)
    view.PropertySet = new PropertySet(BasePropertySet.FirstClassProperties, [
      FolderSchema.UnreadCount,
      FolderSchema.TotalCount,
    ])
    const result = await this.service.FindFolders(new FolderId(WellKnownFolderName.MsgFolderRoot), view)
    return result.Folders.map((folder) => ({
      id: safe(() => folder.Id?.UniqueId ?? "", ""),
      name: safe(() => folder.DisplayName ?? "", ""),
      unread: safe(() => folder.UnreadCount, 0),
      total: safe(() => folder.TotalCount, 0),
    }))
  }

  /**
   * Single-flight per folder: concurrent callers (e.g. two tool calls during one
   * stale window) share one SyncFolderItems run instead of racing on the token.
   */
  async syncFolder(folder: string): Promise<SyncResult> {
    const store = this.store
    // Not a silent success: the caller needs to know the folder was not indexed at all.
    if (!store) return { synced: 0, complete: true, skipped: "storage-off" }
    const key = folderKey(folder)
    if (!MAIL_FOLDERS.has(key)) return { synced: 0, complete: true, skipped: "not-indexed" }

    const running = this.inflight.get(key)
    if (running) return running

    const task = this.runSync(folder, key, store).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  async listMessages(input: { folder?: string; limit: number; offset?: number }): Promise<MessageSummary[]> {
    const key = folderKey(input.folder)
    if (this.store && MAIL_FOLDERS.has(key)) {
      await this.ensureFresh(input.folder)
      const cached = this.store.listMessages({ folderId: key, limit: input.limit, offset: input.offset ?? 0 })
      if (cached.length > 0) return this.withRecipients(cached)
    }

    const folderId = await resolveFolderId(this.service, input.folder)
    const page = await this.service.FindItems(folderId, new ItemView(input.limit, input.offset ?? 0))
    // LoadPropertiesForItems throws "The collection is empty." on an empty page.
    if (page.Items.length === 0) return []
    await this.service.LoadPropertiesForItems(page.Items, MESSAGE_PROPERTY_SET)
    return page.Items.map((item) => toSummary(item, key, true))
  }

  async searchMessages(input: { query: string; limit: number }): Promise<MessageSummary[]> {
    const local = this.store && this.store.count() > 0 ? this.store.search(input.query, input.limit) : []

    // The filter value lands in a SOAP text node: `R&D` breaks the request unless escaped.
    const query = escapeXml(input.query)
    let remote: MessageSummary[] = []
    try {
      const filter = new SearchFilter.SearchFilterCollection(LogicalOperator.Or, [
        new SearchFilter.ContainsSubstring(ItemSchema.Subject, query),
        new SearchFilter.ContainsSubstring(ItemSchema.Body, query),
      ])
      const page = await this.service.FindItems(WellKnownFolderName.Inbox, filter, new ItemView(input.limit))
      if (page.Items.length > 0) {
        await this.service.LoadPropertiesForItems(page.Items, MESSAGE_PROPERTY_SET)
        remote = page.Items.map((item) => toSummary(item, undefined, true))
      }
    } catch (error) {
      // Local FTS may still have useful results when EWS search is unavailable.
      if (local.length === 0) throw error
      console.warn(`[mail.exchange] EWS search failed; returning local FTS results: ${String(error)}`)
    }

    return this.withRecipients(mergeSearchResults(local, remote, input.limit))
  }

  async getMessage(input: { id: string }): Promise<MessageDetail> {
    const id = checkItemId(input.id)
    const cached = this.store?.getMessage(id)
    // A cached body is still a body obtained by this call; `bodyCached` reports the index row.
    if (cached?.fetched === true) return { ...cached, cc: cached.cc ?? [], fetched: true }

    const message = await EmailMessage.Bind(this.service, new ItemId(id), MESSAGE_PROPERTY_SET)
    const raw = message.Body?.Text ?? ""
    const { body, truncated } = truncateToBytes(raw, this.config.maxBodyBytes)
    const bodyType = bodyTypeOf(message.Body?.BodyType)
    const summary = toSummary(message, undefined, true)
    const cc = addressList(message.CcRecipients)

    let bodyCached = false
    if (this.store && this.config.storage === "full") {
      // `putBody` refuses unindexed messages, so the flag reflects what is really stored.
      bodyCached = this.store.putBody(id, body, bodyType, truncated)
    }
    // Recipients are not part of the sync property set; keep the cached row in sync.
    this.persistRecipients(id, summary.to, cc)

    return { ...summary, cc, body, bodyType, truncated, fetched: true, bodyCached }
  }

  async send(input: OutgoingMessage): Promise<{ sent: true }> {
    const message = this.buildMessage(input)
    // EWS does not return an item id for `Send`: only the acceptance of the request is known.
    await message.Send()
    return { sent: true }
  }

  async saveDraft(input: OutgoingMessage): Promise<{ id: string }> {
    const message = this.buildMessage(input)
    await message.Save()
    return { id: message.Id?.UniqueId ?? "" }
  }

  async listCalendar(input: { from?: string; to?: string; limit: number }): Promise<CalendarEvent[]> {
    const start = input.from ? DateTime.Parse(input.from) : DateTime.Now
    const end = input.to ? DateTime.Parse(input.to) : start.AddDays(14)
    const result = await this.service.FindAppointments(
      WellKnownFolderName.Calendar,
      new CalendarView(start, end, input.limit),
    )
    if (result.Items.length > 0) {
      await this.service.LoadPropertiesForItems(result.Items, new PropertySet(BasePropertySet.FirstClassProperties))
    }
    return result.Items.map((appointment) => ({
      id: appointment.Id?.UniqueId ?? "",
      subject: appointment.Subject ?? "",
      start: iso(appointment.Start),
      end: iso(appointment.End),
      location: appointment.Location ?? "",
      isAllDay: appointment.IsAllDayEvent === true,
      organizer: address(appointment.Organizer),
    }))
  }

  async listContacts(input: { query?: string; limit: number }): Promise<ContactDto[]> {
    const map = (contact: unknown): ContactDto => {
      const typed = contact as {
        Id?: { UniqueId?: string }
        DisplayName?: string
        CompanyName?: string
        EmailAddresses?: { GetEnumerator?: () => Array<{ Address?: string }> }
      }
      return {
        id: typed.Id?.UniqueId ?? "",
        displayName: typed.DisplayName ?? "",
        company: typed.CompanyName ?? "",
        email: typed.EmailAddresses?.GetEnumerator?.()[0]?.Address ?? "",
      }
    }
    const query = input.query?.toLowerCase()
    if (!query) {
      const page = await this.service.FindItems(WellKnownFolderName.Contacts, new ItemView(input.limit))
      if (page.Items.length > 0) await this.service.LoadPropertiesForItems(page.Items, CONTACT_PROPERTY_SET)
      return page.Items.map(map)
    }

    // EWS cannot filter on EmailAddresses, so scan pages (bounded) and filter locally
    // instead of silently losing matches outside the first page.
    const pageSize = Math.min(Math.max(input.limit, 50), 200)
    const maxScan = 500
    const matches: ContactDto[] = []
    for (let offset = 0; offset < maxScan; offset += pageSize) {
      // The last page is clipped so the scan stops at exactly `maxScan` contacts, not at the
      // next page boundary (limit 200 → 200 + 200 + 100).
      const size = Math.min(pageSize, maxScan - offset)
      const page = await this.service.FindItems(WellKnownFolderName.Contacts, new ItemView(size, offset))
      if (page.Items.length === 0) break
      await this.service.LoadPropertiesForItems(page.Items, CONTACT_PROPERTY_SET)
      for (const contact of page.Items.map(map)) {
        if (`${contact.displayName} ${contact.email}`.toLowerCase().includes(query)) matches.push(contact)
        if (matches.length >= input.limit) return matches
      }
      if (page.Items.length < size) break
    }
    return matches
  }

  close(): void {
    this.store?.close()
  }

  /**
   * Enrichment must never become the page's critical path: it runs with its own budget
   * (`min(2 s, max(500 ms, requestTimeoutMs / 5))`), and an overrun parks it for a minute.
   */
  private enrichmentBudgetMs(): number {
    const share = Math.round(this.config.requestTimeoutMs / 5)
    return Math.min(ENRICHMENT_BUDGET_MAX_MS, Math.max(ENRICHMENT_BUDGET_MIN_MS, share))
  }

  /** The index is a cache: failing to persist recipients must not fail the read path. */
  private persistRecipients(id: string, to: string[], cc: string[]): void {
    try {
      this.store?.updateRecipients(id, to, cc)
    } catch (error) {
      console.warn(`[mail.exchange] ${this.config.id}: could not cache recipients for ${id}: ${errorText(error)}`)
    }
  }

  /**
   * Fill recipients for a cached page in one `BindToItems` call. Failures are non-fatal:
   * the page is still returned, just with `recipientsKnown: false` for the unbound rows.
   */
  private async withRecipients(page: MessageSummary[]): Promise<MessageSummary[]> {
    const store = this.store
    if (!store) return page
    const pending = page.filter((message) => message.recipientsKnown !== true && message.id !== "")
    if (pending.length === 0) return page

    const envelopeOnly = (): MessageSummary[] =>
      page.map((message) => (message.recipientsKnown === true ? message : { ...message, recipientsKnown: false }))
    // A previous bind overran its budget: serve the envelope instead of stalling again.
    if (Date.now() < this.enrichmentBlockedUntil) return envelopeOnly()

    const budget = this.enrichmentBudgetMs()
    const bind = this.service.BindToItems(
      pending.map((message) => new ItemId(message.id)),
      RECIPIENT_PROPERTY_SET,
    )
    // The raced-out request may still settle later; its rejection is already accounted for.
    bind.catch(() => {})
    let timer: ReturnType<typeof setTimeout> | undefined
    const expired = new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), budget)
    })

    let responses: Array<{ Item?: unknown; Result?: ServiceResult }>
    try {
      const bound = await Promise.race([bind, expired])
      if (bound === undefined) {
        this.enrichmentBlockedUntil = Date.now() + ENRICHMENT_COOLDOWN_MS
        console.warn(
          `[mail.exchange] ${this.config.id}: recipient enrichment overran ${budget} ms, returning envelope only`,
        )
        return envelopeOnly()
      }
      responses = bound.Responses ?? []
    } catch (error) {
      console.warn(
        `[mail.exchange] ${this.config.id}: recipient enrichment failed, returning envelope only: ${errorText(error)}`,
      )
      return envelopeOnly()
    } finally {
      if (timer !== undefined) clearTimeout(timer)
    }

    const fresh = new Map<string, { to: string[]; cc: string[] }>()
    for (const response of responses) {
      if (response.Result !== ServiceResult.Success && response.Result !== ServiceResult.Warning) continue
      const item = response.Item as
        | { Id?: { UniqueId?: string }; ToRecipients?: unknown; CcRecipients?: unknown }
        | undefined
      const id = safe(() => item?.Id?.UniqueId ?? "", "")
      if (!id) continue
      fresh.set(id, {
        to: safe(() => addressList(item?.ToRecipients), []),
        cc: safe(() => addressList(item?.CcRecipients), []),
      })
    }

    return page.map((message) => {
      const found = fresh.get(message.id)
      if (!found) return message.recipientsKnown === true ? message : { ...message, recipientsKnown: false }
      this.persistRecipients(message.id, found.to, found.cc)
      const enriched: MessageSummary = { ...message, to: found.to, recipientsKnown: true }
      if (found.cc.length > 0) enriched.cc = found.cc
      else delete enriched.cc
      return enriched
    })
  }

  private async runSync(folder: string, key: string, store: Store): Promise<SyncResult> {
    const folderId = await resolveFolderId(this.service, folder)
    try {
      return await this.syncRounds(folderId, key, store, store.getSyncState(key)?.token ?? null)
    } catch (error) {
      if (!isInvalidSyncState(error)) throw error
      // The token is unusable (server-side state expired/corrupted): drop it and do one full sync.
      store.clearSyncState(key)
      console.warn(
        `[mail.exchange] ${this.config.id}: invalid sync state for ${key}, resetting token: ${errorText(error)}`,
      )
      return await this.syncRounds(folderId, key, store, null)
    }
  }

  private async syncRounds(
    folderId: FolderId,
    key: string,
    store: Store,
    initialState: string | null,
  ): Promise<SyncResult> {
    let state = initialState
    let synced = 0
    // `false` only when the round budget runs out while EWS still has changes.
    let complete = false

    for (let round = 0; round < 50; round++) {
      const changes = await this.service.SyncFolderItems(
        folderId,
        SYNC_PROPERTY_SET,
        [],
        256,
        SyncFolderItemsScope.NormalItems,
        state ?? (null as unknown as string),
      )
      const upserts: MessageSummary[] = []
      const removed: string[] = []
      const readFlags = new Map<boolean, string[]>()

      for (const change of changes.GetEnumerator()) {
        if (change.ChangeType === ChangeType.ReadFlagChange) {
          // ReadFlagChange carries only ItemId + IsRead: no Item object, no other properties.
          const uniqueId = change.ItemId?.UniqueId
          if (uniqueId) {
            const ids = readFlags.get(change.IsRead === true) ?? []
            ids.push(uniqueId)
            readFlags.set(change.IsRead === true, ids)
          }
          continue
        }
        if (change.ChangeType === ChangeType.Create || change.ChangeType === ChangeType.Update) {
          if (change.Item) {
            upserts.push(toSummary(change.Item, key))
            synced++
          }
        } else if (change.ChangeType === ChangeType.Delete) {
          const uniqueId = change.ItemId?.UniqueId
          if (uniqueId) removed.push(uniqueId)
        }
      }

      // Apply every change of this round before advancing the token: a crash after
      // setSyncState would otherwise skip the round permanently.
      if (upserts.length > 0) store.upsertMessages(key, upserts)
      if (removed.length > 0) store.tombstone(removed)
      for (const [isRead, ids] of readFlags) store.markRead(ids, isRead)

      state = changes.SyncState
      if (state) store.setSyncState(key, state)
      if (!changes.MoreChangesAvailable) {
        complete = true
        break
      }
    }

    store.prune(this.config.maxMessages, this.config.retentionDays)
    return { synced, complete }
  }

  private async ensureFresh(folder: string | undefined): Promise<void> {
    const store = this.store
    if (!store) return
    const key = folderKey(folder)
    if (!MAIL_FOLDERS.has(key)) return
    const state = store.getSyncState(key)
    const stale = !state || Date.now() - state.lastSync > this.config.syncIntervalMinutes * 60_000
    if (!stale) return
    try {
      await this.syncFolder(folder ?? "inbox")
    } catch (error) {
      // A broken index must not break reading mail: serve the cache and keep going.
      console.warn(
        `[mail.exchange] ${this.config.id}: sync failed for ${key}, serving cached index: ${errorText(error)}`,
      )
    }
  }

  private buildMessage(input: OutgoingMessage): EmailMessage {
    if (input.to.length === 0) throw new Error("At least one recipient is required")
    const message = new EmailMessage(this.service)
    message.Subject = escapeXml(input.subject)
    message.Body = new MessageBody(input.bodyType === "html" ? BodyType.HTML : BodyType.Text, escapeXml(input.body))
    for (const recipient of input.to) message.ToRecipients.Add(toEmailAddress(recipient))
    for (const recipient of input.cc ?? []) message.CcRecipients.Add(toEmailAddress(recipient))
    const attachments = input.attachments ?? []
    if (attachments.length > MAX_ATTACHMENTS) {
      throw new Error(`Too many attachments: ${attachments.length} (max ${MAX_ATTACHMENTS} per message)`)
    }
    for (const attachment of attachments) {
      // Fail before the request: EWS answers a >40 MB attachment with an opaque HTTP 413.
      const bytes = Buffer.byteLength(attachment.contentBase64, "base64")
      if (bytes > MAX_ATTACHMENT_BYTES) {
        throw new Error(
          `Attachment too large: ${attachment.name} is ${Math.round(bytes / 1024 / 1024)} MB decoded ` +
            `(max ${MAX_ATTACHMENT_BYTES / 1024 / 1024} MB per attachment)`,
        )
      }
      const file = message.Attachments.AddFileAttachment(escapeXml(attachment.name), attachment.contentBase64)
      if (attachment.contentId) file.ContentId = escapeXml(attachment.contentId)
      if (attachment.isInline) file.IsInline = true
    }
    return message
  }
}

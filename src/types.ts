export type StorageMode = "off" | "metadata" | "full"

/** EWS `ItemSize` is an Int32 (`item:Size`); reject larger hostile values. */
export const MAX_ITEM_SIZE = 2_147_483_647

export interface FolderDto {
  id: string
  name: string
  unread: number
  total: number
}

export interface MessageSummary {
  id: string
  subject: string
  from: string
  to: string[]
  /** CC recipients, present in `mail_get` and when the local index knows them. */
  cc?: string[]
  /**
   * `true` when `to`/`cc` are the real recipient lists — including a bind that returned an
   * empty list ("no recipients" is an answer). `false` when the local index only holds the
   * envelope: `mail_list`/`mail_search` then try to fill them from EWS lazily.
   */
  recipientsKnown?: boolean
  received: string
  isRead: boolean
  hasAttachments: boolean
  /** EWS `ItemSize` in bytes, when the item summary carried it (Find/Sync/Get). */
  size?: number
  /**
   * Number of attachments when known. 0 may be derived from `hasAttachments: false` for
   * cached rows; absent for a sync-only row with attachments until a live bind. Inline
   * attachments are counted too, and a cached value can be stale after attachments change.
   */
  attachmentCount?: number
  preview: string
  conversationId?: string
  folderId?: string
  /** Present when `mail_search` matched the text of an attachment cached under `storage: full`. */
  attachmentMatch?: {
    id: string
    name: string
    snippet: string
  }
}

export interface MessageDetail extends MessageSummary {
  body: string
  bodyType: "html" | "text"
  truncated: boolean
  cc: string[]
  /**
   * `true` when this call produced the body (a fresh EWS bind or a cache hit). An empty body
   * that was really fetched is still `fetched: true`; `false`/absent means "no body available".
   */
  fetched?: boolean
  /** `true` when the body is stored in the local index (`bodies` row exists) after this call. */
  bodyCached: boolean
}

export interface SyncResult {
  synced: number
  /** `false` when the round budget ran out while EWS still reported more changes. */
  complete: boolean
  /** Set when the folder is not indexed at all, instead of a silent `{synced: 0}`. */
  skipped?: "not-indexed" | "storage-off"
}

export interface DeleteResult {
  deleted: number
  /** `soft` moves to Deleted Items; `hard` permanently deletes. */
  mode: "soft" | "hard"
}

export interface OutgoingAttachment {
  name: string
  contentBase64: string
  /** Content-ID referenced as `cid:<contentId>` from an HTML body. */
  contentId?: string
  /** Inline attachments are hidden from the attachment list and referenced by `cid:`. */
  isInline?: boolean
}

export interface AttachmentInfo {
  /** EWS attachment id, usable as `attachmentId` in `mail_read_attachment`. */
  id: string
  name: string
  contentType: string
  /** Size reported by EWS, bytes (0 when unknown). */
  size: number
  isInline: boolean
  /** `item` attachments are embedded messages and cannot be read as files. */
  kind: "file" | "item"
}

export interface AttachmentText {
  messageId: string
  attachment: AttachmentInfo
  kind: "word" | "excel" | "pdf" | "text"
  text: string
  /** `true` when the extracted text was cut to `maxChars`. */
  truncated: boolean
  /** PDF only. */
  pages?: number
  /** Spreadsheet only, workbook order. */
  sheets?: string[]
  /** Set when the format is supported but no text could be extracted. */
  note?: string
}

export interface OutgoingMessage {
  to: string[]
  cc?: string[]
  subject: string
  body: string
  bodyType?: "html" | "text"
  attachments?: OutgoingAttachment[]
}

export interface CalendarEvent {
  id: string
  subject: string
  start: string
  end: string
  location: string
  isAllDay: boolean
  organizer: string
}

export interface ContactDto {
  id: string
  displayName: string
  email: string
  company: string
}

export interface MailBackend {
  listFolders(): Promise<FolderDto[]>
  syncFolder(folder: string): Promise<SyncResult>
  listMessages(input: { folder?: string; limit: number; offset?: number }): Promise<MessageSummary[]>
  searchMessages(input: { query: string; limit: number }): Promise<MessageSummary[]>
  getMessage(input: { id: string }): Promise<MessageDetail>
  /** Attachment metadata for one message (no content download). */
  listAttachments(input: { id: string }): Promise<AttachmentInfo[]>
  /** Download one file attachment and extract text from Word/Excel/PDF/plain text. */
  readAttachment(input: {
    id: string
    attachmentId?: string
    index?: number
    maxChars?: number
    signal?: AbortSignal
  }): Promise<AttachmentText>
  /** Soft-delete moves to Deleted Items; hard-delete is permanent. */
  deleteMessages(input: { ids: string[]; hard?: boolean }): Promise<DeleteResult>
  /** Permanently empties Deleted Items (EWS `EmptyFolder` + `HardDelete`). */
  emptyDeleted(): Promise<{ emptied: true }>
  /** EWS `Send` returns no item id: the result only confirms the server accepted the message. */
  send(input: OutgoingMessage): Promise<{ sent: true }>
  saveDraft(input: OutgoingMessage): Promise<{ id: string }>
  listCalendar(input: { from?: string; to?: string; limit: number }): Promise<CalendarEvent[]>
  listContacts(input: { query?: string; limit: number }): Promise<ContactDto[]>
  close(): void
}

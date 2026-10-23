import {
  BasePropertySet,
  EmailMessageSchema,
  ExchangeService,
  ExchangeVersion,
  FolderId,
  FolderTraversal,
  FolderView,
  ItemSchema,
  PropertySet,
  Uri,
  WebCredentials,
  WellKnownFolderName,
} from "ews-javascript-api"
import type { MailConfig } from "./config"
import type { MessageSummary } from "./types"

const WELL_KNOWN: Record<string, WellKnownFolderName> = {
  inbox: WellKnownFolderName.Inbox,
  входящие: WellKnownFolderName.Inbox,
  sent: WellKnownFolderName.SentItems,
  sentitems: WellKnownFolderName.SentItems,
  отправленные: WellKnownFolderName.SentItems,
  drafts: WellKnownFolderName.Drafts,
  черновики: WellKnownFolderName.Drafts,
  deleted: WellKnownFolderName.DeletedItems,
  deleteditems: WellKnownFolderName.DeletedItems,
  удаленные: WellKnownFolderName.DeletedItems,
  удалённые: WellKnownFolderName.DeletedItems,
  calendar: WellKnownFolderName.Calendar,
  календарь: WellKnownFolderName.Calendar,
  contacts: WellKnownFolderName.Contacts,
  контакты: WellKnownFolderName.Contacts,
  tasks: WellKnownFolderName.Tasks,
  задачи: WellKnownFolderName.Tasks,
  root: WellKnownFolderName.MsgFolderRoot,
}

export const MESSAGE_PROPERTY_SET = new PropertySet(BasePropertySet.FirstClassProperties, [
  ItemSchema.Body,
  ItemSchema.Preview,
  EmailMessageSchema.From,
  EmailMessageSchema.ToRecipients,
  EmailMessageSchema.CcRecipients,
])

/** SyncFolderItems rejects non-summary properties (Body, ToRecipients, ...): base set only. */
export const SYNC_PROPERTY_SET = new PropertySet(BasePropertySet.FirstClassProperties)

/**
 * One ExchangeService per account: the library keeps mutable auth/cookie state
 * inside the service and the global XHR provider, so sharing across accounts
 * is unsafe.
 */
export function createEwsService(config: MailConfig): ExchangeService {
  const service = new ExchangeService(ExchangeVersion.Exchange2016)
  service.Credentials = new WebCredentials(config.username, config.password)
  service.Url = new Uri(config.ewsUrl)
  return service
}

export function wellKnownFolder(name: string | undefined): WellKnownFolderName | undefined {
  if (!name) return WellKnownFolderName.Inbox
  return WELL_KNOWN[name.trim().toLowerCase()]
}

export async function resolveFolderId(service: ExchangeService, folder?: string): Promise<FolderId> {
  const known = wellKnownFolder(folder)
  if (known !== undefined) return new FolderId(known)
  if (!folder) return new FolderId(WellKnownFolderName.Inbox)

  const view = new FolderView(500)
  view.Traversal = FolderTraversal.Deep
  const result = await service.FindFolders(new FolderId(WellKnownFolderName.MsgFolderRoot), view)
  const match = result.Folders.find((candidate) => candidate.DisplayName?.toLowerCase() === folder.trim().toLowerCase())
  if (!match?.Id) throw new Error(`Folder not found: ${folder}`)
  return match.Id
}

export const iso = (value: unknown): string => {
  const date = value as { ToISOString?: () => string } | undefined
  try {
    return date?.ToISOString?.() ?? ""
  } catch {
    return ""
  }
}

export const addressList = (collection: unknown): string[] => {
  const typed = collection as { GetEnumerator?: () => Array<{ Address?: string }> } | undefined
  try {
    return (typed?.GetEnumerator?.() ?? []).map((entry) => entry.Address ?? "").filter(Boolean)
  } catch {
    return []
  }
}

export const address = (value: unknown): string => {
  const entry = value as { Address?: string; Name?: string } | undefined
  return entry?.Address ?? entry?.Name ?? ""
}

const safe = <T>(read: () => T, fallback: T): T => {
  try {
    return read() ?? fallback
  } catch {
    return fallback
  }
}

export function toSummary(item: unknown, folderId?: string, recipientsKnown = false): MessageSummary {
  const typed = item as {
    Id?: { UniqueId?: string }
    Subject?: string
    From?: unknown
    ToRecipients?: unknown
    CcRecipients?: unknown
    DateTimeReceived?: unknown
    IsRead?: boolean
    HasAttachments?: boolean
    Preview?: string
    ConversationId?: { UniqueId?: string }
  }
  const to = safe(() => addressList(typed.ToRecipients), [])
  const cc = safe(() => addressList(typed.CcRecipients), [])
  const summary: MessageSummary = {
    id: safe(() => typed.Id?.UniqueId ?? "", ""),
    subject: safe(() => typed.Subject ?? "", ""),
    from: safe(() => address(typed.From), ""),
    to,
    // `recipientsKnown` is passed explicitly by callers that requested recipient properties;
    // sync changes only carry the envelope, so a non-empty list still proves the data is real.
    recipientsKnown: recipientsKnown || to.length > 0 || cc.length > 0,
    received: safe(() => iso(typed.DateTimeReceived), ""),
    isRead: safe(() => typed.IsRead === true, false),
    hasAttachments: safe(() => typed.HasAttachments === true, false),
    preview: safe(() => (typed.Preview ?? "").slice(0, 300), ""),
    conversationId: safe(() => typed.ConversationId?.UniqueId, undefined),
    folderId,
  }
  if (cc.length > 0) summary.cc = cc
  return summary
}

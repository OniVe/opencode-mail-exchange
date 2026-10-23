# opencode-mail-exchange

**English** · [Русский](README.ru.md)

OpenCode V2 plugin for on-prem Exchange mail: EWS + NTLM, mail, calendar and contacts.
Bun + TypeScript + Biome, no build step — OpenCode loads `src/index.ts` directly.

## Status

Verified against a live server: **Exchange 2016** (build 15.1.2507.6), NTLMv2, internal CA.
Reading folders/messages, message bodies, search, calendar, contacts, drafts with attachments, and sending all work.

## Installation

```jsonc
// ~/.config/opencode/opencode.jsonc
{
  "plugins": [
    {
      "package": "file:///C:/path/to/opencode-mail-exchange",
      "options": {
        "storage": "metadata",
        "dataDir": "C:/Users/me/AppData/Local/opencode/mail-exchange",
        "accounts": [
          {
            "id": "primary",
            "ewsUrl": "https://exchange.example.com/EWS/Exchange.asmx",
            "username": "DOMAIN\\bot",
            "selfAddress": "bot@example.com"
          },
          {
            "id": "shared",
            "ewsUrl": "https://exchange.example.com/EWS/Exchange.asmx",
            "username": "DOMAIN\\sharedbot",
            "selfAddress": "shared@example.com"
          }
        ]
      }
    }
  ]
}
```

Passwords normally come from env, one per account; an inline `password` option is accepted but not recommended
(it would end up in `opencode.json`):

```bash
export MAIL_PASSWORD_PRIMARY='...'
export MAIL_PASSWORD_SHARED='...'
export NODE_EXTRA_CA_CERTS='/path/to/root-ca.pem'   # if EWS is behind an internal CA
```

`MAIL_PASSWORD` is the fallback when no per-account variable is set.

`NODE_EXTRA_CA_CERTS` is required when the EWS certificate is issued by an internal CA: Bun does not use
the Windows certificate store. In this stack the actual symptom is an opaque
`Exception: undefined is not an object (evaluating 'response.headers')` from `@ewsjs/xhr`
(timeouts produce the same symptom), not `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

## Configuration

URL, username, password and mailbox address have **no defaults** — they must come from `opencode.json` or env.
The repository contains no real hosts, credentials or addresses; examples use `example.com`.

| Option | Env | Default | Purpose |
|---|---|---|---|
| `accounts[]` | — | — | account list; without it, the top-level fields describe one account |
| `id` | — | `default` / `account-N` | account id used by the `account` argument; `[A-Za-z0-9][A-Za-z0-9._-]*`; used as a directory name under the `<dataDir>/<id>` layout |
| `ewsUrl` | `MAIL_EWS_URL` | — (required) | `https://server/EWS/Exchange.asmx` |
| `username` | `MAIL_USER` | — (required) | `DOMAIN\user` — NTLM requires the domain |
| `password` | `MAIL_PASSWORD_<ID>` / `MAIL_PASSWORD` | — (required) | password; env is recommended, inline `password` is accepted |
| `selfAddress` | `MAIL_SELF` | username part | mailbox address |
| `storage` | `MAIL_STORAGE` | `metadata` | `off` / `metadata` / `full` |
| `dataDir` | `MAIL_DATA_DIR` | Windows: `%LOCALAPPDATA%\opencode\mail-exchange\<hash>`; otherwise `~/.local/share/opencode/mail-exchange/<hash>` | root; with `accounts`, each account gets `<dataDir>/<id>` unless it sets its own `dataDir` (colliding directories raise `ConfigError`) |
| `maxMessages` | `MAIL_MAX_MESSAGES` | 2000 (max 20000) | local index size |
| `retentionDays` | `MAIL_RETENTION_DAYS` | 365 (max 3650) | record TTL |
| `maxBodyBytes` | `MAIL_MAX_BODY_BYTES` | 100000 (max 1,000,000) | body truncation (UTF-8 bytes) |
| `syncIntervalMinutes` | `MAIL_SYNC_INTERVAL_MINUTES` | 5 (max 1440) | how often the index is refreshed |
| `allowSend` | `MAIL_ALLOW_SEND` | `true` | allow `mail.send` (`true/false/1/0/yes/no/on/off`, case-insensitive) |
| `requestTimeoutMs` | `MAIL_REQUEST_TIMEOUT_MS` | 30000 | EWS request timeout, ms (≤120000); passed to `XhrApi` |
| `codemode` | `MAIL_CODEMODE` | `false` | `false` — tools are listed directly; `true` — only through Code Mode `execute` (global, not per-account) |
| `caFile` | `MAIL_CA_FILE` | — | path to a PEM; checked for existence and used for a `NODE_EXTRA_CA_CERTS` hint (TLS trust itself is configured only via that env var) |

Top-level options are inherited by `accounts[]` entries; per-account values win.

## Tools

| Tool | What it does |
|---|---|
| `mail_accounts` | list accounts (id, address) |
| `mail_folders` | list folders with unread/total counts |
| `mail_list` | messages in a folder (metadata, paging; recipients are enriched lazily from EWS) |
| `mail_search` | local FTS first, EWS fallback (recipients are enriched lazily too) |
| `mail_get` | message + body (with a limit); `fetched` — the body was obtained by this call (bind or cache), `bodyCached` — the body is stored in the local index |
| `mail_sync` | incremental `SyncFolderItems`; returns `{synced, complete}` |
| `mail_draft` | create a draft (does not send) |
| `mail_send` | send (permission `mail.send`); result is `{sent: true}` — EWS `Send` does not return an id |
| `mail_calendar` | events in a time range |
| `mail_contacts` | contacts; `query` scans up to 500 contacts page by page (the last page is clipped to the remaining budget; EWS cannot do substring matching on `EmailAddresses`), then filters locally |

All tools use the plugin's `codemode` option: by default `false`, so the model calls them directly rather than
through Code Mode `execute`. `codemode: true` hides direct calls and leaves only `execute` (useful when the tool
catalog grows). The option is global: tools are registered once, and a per-account value is ignored.
The `account` argument (an id from `mail_accounts`) selects the mailbox; the first account is the default.

**Recipients in `mail_list`/`mail_search`.** `SyncFolderItems` does not return `To`/`Cc`, so index rows may only
know the envelope. For such a page, `mail_list`/`mail_search` performs one `BindToItems`
(`ToRecipients` + `CcRecipients`) and caches the result; `mail_get` also updates `to`/`cc` in the index.
`recipientsKnown: true` — `to`/`cc` are reliable (including when bind returned an empty list: "no recipients" is an
answer, not an unknown); `recipientsKnown: false` — enrichment failed or did not fit the budget, `to` is empty and
`cc` is omitted; a bind failure does not break the page.

Enrichment never blocks the response: it has its own budget of `min(2000, max(500, requestTimeoutMs/5))` ms.
If the bind does not fit, the page is returned with `recipientsKnown: false` and enrichment is parked for 60 s
(subsequent `mail_list` calls do not hit EWS for recipients during that window).

**Tool errors.** A failed tool is a successful `Result` with `content: "ERROR: ..."` and `metadata.error: true`:
the host sees the call as `completed` rather than failed and receives the error text. This is a deliberate
convention — `Tool.Error` is not used. Stack traces are not returned; SOAP errors keep `Message` and `ErrorCode`,
transport errors (timeout/TLS) are translated into an actionable message.

**Sync.** `mail_sync` returns `{synced, complete}`: `complete: false` means 50 rounds were not enough to drain
all changes (`MoreChangesAvailable` is still true) — call it again. For non-indexable folders (calendar, contacts, …)
and with `storage: "off"` it returns `{synced: 0, complete: true, skipped: "not-indexed" | "storage-off"}`
instead of a silent success.

## Verified limits

- **HTML body**: `ews-javascript-api` writes text into SOAP without XML escaping; the plugin escapes subject, body,
  recipient names and attachment names. Without this, HTML is stored empty **without an error**, and
  `a&b.txt` / `Name <address>` are rejected by EWS ("request failed schema validation").
- **Inline images**: attachments support `contentId` and `isInline` (schema of `mail_draft`/`mail_send`); the plugin
  sets `FileAttachment.ContentId`/`IsInline`, and the HTML body references `cid:<contentId>`. Verified on
  draft/send/receive.
- **Attachments**: plugin-side limits are **40 MB decoded per attachment** and **10 attachments per message**;
  they are checked before the EWS request and return `Attachment too large: …` / `Too many attachments: …`.
  HTTP 413 (the IIS/EWS request limit) is reachable only if the local check is disabled or bypassed (a direct EWS
  call outside the plugin); the plugin still maps it to "attachment too large". Memory is ~3.5–4.2× the file size.
- **Cold start**: ~730 ms (285 ms import + 445 ms first EWS call), RSS ~86 MB.
- **Multiple mailboxes**: one process, a shared `ConfigurationApi`; credentials are routed through
  `AsyncLocalStorage` + one `XhrApi` per account.

## Storage

SQLite (`bun:sqlite`, WAL, FTS5) under `dataDir` (with `accounts`, `<dataDir>/<id>/mail.db`):

- `off` — no index, everything goes through EWS;
- `metadata` — headers, preview, FTS; bodies on demand;
- `full` — plus a body cache (up to `maxBodyBytes`).

The database is **not** stored in the project: otherwise messages would leak into agent context and git.
Contents are plaintext; use BitLocker/EFS if that is a requirement.

## Limitations

- EWS on-prem; Exchange Online needs a Graph backend (not implemented).
- Attachments: sending uses base64 in the argument; reading attachments is not implemented yet.
- `mail_move`, flags, reply/forward are not implemented (next iteration).
- EPA on FE EWS: verified that the mode is not `Require`; `None`/`Allow` cannot be distinguished from the client.

Accepted risks and boundaries — `risks.md` (M7 — in-flight request cancellation — is closed).

## Development

```bash
bun install
bun run typecheck
bun test
bun run lint
```

Live smoke (read-only): `lab/smoke.ts` — see `lab/spike-ews/README.md` for env and CA setup.

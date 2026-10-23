# opencode-mail-exchange

[English](README.md) · **Русский**

Плагин OpenCode V2 для почты Exchange (on-prem): EWS + NTLM, почта, календарь, контакты.
Bun + TypeScript + Biome, без сборки — OpenCode загружает `src/index.ts` напрямую.

## Статус

Проверено на живом сервере: **Exchange 2016** (build 15.1.2507.6), NTLMv2, внутренний CA.
Чтение папок/писем, тело письма, поиск, календарь, контакты, черновик с вложением, отправка — работают.

## Установка

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

Пароли обычно берутся из env, по одному на аккаунт; inline-опция `password` принимается, но не рекомендуется
(она попадёт в `opencode.json`):

```bash
export MAIL_PASSWORD_PRIMARY='...'
export MAIL_PASSWORD_SHARED='...'
export NODE_EXTRA_CA_CERTS='/path/to/root-ca.pem'   # если EWS за внутренним CA
```

`MAIL_PASSWORD` используется как общий fallback, если per-account переменная не задана.

`NODE_EXTRA_CA_CERTS` обязателен, если сертификат EWS выпущен внутренним CA: Bun не использует
хранилище сертификатов Windows. Фактический симптом в этом стеке — непрозрачный
`Exception: undefined is not an object (evaluating 'response.headers')` из `@ewsjs/xhr`
(тот же симптом даёт и таймаут), а не `UNABLE_TO_VERIFY_LEAF_SIGNATURE`.

## Конфигурация

URL, логин, пароль и адрес ящика **не имеют значений по умолчанию** — задаются только через `opencode.json` или env.
В репозитории нет реальных хостов, учёток и адресов; в примерах — `example.com`.

| Опция | Env | По умолчанию | Назначение |
|---|---|---|---|
| `accounts[]` | — | — | список аккаунтов; без него верхнеуровневые поля описывают один аккаунт |
| `id` | — | `default` / `account-N` | id аккаунта для аргумента `account`; `[A-Za-z0-9][A-Za-z0-9._-]*`; используется как имя каталога в схеме `<dataDir>/<id>` |
| `ewsUrl` | `MAIL_EWS_URL` | — (обязательно) | `https://server/EWS/Exchange.asmx` |
| `username` | `MAIL_USER` | — (обязательно) | `DOMAIN\user` — NTLM требует домен |
| `password` | `MAIL_PASSWORD_<ID>` / `MAIL_PASSWORD` | — (обязательно) | пароль; рекомендуется env, inline `password` принимается |
| `selfAddress` | `MAIL_SELF` | имя из username | адрес ящика |
| `storage` | `MAIL_STORAGE` | `metadata` | `off` / `metadata` / `full` |
| `dataDir` | `MAIL_DATA_DIR` | Windows: `%LOCALAPPDATA%\opencode\mail-exchange\<hash>`; иначе `~/.local/share/opencode/mail-exchange/<hash>` | корень; при `accounts` каждый аккаунт получает `<dataDir>/<id>`, если не задал свой `dataDir` (совпадение каталогов — `ConfigError`) |
| `maxMessages` | `MAIL_MAX_MESSAGES` | 2000 (max 20000) | размер локального индекса |
| `retentionDays` | `MAIL_RETENTION_DAYS` | 365 (max 3650) | TTL записей |
| `maxBodyBytes` | `MAIL_MAX_BODY_BYTES` | 100000 (max 1 000 000) | обрезка тела (в байтах UTF-8) |
| `syncIntervalMinutes` | `MAIL_SYNC_INTERVAL_MINUTES` | 5 (max 1440) | как часто обновлять индекс |
| `allowSend` | `MAIL_ALLOW_SEND` | `true` | разрешить `mail.send` (`true/false/1/0/yes/no/on/off`, без учёта регистра) |
| `requestTimeoutMs` | `MAIL_REQUEST_TIMEOUT_MS` | 30000 | таймаут EWS-запроса, мс (≤120000); передаётся в `XhrApi` |
| `codemode` | `MAIL_CODEMODE` | `false` | `false` — tools видны напрямую; `true` — только через Code Mode `execute` (глобально, не per-account) |
| `caFile` | `MAIL_CA_FILE` | — | путь к PEM; проверяется на существование и используется для подсказки про `NODE_EXTRA_CA_CERTS` (само доверие TLS задаётся только этой env) |

Верхнеуровневые опции наследуются записями `accounts[]`; значения аккаунта перекрывают их (кроме `codemode` — он глобальный).

## Инструменты

| Tool | Что делает |
|---|---|
| `mail_accounts` | список аккаунтов (id, адрес, EWS URL, режим хранения) |
| `mail_folders` | список папок с unread/total |
| `mail_list` | письма в папке (метаданные, пагинация; получатели лениво добираются из EWS) |
| `mail_search` | поиск: локальный FTS, иначе EWS (получатели так же лениво) |
| `mail_get` | письмо + тело (с лимитом); `fetched` — тело получено этим вызовом (bind или кэш), `bodyCached` — тело лежит в локальном индексе |
| `mail_sync` | инкрементальный `SyncFolderItems`; возвращает `{synced, complete}` |
| `mail_draft` | черновик (не отправляет) |
| `mail_send` | отправка (permission `mail.send`); результат `{sent: true}` — EWS `Send` не возвращает Id |
| `mail_calendar` | события за период |
| `mail_contacts` | контакты; `query` сканирует до 500 контактов страницами (последняя страница урезается до остатка бюджета; EWS не умеет substring по EmailAddresses), затем фильтр локально |

Все инструменты регистрируются с `codemode` из опции плагина: по умолчанию `false` — модель вызывает их напрямую, не через Code Mode `execute`. `codemode: true` скрывает прямые вызовы и оставляет только `execute` (полезно, если каталог инструментов разрастается). Опция глобальная: инструменты регистрируются один раз, per-account значение игнорируется.
Параметр `account` (id из `mail_accounts`) выбирает ящик; по умолчанию — первый аккаунт.
Права инструментов: `mail.read` для чтения, `mail.draft` для черновиков, `mail.send` для отправки.

**Получатели в `mail_list`/`mail_search`.** `SyncFolderItems` не приносит `To`/`Cc`, поэтому строки индекса
могут знать только конверт. Для такой страницы `mail_list`/`mail_search` делают один `BindToItems`
(`ToRecipients` + `CcRecipients`) и кэшируют результат; `mail_get` тоже обновляет `to`/`cc` в индексе.
`recipientsKnown: true` — `to`/`cc` достоверны (в том числе когда bind вернул пустой список: «получателей нет» —
это ответ, а не неизвестность); `recipientsKnown: false` — добрать не удалось (bind упал или не уложился в бюджет),
`to` пуст, `cc` отсутствует; ошибка bind не ломает выдачу страницы.

Обогащение получателей не блокирует выдачу: у него свой бюджет `min(2000, max(500, requestTimeoutMs/5))` мс.
Если bind не уложился — страница возвращается с `recipientsKnown: false`, а обогащение паркуется на 60 с
(повторные `mail_list` это время не ходят в EWS за получателями).

**Ошибки инструментов.** Провал инструмента — это успешный `Result` с `content: "ERROR: ..."` и
`metadata.error: true`: хост видит вызов завершённым (`completed`), а не упавшим, и получает текст ошибки.
Это осознанная конвенция — `Tool.Error` не используется. Стек-трейсы не отдаются; у SOAP-ошибок сохраняются
`Message` и `ErrorCode`, транспортные (таймаут/TLS) переводятся в actionable-сообщение.

**Синхронизация.** `mail_sync` возвращает `{synced, complete}`: `complete: false` — за 50 раундов выбраны не все
изменения (`MoreChangesAvailable` всё ещё true), повторите вызов. Для неиндексируемых папок (календарь,
контакты, …) и при `storage: "off"` — `{synced: 0, complete: true, skipped: "not-indexed" | "storage-off"}`
вместо тихого успеха.

## Проверенные ограничения

- **HTML-тело**: `ews-javascript-api` пишет текст в SOAP без XML-экранирования; плагин экранирует subject, body, имена получателей и вложений. Без этого HTML сохраняется пустым **без ошибки**, а `a&b.txt`/`Имя <адрес>` дают отказ EWS («Запрос не прошел проверку на соответствие схеме»).
- **Inline-картинки**: у вложения есть `contentId` и `isInline` (schema `mail_draft`/`mail_send`); плагин проставляет `FileAttachment.ContentId`/`IsInline`, в HTML тело ссылается `cid:<contentId>`. Проверено на draft/send/receive.
- **Вложения**: локальные лимиты плагина — **40 МБ decoded на вложение** и **10 вложений на письмо**; проверяются
  до EWS-запроса и дают `Attachment too large: …` / `Too many attachments: …`. HTTP 413 (лимит запроса IIS/EWS)
  достижим только если локальная проверка отключена или обойдена (прямой вызов EWS мимо плагина); в плагине он
  всё равно переводится в «attachment too large». Память ~3.5–4.2× размера файла.
- **Холодный старт**: ~730 мс (import 285 мс + первый EWS-вызов 445 мс), RSS ~86 МБ.
- **Несколько ящиков**: один процесс, общий `ConfigurationApi`; маршрутизация credentials — через `AsyncLocalStorage` + `XhrApi` на аккаунт.

## Хранение

SQLite (`bun:sqlite`, WAL, FTS5) в `dataDir` (при `accounts` — `<dataDir>/<id>/mail.db`):

- `off` — индекс не ведётся, всё через EWS;
- `metadata` — заголовки, preview, FTS; тела по требованию;
- `full` — плюс кэш тел (до `maxBodyBytes`).

БД **не** кладётся в проект: иначе письма попадут в контекст агентов и в git. Содержимое — plaintext;
используйте BitLocker/EFS, если это требование.

## Ограничения

- EWS on-prem; для Exchange Online нужен Graph-бэкенд (не реализован).
- Вложения: отправка — base64 в аргументе; чтение вложений пока не реализовано.
- `mail_move`, флаги, ответы/пересылка — не реализованы (следующая итерация).
- EPA на FE EWS: проверено, что режим не `Require`; `None`/`Allow` с клиента не различаются.

Принятые риски и границы — `risks.md` (M7 — отмена in-flight запросов — закрыт).

## Разработка

```bash
bun install
bun run typecheck
bun test
bun run lint
```

Живой smoke (read-only): [lab/smoke.ts](https://github.com/OniVe/opencode-mail-exchange/blob/main/lab/smoke.ts) — см.
[lab/spike-ews/README.md](https://github.com/OniVe/opencode-mail-exchange/blob/main/lab/spike-ews/README.md) про env и CA.

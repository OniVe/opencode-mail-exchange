# Принятые риски

## M7 (закрыт 2026-10-23)

Отмена in-flight EWS-запроса реализована: `context.signal` из tool-execute → `MailService.run` → `AsyncLocalStorage` → axios-интерцептор (`src/xhr-router.ts`); отмена возвращает `EWS request cancelled`. Покрыто тестом `xhr-router` (abort висящего запроса) и `service` (маппинг `ERR_CANCELED`). Ограничение `requestTimeoutMs` остаётся верхней границей.

## Прочие риски

- Локальный индекс — plaintext SQLite; защита — ACL/BitLocker, не шифрование плагина.
- `ews-javascript-api` полу-поддерживается (последний релиз — 0.15.3, 2024-05-13); обновления проверять отдельно.
- Для отмены запросов плагин процесс-глобально патчит CJS-инстанс axios (`createRequire` + `axios.create`); вне ALS-контекста интерцептор no-op, но патч не снимается при выгрузке. При отсутствии `node_modules` отмена отключается с warning, таймаут остаётся.
- EWS в Exchange Online выключается (01.10.2026 блокировка, 01.04.2027 shutdown); для EXO нужен Graph-бэкенд (не реализован).
- `uuid@9.0.1` (transitive: `ews-javascript-api` → `@azure/msal-node` → `uuid`): moderate GHSA-w5hq-g745-h8pq (buffer bounds in v3/v5/v6 with `buf`). NTLM-путь MSAL/uuid не использует; исправление — uuid 11, вне диапазона зависимости. Пересмотреть вместе с R4 (форк/вендоринг `ews-javascript-api`).

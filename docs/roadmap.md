# Roadmap

Текущее состояние: 204 тестов; цикл аудита 2026-10-26 (XHR-провайдер) — в работе; опубликован 0.4.2. Ниже — запланированные фичи, не входящие в v0.1.

## R1. Шифрование локального индекса SQLite

**Приоритет:** P1. **Статус:** дизайн. **Требование:** поиск по телу письма обязателен.

Ограничение: `bun:sqlite` — обычный SQLite без SQLCipher; `PRAGMA key` отсутствует. Значит, «зашифровать файл целиком» внутри плагина нельзя.

### Режимы опции

```jsonc
{
  "storage": "metadata",
  "encryption": "off" | "body" | "all",
  "dbKeyEnv": "MAIL_DB_KEY"
}
```

- `off` — текущее поведение (plaintext).
- `body` — AES-256-GCM для `bodies.body` и `messages.preview`; subject/from/to/cc/даты/флаги — plaintext ради list/sort.
- `all` — плюс `subject`, `from`, `to`, `cc`; list требует дешифровки строк, FTS по метаданным отключается/уходит в EWS.

Ключ: `MAIL_DB_KEY` (base64, 32 байта) только из env; HKDF per-account; nonce на запись; ключ не логируется. Без ключа при `encryption != "off"` — `ConfigError`, не тихий plaintext.

### Поиск по телу при шифровании

- **Основной путь:** локальный body-FTS отключается; `mail_search` ищет по телу через EWS (`SearchFilter.ContainsSubstring(ItemSchema.Body, query)`) — сервер уже хранит plaintext, локальный индекс не нужен. Плюс: сохраняется substring-поиск. Минус: сетевой запрос ~0.5–1 с, нет офлайн-поиска.
- **Опционально (offline):** HMAC-токен-индекс: токены тела → HMAC-SHA256(key, token) → FTS5; запрос токенизируется и HMAC-уется. Работают точные слова и фразы, **не работают** prefix/substring/стемминг.
- Plaintext-FTS поверх зашифрованного тела не делать: индекс утекает содержимое.

### WAL и миграция

- Шифровать **до** вставки; иначе plaintext останется в `-wal`.
- `secure_delete=ON`, checkpoint/truncate при закрытии.
- Миграция существующей plaintext-БД: перешифровка в транзакции + перестройка индекса; без ключа — отказ.
- Ротация ключа: offline-перешифровка (скрипт) + пересборка индекса.

### Приёмка

- В `mail.db` нет plaintext тела/preview при `encryption=body`; в `-wal` после checkpoint — тоже.
- `mail_get` возвращает расшифрованное тело; `mail_search` по телу находит письмо через EWS.
- Без ключа — понятная ошибка, плагин не стартует в plaintext.
- Ключ не попадает в логи/ошибки; ротация описана и проверена.

### Открытые вопросы

- Модель угрозы: защита от кражи диска/файла или от локального пользователя с доступом к процессу? Во втором случае ключ в env не поможет.
- Нужен ли офлайн-поиск по телу (HMAC-токены) или достаточно EWS?
- Шифровать ли subject/from/to (режим `all`) — влияет на list/search и стоимость дешифровки.

## R2. Graph-бэкенд для Exchange Online

**Приоритет:** P2. **Статус:** план (фича, не фикс).

EWS в EXO: блокировка с 01.10.2026, shutdown 01.04.2027. Отдельный `GraphBackend` за `MailBackend`:
- `@azure/msal-node` (device code / app-only + RBAC for Applications);
- delta queries для sync, mail/calendar/contacts;
- маршрутизация по расположению ящика (on-prem → EWS, EXO → Graph);
- отдельные тесты и конфиг.

## R3. Свой XHR-провайдер вместо глобального патча axios

**Приоритет:** P1 (техдолг). **Статус:** готово.

Реализовано в `src/xhr-router.ts`: `MailXhrProvider` — свой `IXHRApi` на `axios` + `@ewsjs/ntlm-client`, с NTLM type1/type2/type3, `signal`, дедлайном обычного вызова (preflight+final) и inactivity-watchdog для стрима. `ConfigurationApi.ConfigureXHR(provider)` — единственная глобальная точка; `createRequire` и патч CJS-axios удалены, прямая зависимость `@ewsjs/xhr` убрана (транзитивная остаётся в `ews-javascript-api` и загружается его `XHRFactory`). Покрыто тестами: NTLM-обмен и тело SOAP, non-200 и обрезанное/оборванное тело с флагом `truncated`, таймаут preflight/final и idle-стрима, abort, `disconnect`/`dispose`, инъекция заголовков (CL/TE/Host/Auth, регистр), multi-scheme `WWW-Authenticate`, stream 200/404, UTF-8 на границе чанков, ровно один повторный handshake при 401; live-проверка на Exchange 2016 прошла.

Альтернатива vendor/patch `@ewsjs/xhr` больше не нужна.

## R4. Стратегия по `ews-javascript-api`

**Приоритет:** P1 (риск-менеджмент). **Статус:** решение.

- Краткосрочно: пин 0.15.3, адаптер-изоляция, контрактные тесты (уже есть), мониторинг SOAP-ошибок.
- Среднесрочно: форк/вендоринг с накопленными патчами (SOAP-экранирование, signal, HTTP 500, Node 24) под своим scope; MIT позволяет.
- Fallback при критических проблемах: Python-sidecar на `exchangelib` (надёжнее, но +процесс) или native NTLM (`node-libcurl`) при EPA `Require`.
- Долгосрочно: Graph для EXO (R2); для on-prem EWS остаётся поддерживаемым.

## R5. Runtime-проверка в OpenCode

**Приоритет:** P1 перед публикацией. **Статус:** не выполнено.

Установить плагин в `~/.config/opencode/opencode.json`, проверить в живой сессии:
- effective-имена `mail_*`;
- `codemode: false/true` (видимость/скрытие);
- срабатывание `permission` для `mail.send`/`mail.draft`;
- отмену tool-call (`context.signal`).

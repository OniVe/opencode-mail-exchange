# spike-ews

Живая проверка EWS + NTLM из Bun (23.10.2026). Результаты: `../../docs/spike-ews-2026-10-23.md`.

## Запуск

```bash
bun install

export EX_USER='<DOMAIN>\<user>'
export EX_PASS='...'
export EX_URL='https://<ews-host>/EWS/Exchange.asmx'
export EX_SELF='<mailbox>'
export NODE_EXTRA_CA_CERTS="$MAIL_CA_PEM"   # PEM корневого CA, если он внутренний

bun run spike.ts            # чтение: папки, inbox, календарь, контакты
bun run body.ts             # тело письма (EmailMessageSchema.Body)
bun run mail-ops.ts draft   # черновик + вложение + hard delete
bun run mail-ops.ts send    # отправка на себя + проверка доставки + удаление
bun run tls.ts              # диагностика TLS/заголовков
```

## Замечания

- URL, логин, пароль и адрес ящика берутся только из env; значений по умолчанию нет.
- `ca/` в репозитории отсутствует: корневой CA экспортируется локально в `lab/.certs/` (каталог в `.gitignore`).
- `mail-ops.ts send` отправляет реальное письмо на `EX_SELF` и удаляет его после проверки.
- `ews-javascript-api` — CJS; импорт named exports из ESM в Bun работает.
- Без `NODE_EXTRA_CA_CERTS` Bun падает с `UNABLE_TO_VERIFY_LEAF_SIGNATURE` (внутренний CA не в его bundle).

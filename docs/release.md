# Release

Пакет: `opencode-mail-exchange` (публичный, npm registry).

## Первый релиз (вручную)

Первый publish нельзя сделать через trusted publishing: пакета ещё нет на npm.

```bash
npm login                 # аккаунт с правом publish в scope opencode-mail-exchange
npm publish --access public
git tag v0.1.0
git push origin v0.1.0
```

Проверка:

```bash
npm view opencode-mail-exchange version
npm view opencode-mail-exchange dist.tarball
```

## Дальше — semantic-release

Репозиторий настроен как в `opencode-orchestrator-uni`:

- `release.config.cjs` — Conventional Commits; `fix` → patch, `feat` → minor, breaking → minor до 1.0.0;
- `.github/workflows/release.yml` — typecheck/lint/test → `semantic-release`;
- `.github/workflows/commitlint.yml` — проверка сообщений коммитов.

### Разовая настройка GitHub/npm

1. На npmjs.com: **Package settings → Trusted publishing** для `opencode-mail-exchange`:
   - owner/repo: `OniVe/opencode-mail-exchange`
   - workflow: `release.yml`
   - environment: пусто (или укажите, если добавите в workflow).
2. GitHub → Settings → Secrets and variables → Actions: добавить `RELEASE_TOKEN` (PAT с правом
   `contents: write`), потому что semantic-release пишет `refs/notes/*`.
3. После первого ручного publish и настройки trusted publisher workflow публикует следующие версии без
   `NPM_TOKEN`.

### Версии

| Коммит | Релиз |
|---|---|
| `fix:` | patch |
| `feat:` | minor |
| `feat!:` / `BREAKING CHANGE:` | minor (до 1.0.0) |
| `docs:` / `chore:` / `ci:` | без релиза |

## Локальная проверка пакета

```bash
bun run typecheck
bun run lint
bun test
npm pack --dry-run
```

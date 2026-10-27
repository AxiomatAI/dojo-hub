# Contributing to DojoHub

Thanks for helping! The basics:

1. `pnpm install`, `docker compose -f deploy/compose/compose.dev.yml up -d`, `cp .env.example .env`, `pnpm db:seed`.
2. Run the API (`pnpm --filter @dojohub/server dev`) and the UI (`pnpm --filter @dojohub/web dev`).
3. Before opening a PR: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm i18n:check`.

Guidelines:

- User-facing strings go in `packages/i18n/locales/*/common.json`. Add the key to every locale (`pnpm i18n:check` enforces parity, and Polish needs `_one/_few/_many/_other` plurals).
- Database changes: edit `packages/db/src/schema`, then `pnpm db:generate`. Never edit applied migrations.
- New API endpoints use the `Api.op()` helper, so they appear in the OpenAPI document.
- Security-sensitive changes (auth, distribution, scanner) need tests.
- Conventional Commits are appreciated.

By contributing you agree that your contributions are licensed under Apache-2.0.

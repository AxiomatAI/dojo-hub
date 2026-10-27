<div align="center">

<img src="apps/web/public/favicon.svg" width="64" height="64" alt="DojoHub logo">

# DojoHub

**The governed home for your organization's AI agent skills** — _道場_ (_dojo_, “place of practice”).

A self-hosted registry for [Agent Skills](https://agentskills.io) (`SKILL.md`) that works with Claude Code, Cursor, Codex, GitHub Copilot, Gemini CLI and other agents supported by the `skills` CLI.
Every skill is copied into your registry, scanned for security issues, checked by an LLM (bring your own key) and approved through your team's review path before anyone can install it.

[Quick start](#quick-start) · [Features](#features) · [Install skills](#install-skills-in-your-agent) · [Documentation](#documentation) · [Status](#status)

</div>

---

## Why DojoHub?

Agent skills contain instructions _and_ scripts that run with your agent's permissions. Public directories are unvetted, and installing straight from GitHub gives security teams no say. DojoHub sits in between:

- **Developers** submit or import skills and install approved ones with tools they already use: `npx skills`, or the `dojo` CLI.
- **Security** gets automated scans, an LLM verdict on whether a skill does what it claims, risky-asset flags, a kill switch and an audit log.
- **Teams** curate their own recommended skills and suites. The same skill can be recommended by several teams.

## Features

|                                |                                                                                                                                                                                                                                                                                           |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔐 **SSO**                     | OIDC and SAML presets for Entra ID, Google Workspace, Okta, Auth0 and Keycloak, plus generic OIDC/SAML. Local accounts are optional. IdP groups arrive through login claims, **SCIM 2.0**, or directory sync (Microsoft Graph, Google Directory) and map to organization and team roles.  |
| 🧭 **Teams & namespaces**      | `@team/skill` namespaces with owners, maintainers and reviewers. Team catalogs mark skills and suites as _required_, _recommended_ or _optional_.                                                                                                                                         |
| 📦 **Skills & suites**         | Full local copies (scripts, references, assets), immutable semver versions, diffs and provenance. Suites import from `.claude-plugin/marketplace.json`, `plugin.json`, Cursor plugins, or plain `skills/` folders.                                                                        |
| 🔁 **Downstream sources**      | GitHub, GitLab, any git repository, well-known endpoints, skills.sh, or archive uploads. Sources can sync on a schedule; upstream changes become new candidate versions that go through review.                                                                                           |
| 🛡️ **Security scan**           | Spec validation, static rules (remote script piping, reverse shells, exfiltration, persistence, prompt injection, hidden Unicode), secret detection, dependency checks (OSV, optional), per-file risk flags, and near-duplicate detection. Skill content is never executed.               |
| 🤖 **LLM verification (BYOK)** | Anthropic, OpenAI, Azure OpenAI, Amazon Bedrock, Google, or any OpenAI-compatible endpoint (Ollama, vLLM). Structured verdicts on safety, claim match and quality, plus LLM review of version diffs. An optional **external decision model** can be called over a signed HTTP contract.   |
| ✅ **Approval workflows**      | Per-team policies with automatic gates (max risk, blocking findings, claim score), multi-stage approvals by role, IdP group or user, conditional stages (`risk >= "medium" or has_asset("script")`), auto-approval of low-risk updates, trusted-source imports, and separation of duties. |
| 🚦 **Trust status**            | Draft → submitted → scanning → in review → approved, plus rejected, deprecated and **blocked**. Blocking removes a version from every distribution channel immediately.                                                                                                                   |
| 🔌 **Integrations**            | REST API with OpenAPI 3.1 docs at `/api/docs`, an **MCP server** at `/mcp`, signed **webhooks** (JSON, Slack, Microsoft Teams), and Prometheus metrics at `/metrics`.                                                                                                                     |
| 📊 **Dashboards**              | Installs over time and by channel, top skills, team adoption, risk distribution and review throughput.                                                                                                                                                                                    |
| 🌍 **i18n**                    | English (US and UK) and Polish. More languages can be added as locale folders.                                                                                                                                                                                                            |
| 🚢 **Deployment**              | One container image, Docker Compose, or a Helm chart. PostgreSQL with pgvector is the only required dependency. Skill files live on a volume or in any S3-compatible bucket.                                                                                                              |

## Quick start

These steps use Docker Compose. Build the image locally first, because no published image exists yet:

```bash
git clone <this-repository-url> dojohub && cd dojohub
docker build -t dojohub:local .
cp .env.example .env                       # set DOJO_BASE_URL and DOJO_SECRET_KEY
export DOJO_IMAGE=dojohub:local
docker compose -f deploy/compose/docker-compose.yml --env-file .env up -d
docker compose -f deploy/compose/docker-compose.yml logs dojohub | grep setup
```

Open the one-time setup link from the logs, then create your organization and first admin account. The onboarding wizard guides you through SSO, the LLM key, your first team and your first skills. You can upload a skill, write one in the browser, or import a suite from a curated list.

For Kubernetes, see [the Helm section](docs/self-hosting.md#helm).

## Install skills in your agent

```bash
# Standard skills CLI (vercel-labs/skills): no extra tooling needed
export DISABLE_TELEMETRY=1                                      # keep private registry URLs off skills.sh
npx skills add https://skills.acme.com/t/platform               # a team's catalog
npx skills add https://skills.acme.com/s/platform/pdf           # a single skill
SKILLS_API_URL=https://skills.acme.com npx skills find pdf      # search the registry

# dojo CLI: docker-style login, private teams, sync and submissions
dojo login https://skills.acme.com       # device flow; can configure git auth for `npx skills`
dojo sync --team platform                # install what the team requires and recommends
dojo add @security/dependency-audit
dojo submit ./my-skill --namespace platform
dojo audit                               # flags blocked or deprecated installs
```

Private teams are served over authenticated git (`npx skills add https://skills.acme.com/git/t/<team>.git`). `dojo login` registers a git credential helper, so the standard CLI works without extra configuration. See [docs/compatibility.md](docs/compatibility.md).

## Architecture

```
apps/server        Hono API · Better Auth (OIDC/SAML/SCIM) · well-known + git distribution · MCP · webhooks · worker (pg-boss)
apps/web           React 19 · TanStack Router/Query · Tailwind v4 · Radix UI · i18next
packages/core      SKILL.md parsing, repo and suite discovery, deterministic packaging, versions, diffs
packages/scanner   analyzers, LLM judge (Vercel AI SDK, BYOK), decision model, duplicate detection, risk aggregation
packages/db        Drizzle schema and migrations (tenant-ready: org_id on every table)
packages/contract  shared zod schemas and API types
packages/i18n      locale files (en-US, en-GB, pl)
packages/cli       `dojo` CLI (@axiomat/dojo)
deploy/            Docker Compose files and Helm chart
```

More in [docs/architecture.md](docs/architecture.md).

## Development

```bash
pnpm install
docker compose -f deploy/compose/compose.dev.yml up -d   # PostgreSQL, plus mailpit and a mock OIDC provider
cp .env.example .env
pnpm db:seed                                             # demo organization, teams, skills and reviews
pnpm --filter @dojohub/server dev                        # API on :3000
pnpm --filter @dojohub/web dev                           # UI on :5173
pnpm test                                                # unit tests; integration tests need DOJO_TEST_DATABASE_URL
pnpm i18n:check                                          # locale key parity
```

Seed account credentials are in `.env.example` and are for local development only.

## Status

DojoHub is early-stage software and has not been released.

- **Covered by automated tests:** skill parsing and packaging, scanner analyzers, the approval pipeline against PostgreSQL, and a CI job that installs skills with the stock `npx skills@1.7.4` CLI (`scripts/e2e-compat.sh`).
- **Verified by hand:** the Docker Compose stack, the web UI, the `dojo` CLI, and the well-known and git install paths.
- **Not yet verified:** SSO against real Entra ID, Google, Okta or SAML tenants; LLM verification against live provider APIs; email notifications (currently logged, not sent); and OAuth sign-in for MCP clients (MCP accepts access tokens only).
- **Not yet published:** the container image, the Helm chart and the `@axiomat/dojo` npm package.

## Documentation

- [Architecture](docs/architecture.md)
- [Self-hosting and configuration](docs/self-hosting.md)
- [SSO, groups and SCIM](docs/sso.md)
- [Approval policies](docs/policies.md)
- [Security scanning and LLM verification](docs/security-scanning.md)
- [External decision model](docs/decision-model.md)
- [Compatibility with `npx skills`](docs/compatibility.md)
- [`dojo` CLI](docs/cli.md)
- [REST API, MCP and webhooks](docs/integrations.md)
- [Architecture decision records](docs/adr/)

Contributing guidelines are in [CONTRIBUTING.md](CONTRIBUTING.md), and vulnerability reports go through [SECURITY.md](SECURITY.md).

## License

[Apache-2.0](LICENSE) © Axiomat and contributors.

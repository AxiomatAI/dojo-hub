<div align="center">

<img src="apps/web/public/favicon.svg" width="64" height="64" alt="DojoHub logo">

# DojoHub 道場

**The governed home for your organization's AI agent skills.**

Self-hosted, enterprise-grade registry for [Agent Skills](https://agentskills.io) (`SKILL.md`): used by Claude Code, Cursor, Codex, GitHub Copilot, Gemini CLI and 40+ other agents.
Every skill is copied locally, security-scanned, verified by an LLM (bring your own key) and approved through your own review path before anyone can install it.

[Quick start](#quick-start) · [Features](#features) · [Install skills](#install-skills-in-your-agent) · [Docs](docs/) · [Self-hosting](docs/self-hosting.md)

</div>

---

## Why DojoHub?

Agent skills are powerful: they're instructions _and_ scripts that run with your agent's permissions. Public directories are unvetted, and pulling skills straight from GitHub gives security teams no say. DojoHub sits in between:

- **Developers** submit or import skills, and install the approved ones with the tools they already use (`npx skills`, or the docker-like `dojo` CLI).
- **Security** gets an automated scan, an LLM verdict on "does it do what it claims?", risky-asset flags, a kill switch and an audit log.
- **Teams** curate their own recommended skills and suites; the same skill can be recommended by many teams.

## Features

|                                |                                                                                                                                                                                                                                                                                       |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 🔐 **SSO out of the box**      | OIDC and SAML presets for Entra ID, Google Workspace, Okta, Auth0, Keycloak; optional local accounts. IdP groups (claims, **SCIM 2.0**, Microsoft Graph / Google Directory sync) map to org and team roles.                                                                           |
| 🧭 **Teams & namespaces**      | `@team/skill` namespaces with owners, maintainers and reviewers. Team catalogs mark skills and suites as _required_, _recommended_ or _optional_.                                                                                                                                     |
| 📦 **Skills & suites**         | Full local copies (scripts, references, assets), immutable semver versions, diffs, provenance. Suites import from `.claude-plugin/marketplace.json`, `plugin.json`, Cursor plugins or plain `skills/` folders (anthropics/skills, mattpocock/skills, open-mercato/skills, pstack, …). |
| 🔁 **Downstream sources**      | GitHub, GitLab, any git, well-known endpoints, skills.sh, or archive uploads. Sync on a schedule; upstream changes become new candidate versions that go through review.                                                                                                              |
| 🛡️ **Security scan**           | Spec validation, static rules (curl \| sh, reverse shells, exfiltration, persistence, prompt injection, hidden Unicode), secret detection, dependency checks (OSV), per-file risk flags, near-duplicate detection (MinHash + optional embeddings). Skill content is never executed.   |
| 🤖 **LLM verification (BYOK)** | Anthropic, OpenAI, Azure OpenAI, Bedrock, Google or any OpenAI-compatible endpoint (Ollama, vLLM). Structured verdict on safety, claim match and quality, plus LLM review of version diffs. Optional **external decision model** over a signed HTTP contract.                         |
| ✅ **Approval workflows**      | Per-team policy: automatic gates (max risk, blocking rules, claim score), multi-stage approvals by role, IdP group or user, conditional stages (`risk >= "medium" or has_asset("script")`), auto-approval of low-risk updates, trusted-source imports, separation of duties.          |
| 🚦 **Trust status**            | Draft → submitted → scanning → under review → approved, plus rejected, deprecated and **blocked** (an instant kill switch across every distribution channel).                                                                                                                         |
| 🔌 **Integrations**            | REST API (OpenAPI 3.1 at `/api/docs`), **MCP server** at `/mcp`, signed **webhooks** (JSON, Slack, Teams), Prometheus `/metrics`.                                                                                                                                                     |
| 📊 **Dashboards**              | Installs over time and by channel, top skills, team adoption, risk distribution, review throughput.                                                                                                                                                                                   |
| 🌍 **i18n**                    | English (US/UK) and Polish, with more languages to follow.                                                                                                                                                                                                                            |
| 🚢 **Deploy anywhere**         | One image, `docker compose` or Helm. Postgres (+pgvector) is the only dependency; blobs go to a volume or any S3-compatible store.                                                                                                                                                    |

## Quick start

```bash
git clone https://github.com/axiomat/dojohub && cd dojohub
cp .env.example .env            # set DOJO_BASE_URL and DOJO_SECRET_KEY
docker compose -f deploy/compose/docker-compose.yml --env-file .env up -d
docker compose -f deploy/compose/docker-compose.yml logs dojohub | grep setup
```

Open the printed one-time setup link, create the organization and the first admin. The onboarding wizard then walks you through SSO, the LLM key, your first team and your first skills (upload one, write one in the browser, or import a suite from a curated list).

Kubernetes: see [docs/self-hosting.md](docs/self-hosting.md#helm).

## Install skills in your agent

```bash
# Standard skills CLI (vercel-labs/skills): no extra tooling needed
export DISABLE_TELEMETRY=1
npx skills add https://skills.acme.com/t/platform          # a team's catalog
npx skills add https://skills.acme.com/s/platform/pdf      # one skill
SKILLS_API_URL=https://skills.acme.com npx skills find pdf  # search DojoHub

# dojo CLI: docker-style login, private teams, sync, submissions
npm i -g @axiomat/dojo
dojo login https://skills.acme.com      # device flow; configures git auth for `npx skills`
dojo sync --team platform               # install everything the team requires/recommends
dojo add @security/dependency-audit
dojo submit ./my-skill --namespace platform
dojo audit                              # flags blocked/deprecated installs
```

Private teams are served over authenticated git (`npx skills add https://skills.acme.com/git/t/<team>.git`); `dojo login` registers a git credential helper so the standard CLI works transparently. See [docs/compatibility.md](docs/compatibility.md).

## Architecture

```
apps/server     Hono API · Better Auth (OIDC/SAML/SCIM) · well-known + git distribution · MCP · webhooks · worker (pg-boss)
apps/web        React 19 · TanStack Router/Query · Tailwind v4 · Radix · i18next
packages/core   SKILL.md parsing, repo/suite discovery, deterministic packaging, versions, diffs
packages/scanner  analyzers, LLM judge (AI SDK, BYOK), decision model, duplicates, risk aggregation
packages/db     Drizzle schema + migrations (tenant-ready: org_id everywhere)
packages/cli    `dojo` CLI (@axiomat/dojo)
deploy/         docker compose + Helm chart
```

More in [docs/architecture.md](docs/architecture.md).

## Development

```bash
pnpm install
docker compose -f deploy/compose/compose.dev.yml up -d   # Postgres (+ mailpit, mock OIDC IdP)
cp .env.example .env
pnpm db:seed                                             # demo org, teams, skills and reviews
pnpm --filter @dojohub/server dev                        # API on :3000
pnpm --filter @dojohub/web dev                           # UI on :5173
pnpm test                                                # unit + integration tests
```

Seed accounts are listed in `.env.example` (local development only).

## License

[Apache-2.0](LICENSE) © Axiomat and contributors.

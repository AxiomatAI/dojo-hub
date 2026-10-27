# Architecture

DojoHub is a TypeScript monorepo shipped as **one container image** with three entrypoints:

| Command   | Role                                                                                                                          |
| --------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `server`  | HTTP: REST API (`/api/v1`), Better Auth (`/api/auth`), SCIM (`/scim/v2`), MCP (`/mcp`), well-known + git distribution, web UI |
| `worker`  | Background jobs (pg-boss on Postgres): scans, suite evaluation, webhooks, source sync, directory sync, embeddings             |
| `migrate` | Applies database migrations (also run automatically by `server`)                                                              |
| `all`     | server + worker in one process (small installs)                                                                               |

The only required dependency is **PostgreSQL 15+ with pgvector**. Blobs (every file of every version) are content-addressed (`blobs/sha256/…`) on a volume or any S3-compatible store.

## Domain model

- **Organization**: every table carries `org_id`. Self-hosted installs run one org; the schema is ready for multi-tenant hosting.
- **Namespace**: `@org` (global) and teams (`@platform`). Visibility: public, internal or private. Members have roles: owner, maintainer, reviewer, member. IdP group mappings grant org and team roles.
- **Skill → Skill version**: the name is unique per org, because agents install by directory name. Each version is an immutable snapshot (files, frontmatter, content hash, deterministic tar.gz digest, provenance, transformations).
- **Suite → Suite version**: pins exact skill versions, with an optional entry skill (e.g. a `setup-*` skill). Plugin assets (agents, docs, logos) are stored as suite assets.
- **Catalog entry**: a team recommends a skill or suite (required, recommended or optional, optionally pinned).
- **Source → Source item**: an upstream repository and the skills/suites discovered in it. Imports always copy content locally.
- **Approval request → stages → decisions**: an instantiated snapshot of the namespace policy.
- **Scan runs, duplicate matches, install events, daily stats, webhooks, audit log.**

## Trust status machine

```
draft ─submit─▶ submitted ─▶ scanning ─┬─▶ approved (published)
                                       ├─▶ in_review ─approve─▶ approved
                                       │            └─reject/changes─▶ rejected / draft
                                       └─▶ rejected (policy gate)
approved ─▶ deprecated ─▶ approved
approved/deprecated ─▶ blocked (kill switch) ─▶ approved
```

Only `approved` and `deprecated` versions are installable. `blocked` removes a version from every channel (well-known, git, API, MCP) immediately.

## Pipeline

1. **Ingest**: validate against the Agent Skills spec, apply transformations (name prefix, vendoring of files referenced outside the skill), store blobs, build a deterministic archive.
2. **Scan** (worker): structure, static rules, secrets, asset flags, dependencies, LLM judge (BYOK), decision model, duplicates. The results are aggregated into a risk score and level.
3. **Decide**: policy gates (auto-reject), auto-approval rules (low-risk updates, trusted imports), else an approval request with conditional stages.
4. **Publish**: approved versions appear in team catalogs, well-known indexes, git repositories, the API and MCP. Suites containing the version are re-evaluated.

## Distribution

- **Well-known** (`/t/<team>`, `/s/<ns>/<skill>`, `/suites/<ns>/<suite>`): implements the agent-skills discovery RFC v0.2.0 that the stock `skills` CLI uses. Archives are tar.gz files with `SKILL.md` at the root and sha256 digests.
- **Git smart-HTTP** (`/git/...`): read-only repositories materialised from the database with deterministic commits (identical across replicas), with one tag per version. Authenticated with a PAT over HTTP Basic, so it works with git credential helpers.
- **Search** (`/api/search`): compatible with `SKILLS_API_URL` for `npx skills find`.

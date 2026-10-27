# Self-hosting

## Docker compose

```bash
cp .env.example .env
# Required: DOJO_BASE_URL (public URL) and DOJO_SECRET_KEY (openssl rand -base64 48)
docker compose -f deploy/compose/docker-compose.yml --env-file .env up -d
```

Services: `dojohub` (server), `dojohub-worker`, `postgres` (pgvector), plus optional `minio` (`--profile s3`).
Put a TLS-terminating reverse proxy in front (`proxy_buffering off` helps large git fetches; allow bodies up to 60 MB for uploads).

On first start, the server logs a one-time setup link (or uses `DOJO_SETUP_TOKEN`). Alternatively, set `DOJO_BOOTSTRAP_ADMIN_EMAIL`: that user becomes owner on their first (SSO) login.

## Helm

```bash
helm install dojohub oci://ghcr.io/axiomat/charts/dojohub \
  --set baseUrl=https://skills.acme.com \
  --set database.url=postgres://dojohub:***@postgres:5432/dojohub \
  --set storage.driver=s3 --set storage.s3.bucket=dojohub \
  --set ingress.enabled=true --set ingress.hosts[0].host=skills.acme.com
```

- Migrations run as a Helm hook Job; server pods set `DOJO_SKIP_MIGRATIONS`.
- Use `existingSecret` (keys `DOJO_SECRET_KEY`, `DATABASE_URL`, optional `S3_*`, `GITHUB_TOKEN`) with external secret managers.
- For more than one server replica, use `storage.driver=s3`, or a ReadWriteMany volume for `fs`. The git cache is a per-pod cache and is safe to lose.
- `postgresql.enabled=true` starts a single pgvector instance for evaluation only.
- `serviceMonitor.enabled=true` scrapes `/metrics`.

## Configuration

| Variable                                                                                                   | Default                 | Description                                                                                                                       |
| ---------------------------------------------------------------------------------------------------------- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `DOJO_BASE_URL`                                                                                            | `http://localhost:3000` | Public URL (install commands, SSO callbacks, git URLs)                                                                            |
| `DOJO_SECRET_KEY`                                                                                          | dev value               | Session signing and AES-GCM encryption of stored secrets (BYOK keys, source tokens, webhook secrets). **Required in production.** |
| `DATABASE_URL`                                                                                             | local                   | PostgreSQL connection string (pgvector extension required)                                                                        |
| `DOJO_AUTH_LOCAL`                                                                                          | `true`                  | Email/password login. Keep enabled until SSO works.                                                                               |
| `DOJO_ALLOW_SIGNUP`                                                                                        | `false`                 | Open self-registration                                                                                                            |
| `DOJO_BOOTSTRAP_ADMIN_EMAIL`                                                                               | –                       | Becomes owner on first login                                                                                                      |
| `DOJO_SETUP_TOKEN`                                                                                         | random                  | Token required by the first-run setup                                                                                             |
| `STORAGE_DRIVER`                                                                                           | `fs`                    | `fs` or `s3`                                                                                                                      |
| `STORAGE_PATH`                                                                                             | `./.data/blobs`         | Blob directory for `fs`                                                                                                           |
| `S3_BUCKET`, `S3_REGION`, `S3_ENDPOINT`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_FORCE_PATH_STYLE` | –                       | S3-compatible storage                                                                                                             |
| `DOJO_GIT_CACHE_DIR`                                                                                       | `./.data/git`           | Materialised git repositories (cache)                                                                                             |
| `GITHUB_TOKEN`                                                                                             | –                       | Default token for GitHub sources (rate limits, private repos)                                                                     |
| `DOJO_OSV`                                                                                                 | `false`                 | Query OSV.dev for vulnerable dependencies (outbound internet)                                                                     |
| `DOJO_EMBEDDED_WORKER`                                                                                     | `false`                 | Run jobs inside the server process                                                                                                |
| `DOJO_METRICS`                                                                                             | `true`                  | Expose `/metrics`                                                                                                                 |
| `LOG_LEVEL`                                                                                                | `info`                  | pino log level                                                                                                                    |

DojoHub itself sends no telemetry. The stock `skills` CLI does, unless `DISABLE_TELEMETRY=1` is set (see [compatibility](compatibility.md)).

## Air-gapped installations

Everything DojoHub serves is a local copy. Import sources by uploading repository archives (_Sources → Archive upload_), disable OSV, and point the LLM judge at an internal OpenAI-compatible endpoint (vLLM, Ollama) or leave it off.

## Backups

Back up PostgreSQL and the blob store (volume or bucket). The git cache can be rebuilt.

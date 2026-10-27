# 1. Full-TypeScript stack

Status: accepted

Context: The registry needs a web UI, an API, a CLI, an MCP server and shared parsing/packaging logic. Rust and Java were considered.

Decision: Node 24 + TypeScript everywhere: Hono (API), Drizzle (Postgres), Better Auth (identity), React 19 + TanStack (UI), citty (CLI), with a shared `@dojohub/core`.

Consequences: One language and shared schemas (zod) across server, web and CLI, plus a large contributor pool. Raw throughput is lower than Rust, which is irrelevant at registry scale. Native binaries for the CLI are produced by bundling.

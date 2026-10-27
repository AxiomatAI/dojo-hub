# 2. Distribution via well-known + git

Status: accepted

Context: Users must be able to install skills with the stock `npx skills` CLI. Its well-known HTTP provider never sends credentials; only its git transport authenticates (through git credential helpers).

Decision: Serve the agent-skills discovery index (RFC v0.2.0) for anonymously readable namespaces, and read-only git smart-HTTP for every namespace, authenticated with personal access tokens over HTTP Basic. Repositories are materialised lazily from the database with deterministic commits, so replicas need no shared state.

Consequences: Private teams work with the stock CLI after `dojo login` configures a credential helper. git must be present in the image.

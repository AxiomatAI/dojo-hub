# 4. Local, immutable copies of every skill

Status: accepted

Decision: DojoHub is the system of record. Imports copy every file (scripts, references, assets, sidecars) into a content-addressed blob store. Versions are immutable. Upstream changes create new candidate versions that go through scanning and the policy. Files referenced outside a skill directory are vendored into `references/_external/` and the links are rewritten (recorded as a transformation).

Consequences: Installs keep working when upstreams disappear or change. Air-gapped use is possible. Storage grows with versions, but deduplication by sha256 keeps it small.

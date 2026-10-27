# External decision model contract

Configure in **Admin → Verification → External decision model**. For every scanned version, after the built-in analyzers, DojoHub sends:

```http
POST <your-url>
content-type: application/json
x-dojo-signature: sha256=<hex HMAC-SHA256 of the raw body with your secret>

{
  "schemaVersion": 1,
  "skill": { "name": "pdf-tools", "description": "…", "frontmatter": { … } },
  "version": "1.3.0",
  "previousVersion": "1.2.0",
  "files": [{ "path": "SKILL.md", "size": 1234, "content": "…" }, { "path": "bin/tool", "size": 9000, "content": null }],
  "findings": [{ "analyzer": "static", "rule": "exec.curl_pipe_shell", "severity": "high", "message": "…", "file": "…", "line": 12 }]
}
```

Respond within the timeout (default 15 s):

```json
{ "decision": "allow" | "review" | "deny", "score": 0-100, "reasons": ["…"], "labels": ["…"] }
```

- `deny` rejects the version automatically.
- `review` forces human review, even when an auto-approval rule would apply.
- `allow` lets the policy decide.
- `score` (optional) raises the aggregated risk score.
- If the service is unreachable, _on error_ decides between human review (default) and ignoring it.

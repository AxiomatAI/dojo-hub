# Security scanning & LLM verification

DojoHub never executes skill content. Every submitted version is analyzed by:

| Analyzer           | What it checks                                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Structure**      | Agent Skills spec (name/directory, description length, YAML), file count and size limits, unusual or hidden files, invisible or bidirectional Unicode, references to files outside the skill                                                                                                                                                                                                   |
| **Static rules**   | Remote code execution (`curl \| sh`, `iex`), reverse shells, destructive commands, credential stores (`~/.ssh`, `~/.aws`), exfiltration endpoints, obfuscation, persistence (cron, shell rc, agent config), prompt injection ("ignore previous instructions", "don't tell the user", hidden HTML comments, bypassing permissions). Extensible with a YAML rule pack in _Admin → Verification_. |
| **Secrets**        | Cloud and provider keys, tokens, private keys, JWTs, connection strings, high-entropy assignments (redacted in reports)                                                                                                                                                                                                                                                                        |
| **Assets**         | Per-file risk flags: `script`, `executable`, `binary`, `archive`, `network`, `fs-write`, `env-access`, `large`, `obfuscated`, `hidden-unicode`                                                                                                                                                                                                                                                 |
| **Dependencies**   | `package.json` lifecycle scripts, declared packages, optional OSV.dev vulnerability lookup                                                                                                                                                                                                                                                                                                     |
| **Duplicates**     | Exact content hash, near-duplicates (MinHash over 5-word shingles), optional semantic duplicates (embeddings + pgvector)                                                                                                                                                                                                                                                                       |
| **LLM judge**      | BYOK model returns structured output: security verdict and risks, "does it do what it claims" score with mismatches, instruction quality, category and tags, and for updates a review of the diff. Content is delimited and treated as untrusted. Consensus runs (1–3) take the most severe verdict.                                                                                           |
| **Decision model** | Optional external classifier (see [decision-model.md](decision-model.md))                                                                                                                                                                                                                                                                                                                      |

## Custom rules

```yaml
- id: custom.internal_hosts
  category: network
  severity: medium
  message: Calls an internal-only host
  pattern: "corp-internal\\.example\\.com"
  files: "\\.(sh|py)$" # optional path regex
```

## Risk score

Findings add weight by severity: critical 40, high 20, medium 8, low 2. Repeats of the same rule add diminishing weight. A malicious LLM verdict adds 60 and a suspicious one 20; a decision-model `deny` adds 50. Levels: none 0, low < 15, medium < 40, high < 70, critical ≥ 70. Any critical finding makes the level critical.

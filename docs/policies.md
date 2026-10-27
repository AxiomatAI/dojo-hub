# Approval policies

Each namespace has a policy (or inherits the organization default). Edit it visually in **Team → Approval policy** or as JSON.

```jsonc
{
  "gates": {
    "maxRisk": "high", // reject automatically above this risk level
    "requireLlmVerification": false, // force human review if the LLM judge didn't run
    "blockOn": ["secret"], // finding rules/categories that reject immediately
    "minClaimsScore": 0, // minimum "does what it claims" score (0-100)
    "rejectExactDuplicates": false
  },
  "stages": [
    {
      "name": "Security review",
      "when": "risk >= \"medium\" or has_asset(\"script\")",
      "approvers": { "roles": ["security_reviewer"] },
      "min": 1
    },
    {
      "name": "Team approval",
      "approvers": { "roles": ["maintainer"], "groups": ["platform-leads"] },
      "min": 1
    }
  ],
  "updates": {
    "mode": "auto_if_low_risk",
    "maxRisk": "low",
    "llmDiffReview": true,
    "majorRequiresManual": true
  },
  "imports": { "mode": "manual", "trustedSources": ["https://github.com/anthropics/skills"] },
  "maintainersBypass": false
}
```

## Conditions

`when` uses a small, safe expression language (no `eval`):

| Name                    | Meaning                                                                                     |
| ----------------------- | ------------------------------------------------------------------------------------------- |
| `risk`                  | risk level, compared with `"none" "low" "medium" "high" "critical"`                         |
| `score`                 | risk score 0–100                                                                            |
| `claims_score`          | LLM claim-match score (100 when the LLM did not run)                                        |
| `kind`                  | `"new"`, `"update"`, `"import"`                                                             |
| `major`                 | `true` for a major version bump                                                             |
| `files`                 | number of files                                                                             |
| `namespace`, `source`   | target namespace slug, source URL                                                           |
| `has_asset("script")`   | any file flagged `script`, `executable`, `binary`, `network`, `env-access`, `obfuscated`, … |
| `has_finding("secret")` | any finding whose rule starts with the prefix                                               |

Operators: `and`, `or`, `not`, `==`, `!=`, `<`, `>=`, … Invalid expressions are rejected on save, and fail closed (the stage applies) at runtime.

## Approvers

A stage is satisfied when `min` distinct approvers matching **any** of its users, IdP groups (id or name) or roles approve. Team roles cascade: owners satisfy maintainer, and maintainers satisfy reviewer. Org owners and admins can always decide. Submitters cannot approve their own versions (except org admins). Rejecting or requesting changes requires a comment.

# `dojo` CLI

```bash
npm i -g @axiomat/dojo   # or: npx @axiomat/dojo <command>
```

| Command                                                              | Description                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `dojo login [url] [--token T] [--git-helper]`                        | Device-flow login (opens the browser). The token is stored in the OS keychain, or in a 0600 file as a fallback. |
| `dojo logout`, `dojo whoami`                                         |                                                                                                                 |
| `dojo context ls` / `dojo context use <host>`                        | Multiple registries, like `docker context`                                                                      |
| `dojo search [query] [--team t]`                                     | Search approved skills                                                                                          |
| `dojo info <skill>`                                                  | Versions and status                                                                                             |
| `dojo add @team/skill[@version] … [-a claude-code,cursor] [-g]`      | Install into `.agents/skills/<name>` and symlink into agent directories. Updates `skills-lock.json`.            |
| `dojo add --suite @team/suite`                                       | Install every skill of a suite                                                                                  |
| `dojo sync --team <team> [--level required,recommended]`             | Install a team's catalog                                                                                        |
| `dojo list`, `dojo update`, `dojo remove`                            | Manage installed skills                                                                                         |
| `dojo audit`                                                         | Exit code 2 if an installed version is blocked or deprecated                                                    |
| `dojo init [name]`                                                   | Scaffold a skill                                                                                                |
| `dojo submit [dir] -n <team> [--version v] [-m changelog] [--draft]` | Validate, pack and submit for review                                                                            |
| `dojo status <skill>@<version>`                                      | Scan results and review progress                                                                                |
| `dojo import <repo-url> -n <team>`                                   | Add an upstream source                                                                                          |
| `dojo setup-skills`                                                  | Configure git auth and env for `npx skills`                                                                     |

Environment: `DOJO_REGISTRY` (override the context), `DOJO_TOKEN` (CI), `DOJO_CONFIG_DIR`, `DOJO_NO_KEYCHAIN=1`.
Supported agents: claude-code, cursor, codex, github-copilot, gemini-cli, opencode, windsurf, cline, roo, goose, amp, kiro, junie, qwen-code, continue.

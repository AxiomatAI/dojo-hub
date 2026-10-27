# Compatibility with `npx skills` (vercel-labs/skills)

DojoHub is tested against `skills@1.7.4` in CI (`scripts/e2e-compat.sh`).

| Use case                            | Command                                                        |
| ----------------------------------- | -------------------------------------------------------------- |
| Team catalog (public/internal team) | `npx skills add https://dojo.acme.com/t/<team>`                |
| Single skill                        | `npx skills add https://dojo.acme.com/s/<ns>/<skill>`          |
| Suite                               | `npx skills add https://dojo.acme.com/suites/<ns>/<suite>`     |
| Private team (git + token)          | `npx skills add https://dojo.acme.com/git/t/<team>.git`        |
| Private skill                       | `npx skills add https://dojo.acme.com/git/s/<ns>/<skill>.git`  |
| Search                              | `SKILLS_API_URL=https://dojo.acme.com npx skills find <query>` |
| Updates                             | `npx skills check` / `npx skills update`                       |

## Why two transports?

The well-known HTTP protocol used by `npx skills` sends **no credentials**. DojoHub therefore serves well-known indexes only for _public_ namespaces, and for _internal_ namespaces when **Admin → General → Serve internal skills without a token** is on (the default for network-gated installs). Private namespaces are only available over **git smart-HTTP**, where git credential helpers authenticate with a DojoHub token:

```bash
dojo login https://dojo.acme.com   # configures `git config --global credential.<url>.helper "!dojo credential"`
```

or manually (e.g. in CI):

```bash
git config --global credential.https://dojo.acme.com.helper '!f() { echo username=dojo; echo password=$DOJO_TOKEN; }; f'
```

## Telemetry

The `skills` CLI reports installs (including well-known hostnames and URLs) to skills.sh. Set `DISABLE_TELEMETRY=1` (or `DO_NOT_TRACK=1`) on developer machines and CI so that private registry URLs aren't reported.

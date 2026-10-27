#!/usr/bin/env bash
# End-to-end compatibility test: boots DojoHub with docker compose, publishes a skill through the
# full pipeline and installs it with the stock `skills` CLI (well-known and authenticated git).
set -euo pipefail
cd "$(dirname "$0")/.."

export DOJO_IMAGE="${DOJO_IMAGE:-dojohub:local}"
export DOJO_PORT="${DOJO_PORT:-3100}"
export DOJO_BASE_URL="http://localhost:${DOJO_PORT}"
export DOJO_SECRET_KEY="$(openssl rand -base64 48)"
export DOJO_SETUP_TOKEN="$(openssl rand -hex 16)"
SKILLS_CLI="skills@${SKILLS_CLI_VERSION:-1.7.4}"
PROJECT=dojohub-e2e
COMPOSE=(docker compose -p "$PROJECT" -f deploy/compose/docker-compose.yml)
WORK="$(mktemp -d)"
trap '"${COMPOSE[@]}" logs --tail 80 dojohub || true; "${COMPOSE[@]}" down -v >/dev/null 2>&1 || true; rm -rf "$WORK"' EXIT

"${COMPOSE[@]}" up -d --no-build
for _ in $(seq 1 60); do curl -sf "$DOJO_BASE_URL/readyz" >/dev/null && break; sleep 2; done

PW="$(openssl rand -hex 12)"
curl -sf -X POST "$DOJO_BASE_URL/api/v1/setup" -H 'content-type: application/json' \
  -d "{\"token\":\"$DOJO_SETUP_TOKEN\",\"orgName\":\"E2E\",\"admin\":{\"name\":\"E2E Admin\",\"email\":\"e2e@example.test\",\"password\":\"$PW\"}}" >/dev/null
curl -sf -c "$WORK/cookies" -X POST "$DOJO_BASE_URL/api/auth/sign-in/email" -H 'content-type: application/json' \
  -H "origin: $DOJO_BASE_URL" -d "{\"email\":\"e2e@example.test\",\"password\":\"$PW\"}" >/dev/null
api() { curl -sf -b "$WORK/cookies" -H 'content-type: application/json' -H "origin: $DOJO_BASE_URL" "$@"; }

api -X POST "$DOJO_BASE_URL/api/v1/namespaces" -d '{"slug":"qa","displayName":"QA","visibility":"private"}' >/dev/null
api -X POST "$DOJO_BASE_URL/api/v1/skills" -d '{"namespace":"qa","files":{"SKILL.md":"---\nname: e2e-skill\ndescription: Exercise the DojoHub pipeline end to end in continuous integration.\n---\n# E2E\nSay hello.","references/notes.md":"# Notes"}}' >/dev/null

for _ in $(seq 1 30); do
  STATUS="$(api "$DOJO_BASE_URL/api/v1/skills/e2e-skill" | node -pe 'JSON.parse(require("fs").readFileSync(0)).status')"
  [ "$STATUS" = "in_review" ] && break; sleep 2
done
REVIEW="$(api "$DOJO_BASE_URL/api/v1/reviews?status=pending" | node -pe 'JSON.parse(require("fs").readFileSync(0))[0].id')"
for _ in 1 2 3; do api -X POST "$DOJO_BASE_URL/api/v1/reviews/$REVIEW/decision" -d '{"decision":"approve"}' >/dev/null || true; done
api -X POST "$DOJO_BASE_URL/api/v1/namespaces/qa/catalog" -d "{\"skillId\":\"$(api "$DOJO_BASE_URL/api/v1/skills/e2e-skill" | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')\"}" >/dev/null
TOKEN="$(api -X POST "$DOJO_BASE_URL/api/v1/tokens" -d '{"name":"e2e","scopes":["read","install"]}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).token')"
export DISABLE_TELEMETRY=1

echo "→ private team is not served anonymously"
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$DOJO_BASE_URL/t/qa/.well-known/agent-skills/index.json")"
[ "$CODE" = "404" ] || { echo "expected 404, got $CODE"; exit 1; }

echo "→ npx skills add (authenticated git)"
mkdir -p "$WORK/p1" && cd "$WORK/p1"
GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0="credential.$DOJO_BASE_URL.helper" GIT_CONFIG_VALUE_0="!f() { echo username=dojo; echo password=$TOKEN; }; f" \
  npx -y "$SKILLS_CLI" add "$DOJO_BASE_URL/git/t/qa.git" -y -a claude-code
test -f .claude/skills/e2e-skill/SKILL.md
test -f .claude/skills/e2e-skill/references/notes.md

echo "→ npx skills add (well-known, internal team)"
cd "$OLDPWD"
api -X PATCH "$DOJO_BASE_URL/api/v1/namespaces/qa" -d '{"visibility":"internal"}' >/dev/null
mkdir -p "$WORK/p2" && cd "$WORK/p2"
npx -y "$SKILLS_CLI" add "$DOJO_BASE_URL/t/qa" -y -a claude-code
test -f .claude/skills/e2e-skill/SKILL.md
grep -q '"sourceType": "well-known"' skills-lock.json
echo "✓ compatibility tests passed"

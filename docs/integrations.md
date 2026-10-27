# REST API, MCP & webhooks

## REST API

- OpenAPI 3.1: `/api/openapi.json`; interactive docs at `/api/docs`.
- Authentication: `Authorization: Bearer dojo_pat_…` (personal or service tokens with scopes `read`, `install`, `submit`, `review`, `admin`), or a browser session.
- Errors: `{ "error": { "code", "message", "details" } }`.

## MCP server

Streamable HTTP endpoint at `/mcp` (stateless; authenticate with a token):

```bash
claude mcp add --transport http dojohub https://dojo.acme.com/mcp --header "Authorization: Bearer $DOJO_TOKEN"
```

Tools: `search_skills`, `get_skill`, `get_skill_file`, `list_team_catalog`, `get_install_instructions`, `submit_skill_draft`, `get_submission_status`, `list_pending_reviews`. Resource: `skill://{name}/SKILL.md`. Every call runs through the REST API with the caller's permissions.

## Webhooks

Events: `skill.submitted`, `version.scanned`, `review.requested`, `review.decided`, `version.published`, `version.rejected`, `version.deprecated`, `version.blocked`, `source.synced`, `source.update_available`, `install.recorded`.

```http
POST <url>
x-dojo-event: version.blocked
x-dojo-event-id: 7c9e…            # idempotency key
x-dojo-timestamp: 1730000000
x-dojo-signature: sha256=<hex HMAC-SHA256(secret, "<timestamp>.<raw body>")>

{ "id": "7c9e…", "type": "version.blocked", "createdAt": "…", "org": "…", "data": { "skill": "pdf", "version": "1.2.0", "reason": "…" } }
```

Formats: raw JSON, Slack incoming webhooks, or Microsoft Teams (Adaptive Card). Failed deliveries retry with exponential backoff (8 attempts). Admins can inspect deliveries and redeliver them.

Verify a signature (Node):

```js
const expected = crypto
  .createHmac('sha256', secret)
  .update(`${req.headers['x-dojo-timestamp']}.${rawBody}`)
  .digest('hex');
const ok = crypto.timingSafeEqual(
  Buffer.from(`sha256=${expected}`),
  Buffer.from(req.headers['x-dojo-signature']),
);
```

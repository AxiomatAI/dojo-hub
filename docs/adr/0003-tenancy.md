# 3. Tenant-ready schema, single-tenant UX

Status: accepted

Decision: Every tenant-owned table has `org_id`, and all queries filter by it. Self-hosted installs create one organization. Multi-tenant hosting will add org resolution by domain, per-org SSO routing and an org switcher, without schema rewrites.

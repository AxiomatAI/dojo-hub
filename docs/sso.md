# Single sign-on, groups and SCIM

Add providers in **Admin → Single sign-on** (or during onboarding). Each provider has an **email domain**: users signing in with that domain are routed to it. The redirect/callback URL is shown in the form.

## Microsoft Entra ID (OIDC)

1. Entra admin center → _App registrations_ → _New registration_. Add a **Web** redirect URI: `https://<dojohub>/api/auth/sso/callback/<provider-id>`.
2. _Certificates & secrets_ → new client secret.
3. _Token configuration_ → _Add groups claim_ (Security groups, emit as Group ID). Optionally add app roles: DojoHub treats `roles` like groups.
4. In DojoHub, choose **Entra ID**, issuer `https://login.microsoftonline.com/<tenant-id>/v2.0`, plus the client ID and secret, groups claim `groups`.
5. Users in more than 200 groups exceed the token limit (groups overage). Configure **Directory sync → Microsoft Graph** (application permission `GroupMember.Read.All`) to sync memberships instead.

## Google Workspace (OIDC)

1. Google Cloud Console → _APIs & Services_ → _Credentials_ → OAuth client (Web). Redirect URI as above.
2. In DojoHub, choose **Google** and enter the client ID and secret. Google doesn't put groups in tokens: configure **Directory sync → Google Workspace** with a service account that has domain-wide delegation for `admin.directory.group.readonly` and `admin.directory.group.member.readonly`, plus an admin email to impersonate.

## Okta (OIDC or SAML)

OIDC: create an _OIDC Web Application_, add the redirect URI, and add a **groups** claim to the ID token (filter e.g. `Matches regex .*`). Issuer: `https://<org>.okta.com` (or your authorization server). For SAML, see below.

## AWS IAM Identity Center

Use the generic **SAML** preset (IAM Identity Center → _Applications_ → _Custom SAML 2.0_), and enable automatic provisioning with **SCIM** (below) for groups.

## Generic OIDC / Keycloak / Auth0

Any provider with a discovery document (`/.well-known/openid-configuration`) works. **Test connection** validates discovery before saving. Set the groups claim path (dot notation is supported, e.g. `realm_access.roles`).

## SAML 2.0

Provide the IdP entity ID, SSO URL and signing certificate (PEM). Configure the IdP with ACS URL `https://<dojohub>/api/auth/sso/saml2/callback/<provider-id>`, NameID = email, and an attribute named after your groups claim.

## Groups → roles

**Admin → Groups & provisioning → Group mappings** maps an IdP group to:

- an **organization role**: owner, admin, security reviewer, auditor, member; or
- a **team role**: owner, maintainer, reviewer or member of a namespace.

Mappings are applied at every SSO login, on every SCIM change and after directory syncs. Managed memberships are removed when the group is removed. Manual memberships are kept.

## SCIM 2.0

Create a token in **Admin → Groups & provisioning → SCIM** and configure your IdP:

- Endpoint: `https://<dojohub>/scim/v2`
- Authentication: Bearer token

Supported: Users (create, update, PATCH `active`, delete = deactivate) and Groups (create, PATCH add/remove members, rename, delete), with `filter=userName eq "…"` / `displayName eq "…"`. Deactivating a user revokes their sessions immediately.

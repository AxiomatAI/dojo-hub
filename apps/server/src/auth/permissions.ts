import type { NamespaceRole, OrgRole, PatScope, Visibility } from '@dojohub/contract';

export interface Actor {
  userId: string;
  orgId: string;
  email: string;
  name: string;
  orgRole: OrgRole;
  /** namespaceId → role */
  ns: Map<string, NamespaceRole>;
  via: 'session' | 'token';
  /** null = interactive session (all scopes). */
  scopes: PatScope[] | null;
  tokenId?: string;
}

export type Capability = 'read' | 'submit' | 'review' | 'manage' | 'admin';

const SCOPE_GRANTS: Record<PatScope, Capability[]> = {
  read: ['read'],
  install: ['read'],
  submit: ['read', 'submit'],
  review: ['read', 'review'],
  admin: ['read', 'submit', 'review', 'manage', 'admin'],
};

/** Whether the actor's credential (token scopes) allows a capability at all. */
export function scopeAllows(actor: Actor, cap: Capability): boolean {
  if (!actor.scopes) return true;
  return actor.scopes.some((s) => SCOPE_GRANTS[s].includes(cap));
}

export const isOrgAdmin = (a: Actor) =>
  (a.orgRole === 'owner' || a.orgRole === 'admin') && scopeAllows(a, 'admin');
export const isSecurityReviewer = (a: Actor) => a.orgRole === 'security_reviewer' || isOrgAdmin(a);
export const canReadAudit = (a: Actor) =>
  ['owner', 'admin', 'auditor'].includes(a.orgRole) && scopeAllows(a, 'read');
/** Org-wide read access to every namespace (admins, security reviewers, auditors). */
export const hasGlobalRead = (a: Actor) =>
  ['owner', 'admin', 'security_reviewer', 'auditor'].includes(a.orgRole);

export interface NamespaceRef {
  id: string;
  kind: string;
  visibility: Visibility;
}

export function canReadNamespace(a: Actor | null, ns: NamespaceRef): boolean {
  if (ns.visibility === 'public') return true;
  if (!a || !scopeAllows(a, 'read')) return false;
  if (ns.visibility === 'internal') return true;
  return a.ns.has(ns.id) || hasGlobalRead(a);
}

export function canSubmitTo(a: Actor, ns: NamespaceRef): boolean {
  if (!scopeAllows(a, 'submit')) return false;
  if (isOrgAdmin(a)) return true;
  // Anyone in the organisation can propose skills for the org-wide namespace; they go through review.
  if (ns.kind === 'org') return true;
  return a.ns.has(ns.id);
}

export function canManageNamespace(a: Actor, ns: NamespaceRef): boolean {
  if (!scopeAllows(a, 'manage') && !scopeAllows(a, 'admin')) {
    if (a.scopes) return false;
  }
  if (isOrgAdmin(a)) return true;
  const role = a.ns.get(ns.id);
  return role === 'owner' || role === 'maintainer';
}

export function canAdminNamespace(a: Actor, ns: NamespaceRef): boolean {
  if (isOrgAdmin(a)) return true;
  return a.ns.get(ns.id) === 'owner' && !a.scopes;
}

/** Roles in an approval stage match either org roles or roles in the subject namespace. */
export function actorHasRole(a: Actor, role: string, namespaceId: string): boolean {
  if (a.orgRole === role) return true;
  const nsRole = a.ns.get(namespaceId);
  if (!nsRole) return false;
  if (nsRole === role) return true;
  // Owners/maintainers implicitly satisfy lower namespace review roles.
  if (role === 'reviewer') return nsRole === 'owner' || nsRole === 'maintainer';
  if (role === 'maintainer') return nsRole === 'owner';
  return false;
}

export function permissionList(a: Actor): string[] {
  const out: string[] = [];
  if (isOrgAdmin(a)) out.push('org.admin');
  if (isSecurityReviewer(a)) out.push('security.review');
  if (canReadAudit(a)) out.push('audit.read');
  if (hasGlobalRead(a)) out.push('org.read_all');
  if (scopeAllows(a, 'submit')) out.push('skill.submit');
  return out;
}

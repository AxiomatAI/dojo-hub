import { describe, expect, it } from 'vitest';
import {
  type Actor,
  actorHasRole,
  canManageNamespace,
  canReadNamespace,
  canSubmitTo,
  isOrgAdmin,
} from '../src/auth/permissions';
import { SecretBox, userCode } from '../src/lib/crypto';
import { canDecideStage } from '../src/services/approvals';
import { resolveGitSource } from '../src/services/fetchers';
import { decodeJwtPayload, extractGroupClaims } from '../src/services/groups';
import { evaluateCondition, type PolicyFacts, validateCondition } from '../src/services/policy';
import { renderPayload, signPayload } from '../src/services/webhooks';

const facts = (p: Partial<PolicyFacts> = {}): PolicyFacts => ({
  risk: 'low',
  riskScore: 5,
  claimsScore: 90,
  kind: 'new',
  major: false,
  assets: [],
  findings: [],
  files: 2,
  namespace: 'platform',
  source: null,
  ...p,
});

describe('policy conditions', () => {
  it('compares risk levels by rank', () => {
    expect(evaluateCondition('risk >= "medium"', facts({ risk: 'low' }))).toBe(false);
    expect(evaluateCondition('risk >= "medium"', facts({ risk: 'high' }))).toBe(true);
  });
  it('supports asset and finding helpers', () => {
    expect(evaluateCondition('has_asset("script")', facts({ assets: ['script'] }))).toBe(true);
    expect(evaluateCondition('has_finding("secret")', facts({ findings: ['secret.github_token'] }))).toBe(
      true,
    );
    expect(evaluateCondition('kind == "update" and not major', facts({ kind: 'update' }))).toBe(true);
  });
  it('fails closed on invalid expressions and validates syntax', () => {
    expect(evaluateCondition('risk >>> nonsense', facts())).toBe(true);
    expect(validateCondition('risk >= "medium" or has_asset("script")')).toBeNull();
    expect(validateCondition('risk >=')).not.toBeNull();
  });
});

const actor = (p: Partial<Actor> = {}): Actor => ({
  userId: 'u1',
  orgId: 'o1',
  email: 'a@b.c',
  name: 'A',
  orgRole: 'member',
  ns: new Map(),
  via: 'session',
  scopes: null,
  ...p,
});
const team = { id: 'ns1', kind: 'team', visibility: 'private' as const };
const orgNs = { id: 'org', kind: 'org', visibility: 'internal' as const };

describe('permissions', () => {
  it('scopes private namespaces to members and global readers', () => {
    expect(canReadNamespace(actor(), team)).toBe(false);
    expect(canReadNamespace(actor({ ns: new Map([['ns1', 'member']]) }), team)).toBe(true);
    expect(canReadNamespace(actor({ orgRole: 'auditor' }), team)).toBe(true);
    expect(canReadNamespace(null, { ...team, visibility: 'public' })).toBe(true);
    expect(canReadNamespace(null, orgNs)).toBe(false);
  });
  it('lets anyone propose to the org namespace but only members to teams', () => {
    expect(canSubmitTo(actor(), orgNs)).toBe(true);
    expect(canSubmitTo(actor(), team)).toBe(false);
    expect(canSubmitTo(actor({ scopes: ['read'] }), orgNs)).toBe(false);
  });
  it('limits management to maintainers/owners and admins', () => {
    expect(canManageNamespace(actor({ ns: new Map([['ns1', 'member']]) }), team)).toBe(false);
    expect(canManageNamespace(actor({ ns: new Map([['ns1', 'maintainer']]) }), team)).toBe(true);
    expect(isOrgAdmin(actor({ orgRole: 'admin', scopes: ['read'] }))).toBe(false);
  });
  it('maps stage roles onto namespace roles', () => {
    const a = actor({ ns: new Map([['ns1', 'maintainer']]) });
    expect(actorHasRole(a, 'reviewer', 'ns1')).toBe(true);
    expect(actorHasRole(a, 'owner', 'ns1')).toBe(false);
  });
  it('enforces separation of duties on approvals', () => {
    const stage = { approvers: { roles: ['maintainer'] }, status: 'active' };
    const maintainer = actor({ ns: new Map([['ns1', 'maintainer']]) });
    expect(canDecideStage(maintainer, stage, 'ns1', [], 'someone-else')).toBe(true);
    expect(canDecideStage(maintainer, stage, 'ns1', [], 'u1')).toBe(false);
    expect(
      canDecideStage(
        actor(),
        { approvers: { groups: ['sec-team'] }, status: 'active' },
        'ns1',
        ['sec-team'],
        null,
      ),
    ).toBe(true);
    expect(canDecideStage(maintainer, { ...stage, status: 'waiting' }, 'ns1', [], null)).toBe(false);
  });
});

describe('identity helpers', () => {
  it('extracts groups and Entra roles from claims', () => {
    expect(extractGroupClaims({ groups: ['a', 'b'], roles: ['Admin'] }, 'groups').sort()).toEqual([
      'Admin',
      'a',
      'b',
    ]);
    expect(extractGroupClaims({ realm_access: { roles: ['x'] } }, 'realm_access.roles')).toEqual(['x']);
    expect(extractGroupClaims({ groups: 'one two' }, 'groups')).toEqual(['one', 'two']);
  });
  it('decodes JWT payloads defensively', () => {
    const jwt = `x.${Buffer.from(JSON.stringify({ groups: ['g'] })).toString('base64url')}.y`;
    expect(decodeJwtPayload(jwt)).toEqual({ groups: ['g'] });
    expect(decodeJwtPayload('garbage')).toEqual({});
  });
});

describe('crypto', () => {
  it('round-trips secrets and rejects tampering', () => {
    const box = new SecretBox('a'.repeat(40));
    const enc = box.encrypt('sk-ant-secret');
    expect(enc).not.toContain('secret');
    expect(box.decrypt(enc)).toBe('sk-ant-secret');
    expect(new SecretBox('b'.repeat(40)).decryptOrNull(enc)).toBeNull();
    expect(userCode()).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  });
});

describe('webhooks', () => {
  it('signs timestamped payloads and renders chat formats', () => {
    expect(signPayload('s', '1', '{}')).toMatch(/^[0-9a-f]{64}$/);
    const e = {
      id: '1',
      type: 'version.blocked' as const,
      createdAt: '',
      org: 'o',
      data: { skill: 'pdf', version: '1.0.0', reason: 'malware' },
    };
    expect(JSON.stringify(renderPayload('slack', e, 'https://x'))).toContain('BLOCKED');
    expect(JSON.stringify(renderPayload('teams', e, 'https://x'))).toContain('AdaptiveCard');
  });
});

describe('source URLs', () => {
  it('parses GitHub, GitLab and shorthand sources', () => {
    expect(resolveGitSource('github', 'mattpocock/skills')).toMatchObject({
      cloneUrl: 'https://github.com/mattpocock/skills.git',
      subPath: '',
    });
    expect(resolveGitSource('github', 'https://github.com/cursor/plugins/tree/main/pstack')).toMatchObject({
      ref: 'main',
      subPath: 'pstack',
    });
    expect(resolveGitSource('gitlab', 'https://gitlab.com/a/b/c/-/tree/dev/skills')).toMatchObject({
      cloneUrl: 'https://gitlab.com/a/b/c.git',
      ref: 'dev',
      subPath: 'skills',
    });
    expect(resolveGitSource('skills_sh', 'https://skills.sh/vercel-labs/agent-skills')).toMatchObject({
      cloneUrl: 'https://github.com/vercel-labs/agent-skills.git',
    });
  });
});

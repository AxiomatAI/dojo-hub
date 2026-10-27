import type { InstallCommands } from '@dojohub/contract';
import { catalogEntry, namespace, skill, skillVersion, suite } from '@dojohub/db';
import { and, eq, isNull } from 'drizzle-orm';
import { type Actor, canReadNamespace } from '../auth/permissions';
import type { AppContext } from '../context';
import { getSetting } from '../services/org';
import { installableVersion, type SkillRow, type VersionRow } from '../services/skills';
import { installableSuiteVersion, suiteMembers } from '../services/suites';

export type NamespaceRow = typeof namespace.$inferSelect;

/**
 * Whether a namespace can be served without credentials. Public always; internal only when the
 * admin declares the deployment network-gated (default true for self-hosted installs).
 */
export async function anonymousAllowed(ctx: AppContext, ns: NamespaceRow): Promise<boolean> {
  if (ns.visibility === 'public') return true;
  if (ns.visibility === 'private') return false;
  return getSetting<boolean>(ctx, ns.orgId, 'distribution.anonymousInternal', true);
}

export async function canDownload(ctx: AppContext, actor: Actor | null, ns: NamespaceRow): Promise<boolean> {
  if (actor) return canReadNamespace(actor, ns);
  return anonymousAllowed(ctx, ns);
}

export interface Bundle {
  skill: SkillRow;
  version: VersionRow;
  namespace: NamespaceRow;
}

/** Installable skill versions in a team's catalog (pinned or latest approved, suites expanded). */
export async function teamBundle(ctx: AppContext, ns: NamespaceRow): Promise<Bundle[]> {
  const entries = await ctx.db.select().from(catalogEntry).where(eq(catalogEntry.namespaceId, ns.id));
  const out = new Map<string, Bundle>();
  for (const e of entries) {
    if (e.skillId) {
      const [s] = await ctx.db
        .select()
        .from(skill)
        .where(and(eq(skill.id, e.skillId), isNull(skill.archivedAt)));
      if (!s) continue;
      const v = await installableVersion(ctx, s.id, e.pinnedVersion);
      const [home] = await ctx.db.select().from(namespace).where(eq(namespace.id, s.namespaceId));
      if (v && home) out.set(s.id, { skill: s, version: v, namespace: home });
    } else if (e.suiteId) {
      for (const b of await suiteBundle(ctx, e.suiteId, e.pinnedVersion)) out.set(b.skill.id, b);
    }
  }
  return [...out.values()].sort((a, b) => a.skill.name.localeCompare(b.skill.name));
}

export async function suiteBundle(
  ctx: AppContext,
  suiteId: string,
  selector?: string | null,
): Promise<Bundle[]> {
  const sv = await installableSuiteVersion(ctx, suiteId, selector);
  if (!sv) return [];
  const out: Bundle[] = [];
  for (const m of await suiteMembers(ctx, sv.id)) {
    const [v] = await ctx.db.select().from(skillVersion).where(eq(skillVersion.id, m.skillVersionId));
    if (!v || !['approved', 'deprecated'].includes(v.status)) continue;
    const [s] = await ctx.db.select().from(skill).where(eq(skill.id, v.skillId));
    const [home] = s ? await ctx.db.select().from(namespace).where(eq(namespace.id, s.namespaceId)) : [];
    if (s && home) out.push({ skill: s, version: v, namespace: home });
  }
  return out;
}

export async function findSkill(ctx: AppContext, orgId: string, nsSlug: string, name: string) {
  const [row] = await ctx.db
    .select({ skill, namespace })
    .from(skill)
    .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
    .where(
      and(eq(skill.orgId, orgId), eq(namespace.slug, nsSlug), eq(skill.name, name), isNull(skill.archivedAt)),
    );
  return row ?? null;
}

export async function findSuite(ctx: AppContext, orgId: string, nsSlug: string, name: string) {
  const [row] = await ctx.db
    .select({ suite, namespace })
    .from(suite)
    .innerJoin(namespace, eq(namespace.id, suite.namespaceId))
    .where(
      and(eq(suite.orgId, orgId), eq(namespace.slug, nsSlug), eq(suite.name, name), isNull(suite.archivedAt)),
    );
  return row ?? null;
}

export function installCommands(
  baseUrl: string,
  target: { kind: 'skill' | 'suite' | 'team'; ns: string; name?: string },
  wellKnown: boolean,
): InstallCommands {
  const path =
    target.kind === 'skill'
      ? `s/${target.ns}/${target.name}`
      : target.kind === 'suite'
        ? `suites/${target.ns}/${target.name}`
        : `t/${target.ns}`;
  const gitUrl = `${baseUrl}/git/${path}.git`;
  const wellKnownUrl = wellKnown ? `${baseUrl}/${path}` : null;
  const dojoRef =
    target.kind === 'team'
      ? `--team ${target.ns}`
      : target.kind === 'suite'
        ? `@${target.ns}/${target.name} --suite`
        : `@${target.ns}/${target.name}`;
  return {
    npxWellKnown: wellKnownUrl ? `npx skills add ${wellKnownUrl}` : null,
    npxGit: `npx skills add ${gitUrl}`,
    dojo: target.kind === 'team' ? `dojo sync ${dojoRef}` : `dojo add ${dojoRef}`,
    gitUrl,
    wellKnownUrl,
  };
}

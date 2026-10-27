import type { SkillSummaryDto, UserSummary, VersionDto } from '@dojohub/contract';
import { catalogEntry, namespace, type skill, skillVersion, source, user } from '@dojohub/db';
import { eq, inArray } from 'drizzle-orm';
import type { AppContext } from '../context';

export async function usersById(
  ctx: AppContext,
  ids: (string | null | undefined)[],
): Promise<Map<string, UserSummary>> {
  const unique = [...new Set(ids.filter((i): i is string => !!i))];
  if (!unique.length) return new Map();
  const rows = await ctx.db
    .select({ id: user.id, name: user.name, email: user.email, image: user.image })
    .from(user)
    .where(inArray(user.id, unique));
  return new Map(rows.map((r) => [r.id, r]));
}

type SkillJoin = { skill: typeof skill.$inferSelect; namespace: typeof namespace.$inferSelect };

export async function toSkillSummaries(ctx: AppContext, rows: SkillJoin[]): Promise<SkillSummaryDto[]> {
  if (!rows.length) return [];
  const versionIds = rows
    .flatMap((r) => [r.skill.latestVersionId, r.skill.publishedVersionId])
    .filter((x): x is string => !!x);
  const versions = versionIds.length
    ? await ctx.db
        .select({ id: skillVersion.id, version: skillVersion.version })
        .from(skillVersion)
        .where(inArray(skillVersion.id, versionIds))
    : [];
  const vmap = new Map(versions.map((v) => [v.id, v.version]));
  const sourceIds = rows.map((r) => r.skill.sourceId).filter((x): x is string => !!x);
  const sources = sourceIds.length
    ? await ctx.db
        .select({ id: source.id, name: source.name })
        .from(source)
        .where(inArray(source.id, sourceIds))
    : [];
  const smap = new Map(sources.map((s) => [s.id, s.name]));
  const teams = await ctx.db
    .select({ skillId: catalogEntry.skillId, slug: namespace.slug, level: catalogEntry.level })
    .from(catalogEntry)
    .innerJoin(namespace, eq(namespace.id, catalogEntry.namespaceId))
    .where(
      inArray(
        catalogEntry.skillId,
        rows.map((r) => r.skill.id),
      ),
    );
  return rows.map(({ skill: s, namespace: ns }) => ({
    id: s.id,
    name: s.name,
    displayName: s.displayName,
    summary: s.summary,
    namespace: ns.slug,
    namespaceName: ns.displayName,
    status: s.status,
    riskLevel: s.riskLevel,
    latestVersion: s.latestVersionId ? (vmap.get(s.latestVersionId) ?? null) : null,
    publishedVersion: s.publishedVersionId ? (vmap.get(s.publishedVersionId) ?? null) : null,
    installCount: s.installCount,
    tags: s.tags,
    category: s.category,
    sourceName: s.sourceId ? (smap.get(s.sourceId) ?? null) : null,
    updatedAt: s.updatedAt.toISOString(),
    teams: teams.filter((t) => t.skillId === s.id).map((t) => ({ slug: t.slug, level: t.level })),
  }));
}

export function toVersionDto(
  v: typeof skillVersion.$inferSelect,
  users: Map<string, UserSummary>,
): VersionDto {
  return {
    id: v.id,
    version: v.version,
    status: v.status,
    statusReason: v.statusReason,
    changelog: v.changelog,
    description: v.description,
    frontmatter: v.frontmatter,
    contentHash: v.contentHash,
    archiveDigest: v.archiveDigest,
    fileCount: v.fileCount,
    totalSize: v.totalSize,
    riskScore: v.riskScore,
    riskLevel: v.riskLevel,
    provenance: v.provenance as Record<string, unknown>,
    transformations: v.transformations,
    externalRefs: v.externalRefs,
    submittedBy: v.submittedBy ? (users.get(v.submittedBy) ?? null) : null,
    submittedAt: v.submittedAt?.toISOString() ?? null,
    publishedAt: v.publishedAt?.toISOString() ?? null,
    createdAt: v.createdAt.toISOString(),
    installCount: v.installCount,
  };
}

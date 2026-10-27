import type { DashboardDto, InstallChannel, RiskLevel, VersionStatus } from '@dojohub/contract';
import {
  approvalRequest,
  catalogEntry,
  dailyStat,
  namespace,
  orgMember,
  skill,
  skillVersion,
  suite,
} from '@dojohub/db';
import { and, count, desc, eq, gte, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { canReadNamespace } from '../auth/permissions';
import { Api } from '../lib/api';
import { loadSkill } from './skills';

export function dashboardRoutes() {
  const api = new Api();

  api.op(
    {
      method: 'get',
      path: '/dashboard',
      summary: 'Organisation dashboard',
      tags: ['Dashboards'],
      query: z.object({ days: z.coerce.number().int().min(7).max(365).default(30) }),
    },
    async ({ ctx, actor, orgId, query }) => {
      const since = new Date(Date.now() - query.days * 86400_000).toISOString().slice(0, 10);
      const n = async (q: Promise<{ n: number }[]>) => (await q)[0]?.n ?? 0;
      const [skills, suites, published, pendingReviews, blocked, teams, users] = await Promise.all([
        n(
          ctx.db
            .select({ n: count() })
            .from(skill)
            .where(and(eq(skill.orgId, orgId), isNull(skill.archivedAt))),
        ),
        n(
          ctx.db
            .select({ n: count() })
            .from(suite)
            .where(and(eq(suite.orgId, orgId), isNull(suite.archivedAt))),
        ),
        n(
          ctx.db
            .select({ n: count() })
            .from(skill)
            .where(
              and(
                eq(skill.orgId, orgId),
                isNull(skill.archivedAt),
                sql`${skill.publishedVersionId} is not null`,
              ),
            ),
        ),
        n(
          ctx.db
            .select({ n: count() })
            .from(approvalRequest)
            .where(and(eq(approvalRequest.orgId, orgId), eq(approvalRequest.status, 'pending'))),
        ),
        n(
          ctx.db
            .select({ n: count() })
            .from(skillVersion)
            .where(and(eq(skillVersion.orgId, orgId), eq(skillVersion.status, 'blocked'))),
        ),
        n(
          ctx.db
            .select({ n: count() })
            .from(namespace)
            .where(and(eq(namespace.orgId, orgId), eq(namespace.kind, 'team'), isNull(namespace.archivedAt))),
        ),
        n(ctx.db.select({ n: count() }).from(orgMember).where(eq(orgMember.orgId, orgId))),
      ]);
      const byDay = await ctx.db
        .select({
          day: dailyStat.day,
          installs: sql<number>`sum(${dailyStat.installs})::int`,
          updates: sql<number>`sum(${dailyStat.updates})::int`,
        })
        .from(dailyStat)
        .where(and(eq(dailyStat.orgId, orgId), eq(dailyStat.subjectType, 'skill'), gte(dailyStat.day, since)))
        .groupBy(dailyStat.day)
        .orderBy(dailyStat.day);
      const filled: DashboardDto['installsByDay'] = [];
      for (let i = query.days - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
        const row = byDay.find((r) => r.day === day);
        filled.push({ day, installs: row?.installs ?? 0, updates: row?.updates ?? 0 });
      }
      const byChannel = await ctx.db
        .select({ channel: dailyStat.channel, installs: sql<number>`sum(${dailyStat.installs})::int` })
        .from(dailyStat)
        .where(and(eq(dailyStat.orgId, orgId), gte(dailyStat.day, since)))
        .groupBy(dailyStat.channel);
      const top = await ctx.db
        .select({
          id: skill.id,
          name: skill.name,
          namespace: namespace.slug,
          installs: sql<number>`sum(${dailyStat.installs})::int`,
          ns: namespace,
        })
        .from(dailyStat)
        .innerJoin(skill, eq(skill.id, dailyStat.subjectId))
        .innerJoin(namespace, eq(namespace.id, skill.namespaceId))
        .where(and(eq(dailyStat.orgId, orgId), eq(dailyStat.subjectType, 'skill'), gte(dailyStat.day, since)))
        .groupBy(skill.id, skill.name, namespace.slug, namespace.id)
        .orderBy(desc(sql`sum(${dailyStat.installs})`))
        .limit(20);
      const topSuites = await ctx.db
        .select({
          id: suite.id,
          name: suite.name,
          namespace: namespace.slug,
          installs: sql<number>`sum(${dailyStat.installs})::int`,
          ns: namespace,
        })
        .from(dailyStat)
        .innerJoin(suite, eq(suite.id, dailyStat.subjectId))
        .innerJoin(namespace, eq(namespace.id, suite.namespaceId))
        .where(and(eq(dailyStat.orgId, orgId), eq(dailyStat.subjectType, 'suite'), gte(dailyStat.day, since)))
        .groupBy(suite.id, suite.name, namespace.slug, namespace.id)
        .orderBy(desc(sql`sum(${dailyStat.installs})`))
        .limit(10);
      const nsRows = await ctx.db
        .select()
        .from(namespace)
        .where(and(eq(namespace.orgId, orgId), eq(namespace.kind, 'team'), isNull(namespace.archivedAt)));
      const teamAdoption: DashboardDto['teamAdoption'] = [];
      for (const ns of nsRows.filter((x) => canReadNamespace(actor, x))) {
        const [inst] = await ctx.db
          .select({ n: sql<number>`count(*)::int` })
          .from(sql`install_event`)
          .where(sql`namespace_id = ${ns.id} and created_at >= ${since}`);
        const [cat] = await ctx.db
          .select({ n: count() })
          .from(catalogEntry)
          .where(eq(catalogEntry.namespaceId, ns.id));
        teamAdoption.push({
          slug: ns.slug,
          displayName: ns.displayName,
          installs: inst?.n ?? 0,
          catalogSize: cat?.n ?? 0,
        });
      }
      const risk = await ctx.db
        .select({ level: skill.riskLevel, n: count() })
        .from(skill)
        .where(and(eq(skill.orgId, orgId), isNull(skill.archivedAt)))
        .groupBy(skill.riskLevel);
      const status = await ctx.db
        .select({ status: skill.status, n: count() })
        .from(skill)
        .where(and(eq(skill.orgId, orgId), isNull(skill.archivedAt)))
        .groupBy(skill.status);
      const sinceDate = new Date(Date.now() - query.days * 86400_000);
      const decided = await ctx.db
        .select({
          status: skillVersion.status,
          submittedAt: skillVersion.submittedAt,
          decidedAt: skillVersion.decidedAt,
        })
        .from(skillVersion)
        .where(and(eq(skillVersion.orgId, orgId), gte(skillVersion.createdAt, sinceDate)));
      const durations = decided
        .filter((d) => d.submittedAt && d.decidedAt)
        .map((d) => (d.decidedAt!.getTime() - d.submittedAt!.getTime()) / 3600_000)
        .sort((a, b) => a - b);
      const dto: DashboardDto = {
        totals: {
          skills,
          suites,
          published,
          pendingReviews,
          installs30d: filled.reduce((s, d) => s + d.installs, 0),
          blocked,
          teams,
          users,
        },
        installsByDay: filled,
        installsByChannel: byChannel.map((c) => ({
          channel: c.channel as InstallChannel,
          installs: c.installs,
        })),
        topSkills: top.filter((t) => canReadNamespace(actor, t.ns)).map(({ ns: _ns, ...t }) => t),
        topSuites: topSuites.filter((t) => canReadNamespace(actor, t.ns)).map(({ ns: _ns, ...t }) => t),
        teamAdoption: teamAdoption.sort((a, b) => b.installs - a.installs),
        riskDistribution: risk.map((r) => ({
          level: (r.level ?? 'unscanned') as RiskLevel | 'unscanned',
          count: r.n,
        })),
        statusDistribution: status.map((s) => ({ status: s.status as VersionStatus, count: s.n })),
        pipeline: {
          submitted: decided.filter((d) => d.submittedAt).length,
          approved: decided.filter((d) => d.status === 'approved').length,
          rejected: decided.filter((d) => d.status === 'rejected').length,
          medianReviewHours: durations.length
            ? Math.round(durations[Math.floor(durations.length / 2)]! * 10) / 10
            : null,
        },
      };
      return dto;
    },
  );

  api.op(
    {
      method: 'get',
      path: '/skills/:name/stats',
      summary: 'Install statistics for a skill',
      tags: ['Dashboards'],
      query: z.object({ days: z.coerce.number().int().min(7).max(365).default(90) }),
    },
    async ({ ctx, actor, orgId, params, query }) => {
      const row = await loadSkill(ctx, actor, orgId, params.name!);
      const since = new Date(Date.now() - query.days * 86400_000).toISOString().slice(0, 10);
      const rows = await ctx.db
        .select({
          day: dailyStat.day,
          channel: dailyStat.channel,
          installs: dailyStat.installs,
          updates: dailyStat.updates,
        })
        .from(dailyStat)
        .where(
          and(
            eq(dailyStat.subjectType, 'skill'),
            eq(dailyStat.subjectId, row.skill.id),
            gte(dailyStat.day, since),
          ),
        );
      const days: { day: string; installs: number; updates: number }[] = [];
      for (let i = query.days - 1; i >= 0; i--) {
        const day = new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10);
        const r = rows.filter((x) => x.day === day);
        days.push({
          day,
          installs: r.reduce((s, x) => s + x.installs, 0),
          updates: r.reduce((s, x) => s + x.updates, 0),
        });
      }
      const channels: Record<string, number> = {};
      for (const r of rows) channels[r.channel] = (channels[r.channel] ?? 0) + r.installs;
      return { total: row.skill.installCount, days, channels };
    },
  );

  return api;
}

import type { DashboardDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { BarChart3 } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Card, CardHeader, PageHeader, Segmented, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatNumber } from '../lib/format';

const RISK_COLORS: Record<string, string> = { none: '#22c55e', low: '#60a5fa', medium: '#f59e0b', high: '#ef4444', critical: '#991b1b', unscanned: '#9ca3af' };
const STATUS_COLORS: Record<string, string> = { draft: '#9ca3af', submitted: '#60a5fa', scanning: '#60a5fa', in_review: '#f59e0b', approved: '#22c55e', rejected: '#ef4444', deprecated: '#a1a1aa', blocked: '#991b1b' };
const tooltipStyle = { background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12, color: 'var(--fg)' };
const axis = { tick: { fontSize: 11, fill: 'var(--fg-subtle)' }, axisLine: false, tickLine: false } as const;

function Stat({ label, value, to }: { label: string; value: number | string; to?: string }) {
  const body = (
    <Card className="p-4 transition-colors hover:border-border-strong">
      <div className="text-[12px] text-subtle">{label}</div>
      <div className="mt-1 text-[26px] font-semibold tracking-tight tabular-nums">{typeof value === 'number' ? formatNumber(value) : value}</div>
    </Card>
  );
  return to ? <Link to={to}>{body}</Link> : body;
}

export function DashboardPage() {
  const { t } = useTranslation();
  const [days, setDays] = useState('30');
  const q = useQuery({ queryKey: ['dashboard', days], queryFn: () => api.get<DashboardDto>(`dashboard?days=${days}`) });
  const d = q.data;
  return (
    <div>
      <PageHeader
        icon={<BarChart3 className="h-4 w-4" />}
        title={t('dashboard.title')}
        description={t('dashboard.subtitle')}
        actions={<Segmented value={days} onChange={setDays} options={['7', '30', '90'].map((v) => ({ value: v, label: `${v}d` }))} />}
      />
      {!d ? (
        <Skeleton className="h-96" />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
            <Stat label={t('dashboard.totalSkills')} value={d.totals.skills} to="/skills" />
            <Stat label={t('dashboard.published')} value={d.totals.published} />
            <Stat label={t('dashboard.installs', { days })} value={d.totals.installs30d} />
            <Stat label={t('dashboard.pendingReviews')} value={d.totals.pendingReviews} to="/reviews" />
            <Stat label={t('dashboard.blocked')} value={d.totals.blocked} />
          </div>
          <div className="grid gap-4 lg:grid-cols-[1fr_320px]">
            <Card>
              <CardHeader title={t('dashboard.installsOverTime')} />
              <div className="h-64 p-3">
                <ResponsiveContainer>
                  <AreaChart data={d.installsByDay} margin={{ left: -16, right: 8, top: 8 }}>
                    <defs>
                      <linearGradient id="g1" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                        <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid stroke="var(--border)" vertical={false} />
                    <XAxis dataKey="day" {...axis} tickFormatter={(v: string) => v.slice(5)} minTickGap={28} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip contentStyle={tooltipStyle} />
                    <Area type="monotone" dataKey="installs" stroke="var(--accent)" strokeWidth={2} fill="url(#g1)" />
                    <Area type="monotone" dataKey="updates" stroke="var(--fg-subtle)" strokeWidth={1.5} fill="transparent" strokeDasharray="4 3" />
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </Card>
            <Card>
              <CardHeader title={t('dashboard.byChannel')} />
              <div className="space-y-2 p-4">
                {d.installsByChannel.length === 0 && <p className="text-[13px] text-muted">—</p>}
                {d.installsByChannel
                  .sort((a, b) => b.installs - a.installs)
                  .map((c) => {
                    const max = Math.max(...d.installsByChannel.map((x) => x.installs), 1);
                    return (
                      <div key={c.channel}>
                        <div className="mb-1 flex justify-between text-[12.5px]">
                          <span className="text-muted">{t(`dashboard.channels.${c.channel}`)}</span>
                          <span className="tabular-nums">{c.installs}</span>
                        </div>
                        <div className="h-1.5 rounded-full bg-bg-subtle">
                          <div className="h-full rounded-full bg-accent" style={{ width: `${(c.installs / max) * 100}%` }} />
                        </div>
                      </div>
                    );
                  })}
              </div>
            </Card>
          </div>
          <div className="grid gap-4 lg:grid-cols-3">
            <Card className="overflow-hidden">
              <CardHeader title={t('dashboard.topSkills')} />
              {d.topSkills.slice(0, 8).map((s, i) => (
                <Link key={s.id} to="/skills/$name" params={{ name: s.name }} search={{ tab: undefined }} className="flex items-center gap-3 border-b border-border px-4 py-2 text-[13px] last:border-b-0 hover:bg-panel-hover">
                  <span className="w-4 text-subtle tabular-nums">{i + 1}</span>
                  <span className="min-w-0 flex-1 truncate font-medium">{s.name}</span>
                  <span className="text-subtle tabular-nums">{s.installs}</span>
                </Link>
              ))}
              {d.topSkills.length === 0 && <p className="px-4 py-4 text-[13px] text-muted">—</p>}
            </Card>
            <Card>
              <CardHeader title={t('dashboard.riskDistribution')} />
              <div className="h-56">
                <ResponsiveContainer>
                  <PieChart>
                    <Pie data={d.riskDistribution} dataKey="count" nameKey="level" innerRadius={50} outerRadius={80} paddingAngle={2} stroke="none">
                      {d.riskDistribution.map((r) => (
                        <Cell key={r.level} fill={RISK_COLORS[r.level]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={tooltipStyle} formatter={(v, n) => [v, t(`riskLevel.${n}`)]} />
                  </PieChart>
                </ResponsiveContainer>
              </div>
              <div className="flex flex-wrap gap-3 px-4 pb-4 text-[12px]">
                {d.riskDistribution.map((r) => (
                  <span key={r.level} className="flex items-center gap-1.5 text-muted">
                    <span className="h-2 w-2 rounded-full" style={{ background: RISK_COLORS[r.level] }} />
                    {t(`riskLevel.${r.level}`)} {r.count}
                  </span>
                ))}
              </div>
            </Card>
            <Card>
              <CardHeader title={t('dashboard.pipeline')} />
              <div className="grid grid-cols-2 gap-3 p-4">
                <div>
                  <div className="text-[12px] text-subtle">{t('dashboard.approvalRate')}</div>
                  <div className="text-xl font-semibold tabular-nums">
                    {d.pipeline.submitted ? Math.round((d.pipeline.approved / d.pipeline.submitted) * 100) : 0}%
                  </div>
                </div>
                <div>
                  <div className="text-[12px] text-subtle">{t('dashboard.medianReview')}</div>
                  <div className="text-xl font-semibold tabular-nums">{d.pipeline.medianReviewHours === null ? '—' : t('dashboard.hours', { count: d.pipeline.medianReviewHours })}</div>
                </div>
              </div>
              <div className="h-36 px-2">
                <ResponsiveContainer>
                  <BarChart data={d.statusDistribution} margin={{ left: -24, right: 8 }}>
                    <XAxis dataKey="status" {...axis} tickFormatter={(s: string) => t(`status.${s}`).slice(0, 8)} />
                    <YAxis allowDecimals={false} {...axis} />
                    <Tooltip contentStyle={tooltipStyle} labelFormatter={(s) => t(`status.${s}`)} />
                    <Bar dataKey="count" radius={[4, 4, 0, 0]}>
                      {d.statusDistribution.map((s) => (
                        <Cell key={s.status} fill={STATUS_COLORS[s.status]} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </Card>
          </div>
          <Card className="overflow-hidden">
            <CardHeader title={t('dashboard.teamAdoption')} />
            {d.teamAdoption.map((tm) => {
              const max = Math.max(...d.teamAdoption.map((x) => x.installs), 1);
              return (
                <Link key={tm.slug} to="/teams/$slug" params={{ slug: tm.slug }} search={{ tab: undefined }} className="flex items-center gap-4 border-b border-border px-4 py-2 text-[13px] last:border-b-0 hover:bg-panel-hover">
                  <span className="w-40 truncate font-medium">{tm.displayName}</span>
                  <div className="h-1.5 flex-1 rounded-full bg-bg-subtle">
                    <div className="h-full rounded-full bg-accent" style={{ width: `${(tm.installs / max) * 100}%` }} />
                  </div>
                  <span className="w-20 text-right text-subtle tabular-nums">{t('count.installs', { count: tm.installs })}</span>
                  <span className="w-24 text-right text-subtle">{t('count.skills', { count: tm.catalogSize })}</span>
                </Link>
              );
            })}
          </Card>
        </div>
      )}
    </div>
  );
}

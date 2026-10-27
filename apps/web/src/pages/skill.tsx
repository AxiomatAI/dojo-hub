import { type NamespaceDto, type SkillDetailDto, type VersionDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ArrowLeftRight, Ban, Download, ExternalLink, GitCommit, MoreHorizontal, Plus, RotateCcw, Send, Undo2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip as RTooltip, XAxis, YAxis } from 'recharts';
import { DiffView, InstallMenu, Markdown, NamespaceChip, RiskBadge, SkillGlyph, StatusPill } from '../components/dojo';
import { Badge, Button, Card, CardHeader, Dialog, EmptyState, Field, Menu, MenuContent, MenuItem, MenuSeparator, MenuTrigger, Select, Skeleton, TabPanel, Tabs, Textarea } from '../components/ui';
import { FilesBrowser, SecurityReport, type VersionDetail } from '../components/version';
import { api } from '../lib/api';
import { formatDateTime, formatNumber, relativeTime } from '../lib/format';
import { useAction } from '../lib/hooks';
import { formatBytes } from '../lib/utils';

type FullVersion = VersionDetail &
  VersionDto & { review: { id: string; status: string } | null; canSubmit: boolean; canManage: boolean };

function useVersion(name: string, version: string | null | undefined) {
  return useQuery({
    queryKey: ['version', name, version],
    queryFn: () => api.get<FullVersion>(`skills/${encodeURIComponent(name)}/versions/${encodeURIComponent(version!)}`),
    enabled: !!version,
    refetchInterval: (q) => (['submitted', 'scanning'].includes(q.state.data?.status ?? '') ? 2500 : false),
  });
}

function VersionActions({ name, v }: { name: string; v: FullVersion }) {
  const { t } = useTranslation();
  const [dialog, setDialog] = useState<null | 'blocked' | 'deprecated'>(null);
  const [reason, setReason] = useState('');
  const keys = [['skill', name], ['version', name, v.version], ['skills']];
  const status = useAction((body: { status: string; reason?: string }) => api.post(`skills/${name}/versions/${v.version}/status`, body), { invalidate: keys, onSuccess: () => setDialog(null) });
  const submit = useAction(() => api.post(`skills/${name}/versions/${v.version}/submit`), { invalidate: keys });
  const withdraw = useAction(() => api.post(`skills/${name}/versions/${v.version}/withdraw`), { invalidate: keys });
  const rescan = useAction(() => api.post(`skills/${name}/versions/${v.version}/rescan`), { invalidate: keys });
  return (
    <>
      {v.canSubmit && (
        <Button variant="primary" icon={<Send className="h-3.5 w-3.5" />} loading={submit.isPending} onClick={() => submit.mutate(undefined)}>
          {t('skills.submitDraft')}
        </Button>
      )}
      <Menu>
        <MenuTrigger asChild>
          <Button size="icon" aria-label={t('common.actions')}>
            <MoreHorizontal className="h-4 w-4" />
          </Button>
        </MenuTrigger>
        <MenuContent>
          <MenuItem icon={<Download className="h-4 w-4" />} onSelect={() => window.open(`/api/v1/skills/${name}/versions/${v.version}/download?channel=web`)}>
            {t('skills.download')}
          </MenuItem>
          {v.status === 'in_review' && (
            <MenuItem icon={<Undo2 className="h-4 w-4" />} onSelect={() => withdraw.mutate(undefined)}>
              {t('skills.withdraw')}
            </MenuItem>
          )}
          {v.canManage && ['in_review', 'submitted', 'scanning'].includes(v.status) && (
            <MenuItem icon={<RotateCcw className="h-4 w-4" />} onSelect={() => rescan.mutate(undefined)}>
              {t('skills.rescan')}
            </MenuItem>
          )}
          {v.canManage && (
            <>
              <MenuSeparator />
              {v.status === 'approved' && (
                <MenuItem icon={<AlertTriangle className="h-4 w-4" />} onSelect={() => setDialog('deprecated')}>
                  {t('skills.deprecate')}
                </MenuItem>
              )}
              {['approved', 'deprecated'].includes(v.status) && (
                <MenuItem danger icon={<Ban className="h-4 w-4" />} onSelect={() => setDialog('blocked')}>
                  {t('skills.block')}
                </MenuItem>
              )}
              {['blocked', 'deprecated'].includes(v.status) && (
                <MenuItem icon={<RotateCcw className="h-4 w-4" />} onSelect={() => status.mutate({ status: 'approved' })}>
                  {t('skills.unblock')}
                </MenuItem>
              )}
            </>
          )}
        </MenuContent>
      </Menu>
      <Dialog
        open={!!dialog}
        onOpenChange={(o) => !o && setDialog(null)}
        title={dialog === 'blocked' ? `${t('skills.block')} ${name}@${v.version}` : `${t('skills.deprecate')} ${name}@${v.version}`}
        description={dialog === 'blocked' ? t('skills.blockConfirm') : undefined}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDialog(null)}>
              {t('common.cancel')}
            </Button>
            <Button
              variant={dialog === 'blocked' ? 'danger' : 'primary'}
              loading={status.isPending}
              disabled={dialog === 'blocked' && !reason.trim()}
              onClick={() => status.mutate({ status: dialog!, reason: reason || undefined })}
            >
              {dialog === 'blocked' ? t('skills.block') : t('skills.deprecate')}
            </Button>
          </>
        }
      >
        <Field label={dialog === 'blocked' ? t('skills.blockReason') : t('skills.deprecateReason')}>
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </Field>
      </Dialog>
    </>
  );
}

function AddToTeam({ skillId, open, onOpenChange }: { skillId: string; open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const teams = useQuery({ queryKey: ['namespaces'], queryFn: () => api.get<NamespaceDto[]>('namespaces'), enabled: open });
  const manageable = teams.data?.filter((n) => n.myRole === 'owner' || n.myRole === 'maintainer' || n.kind === 'org') ?? [];
  const [team, setTeam] = useState('');
  const [level, setLevel] = useState('recommended');
  const add = useAction(() => api.post(`namespaces/${team}/catalog`, { skillId, level }), { invalidate: [['skill'], ['namespace']], success: t('common.done'), onSuccess: () => onOpenChange(false) });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('skills.addToTeam')}
      footer={
        <Button variant="primary" disabled={!team} loading={add.isPending} onClick={() => add.mutate(undefined)}>
          {t('common.add')}
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label={t('common.team')}>
          <Select value={team} onChange={(e) => setTeam(e.target.value)}>
            <option value="">—</option>
            {manageable.map((n) => (
              <option key={n.id} value={n.slug}>
                {n.displayName}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('common.status')}>
          <Select value={level} onChange={(e) => setLevel(e.target.value)}>
            {['required', 'recommended', 'optional'].map((l) => (
              <option key={l} value={l}>
                {t(`level.${l}`)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Dialog>
  );
}

function InstallsChart({ name }: { name: string }) {
  const { t } = useTranslation();
  const stats = useQuery({ queryKey: ['skill-stats', name], queryFn: () => api.get<{ total: number; days: { day: string; installs: number; updates: number }[]; channels: Record<string, number> }>(`skills/${name}/stats`) });
  if (!stats.data) return <Skeleton className="h-64" />;
  return (
    <div className="grid gap-4 md:grid-cols-[1fr_240px]">
      <Card className="p-4">
        <div className="mb-3 text-[13px] font-semibold">{t('dashboard.installsOverTime')}</div>
        <div className="h-60">
          <ResponsiveContainer>
            <AreaChart data={stats.data.days} margin={{ left: -20, right: 8 }}>
              <defs>
                <linearGradient id="inst" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
                  <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis dataKey="day" tick={{ fontSize: 11, fill: 'var(--fg-subtle)' }} tickFormatter={(d: string) => d.slice(5)} minTickGap={24} axisLine={false} tickLine={false} />
              <YAxis allowDecimals={false} tick={{ fontSize: 11, fill: 'var(--fg-subtle)' }} axisLine={false} tickLine={false} />
              <RTooltip contentStyle={{ background: 'var(--panel)', border: '1px solid var(--border)', borderRadius: 8, fontSize: 12 }} />
              <Area type="monotone" dataKey="installs" stroke="var(--accent)" fill="url(#inst)" strokeWidth={2} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </Card>
      <Card className="p-4">
        <div className="text-[12px] text-subtle">{t('common.installs')}</div>
        <div className="text-3xl font-semibold tabular-nums">{formatNumber(stats.data.total)}</div>
        <div className="mt-4 space-y-2">
          {Object.entries(stats.data.channels).map(([ch, n]) => (
            <div key={ch} className="flex justify-between text-[13px]">
              <span className="text-muted">{t(`dashboard.channels.${ch}`, { defaultValue: ch })}</span>
              <span className="tabular-nums">{n}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function SkillDetailPage() {
  const { t } = useTranslation();
  const { name } = useParams({ from: '/app/skills/$name' });
  const search = useSearch({ from: '/app/skills/$name' }) as { tab?: string };
  const navigate = useNavigate();
  const tab = search.tab ?? 'overview';
  const [addTeam, setAddTeam] = useState(false);
  const skill = useQuery({ queryKey: ['skill', name], queryFn: () => api.get<SkillDetailDto>(`skills/${encodeURIComponent(name)}`) });
  const s = skill.data;
  const current = s?.versions.find((v) => v.version === s.publishedVersion) ?? s?.versions[0];
  const version = useVersion(name, current?.version);
  const readme = useQuery({
    queryKey: ['file', name, current?.version, 'SKILL.md'],
    queryFn: () => fetch(`/api/v1/skills/${encodeURIComponent(name)}/versions/${current!.version}/files/SKILL.md`, { credentials: 'include' }).then((r) => r.text()),
    enabled: !!current,
  });
  const [compare, setCompare] = useState<string[]>([]);

  if (skill.isLoading) return <Skeleton className="h-64" />;
  if (!s) return <EmptyState title={t('common.notFound')} />;

  return (
    <div>
      <div className="mb-1 text-[12.5px] text-subtle">
        <Link to="/skills" className="hover:text-fg">
          {t('nav.skills')}
        </Link>{' '}
        / <NamespaceChip slug={s.namespace} />
      </div>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <SkillGlyph name={s.name} size={48} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-tight">{s.displayName}</h1>
            <StatusPill status={s.status} />
            <RiskBadge level={s.riskLevel} />
          </div>
          <p className="mt-1 max-w-3xl text-muted">{s.summary}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-subtle">
            <code className="font-mono">{s.name}</code>
            {s.publishedVersion && <span>v{s.publishedVersion}</span>}
            <span>{t('count.installs', { count: s.installCount })}</span>
            {s.source && (
              <Link to="/sources/$id" params={{ id: s.source.id }} className="hover:text-fg">
                {t('skills.importedFrom')} {s.source.name}
              </Link>
            )}
            <span>
              {t('common.updated')} {relativeTime(s.updatedAt)}
            </span>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {s.canEdit && (
            <Link to="/submit" search={{ mode: 'upload', skill: s.name, namespace: s.namespace }}>
              <Button icon={<Plus className="h-3.5 w-3.5" />}>{t('skills.newVersion')}</Button>
            </Link>
          )}
          <Button icon={<Users className="h-3.5 w-3.5" />} onClick={() => setAddTeam(true)}>
            {t('skills.addToTeam')}
          </Button>
          {s.publishedVersion && <InstallMenu install={s.install} />}
        </div>
      </div>
      {s.upstreamRemoved && (
        <div className="mb-4 flex items-center gap-2 rounded-lg border border-warn/30 bg-warn/10 px-3 py-2 text-[13px] text-warn">
          <AlertTriangle className="h-4 w-4" /> {t('skills.upstreamRemoved')}
        </div>
      )}
      <Tabs
        value={tab}
        onValueChange={(v) => navigate({ to: '/skills/$name', params: { name }, search: { tab: v }, replace: true })}
        tabs={[
          { value: 'overview', label: t('skills.tabs.overview') },
          { value: 'files', label: t('skills.tabs.files'), count: current?.fileCount },
          { value: 'versions', label: t('skills.tabs.versions'), count: s.versions.length },
          { value: 'security', label: t('skills.tabs.security') },
          { value: 'installs', label: t('skills.tabs.installs') },
        ]}
      >
        <TabPanel value="overview">
          <div className="grid gap-6 lg:grid-cols-[1fr_300px]">
            <Card className="px-6 py-5">{readme.data ? <Markdown>{readme.data}</Markdown> : <Skeleton className="h-48" />}</Card>
            <div className="space-y-4">
              <Card className="p-4">
                <div className="mb-2 text-[12px] font-medium text-subtle uppercase">{t('skills.teamsUsing')}</div>
                {s.teams?.length ? (
                  <div className="flex flex-wrap gap-1.5">
                    {s.teams.map((tm) => (
                      <Link key={tm.slug} to="/teams/$slug" params={{ slug: tm.slug }}>
                        <Badge tone={tm.level === 'required' ? 'accent' : 'neutral'}>
                          @{tm.slug} · {t(`level.${tm.level}`)}
                        </Badge>
                      </Link>
                    ))}
                  </div>
                ) : (
                  <p className="text-[12.5px] text-muted">—</p>
                )}
                {s.suites.length > 0 && (
                  <>
                    <div className="mt-4 mb-2 text-[12px] font-medium text-subtle uppercase">{t('skills.inSuites')}</div>
                    <div className="flex flex-wrap gap-1.5">
                      {s.suites.map((su) => (
                        <Link key={su.id} to="/suites/$ns/$name" params={{ ns: su.namespace, name: su.name }}>
                          <Badge>{su.name}</Badge>
                        </Link>
                      ))}
                    </div>
                  </>
                )}
              </Card>
              {current && (
                <Card className="space-y-2 p-4 text-[12.5px]">
                  <div className="mb-1 text-[12px] font-medium text-subtle uppercase">{t('skills.provenance')}</div>
                  <Row label={t('common.version')} value={`v${current.version}`} />
                  <Row label={t('common.files')} value={`${current.fileCount} · ${formatBytes(current.totalSize)}`} />
                  {typeof current.frontmatter.license === 'string' && <Row label={t('skills.license')} value={current.frontmatter.license} />}
                  {current.provenance.url ? (
                    <Row
                      label={t('skills.source')}
                      value={
                        <a href={String(current.provenance.url)} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-accent">
                          {String(current.provenance.url).replace(/^https?:\/\//, '').slice(0, 40)} <ExternalLink className="h-3 w-3" />
                        </a>
                      }
                    />
                  ) : null}
                  {current.provenance.commit ? <Row label={t('skills.commit')} value={<code className="font-mono">{String(current.provenance.commit).slice(0, 10)}</code>} /> : null}
                  <Row label="sha256" value={<code className="font-mono">{current.archiveDigest.slice(0, 12)}…</code>} />
                  {current.publishedAt && <Row label={t('status.approved')} value={formatDateTime(current.publishedAt)} />}
                  {current.transformations.length > 0 && (
                    <div className="pt-1">
                      <div className="text-subtle">{t('skills.transformations')}</div>
                      {current.transformations.map((x) => (
                        <div key={x.detail} className="text-muted">
                          · {x.detail}
                        </div>
                      ))}
                    </div>
                  )}
                </Card>
              )}
            </div>
          </div>
        </TabPanel>
        <TabPanel value="files">{version.data ? <FilesBrowser skill={name} version={version.data.version} files={version.data.files} /> : <Skeleton className="h-96" />}</TabPanel>
        <TabPanel value="versions">
          <Card className="overflow-hidden">
            <CardHeader
              title={t('skills.tabs.versions')}
              actions={
                <Button
                  size="sm"
                  disabled={compare.length !== 2}
                  icon={<ArrowLeftRight className="h-3.5 w-3.5" />}
                  onClick={() => {
                    const [a, b] = [...compare].sort((x, y) => s.versions.findIndex((v) => v.version === y) - s.versions.findIndex((v) => v.version === x));
                    void navigate({ to: '/skills/$name/diff', params: { name }, search: { from: a, to: b } });
                  }}
                >
                  {t('skills.compare')}
                </Button>
              }
            />
            {s.versions.map((v) => (
              <div key={v.id} className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-panel-hover">
                <input
                  type="checkbox"
                  aria-label={`compare ${v.version}`}
                  checked={compare.includes(v.version)}
                  onChange={(e) => setCompare((c) => (e.target.checked ? [...c, v.version].slice(-2) : c.filter((x) => x !== v.version)))}
                  className="accent-[var(--accent)]"
                />
                <GitCommit className="h-4 w-4 text-subtle" />
                <Link to="/skills/$name/versions/$version" params={{ name, version: v.version }} search={{ file: undefined }} className="font-mono font-medium hover:text-accent">
                  v{v.version}
                </Link>
                <StatusPill status={v.status} />
                <RiskBadge level={v.riskLevel} score={v.riskScore} />
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-muted">{v.statusReason ?? v.changelog ?? ''}</span>
                <span className="hidden text-[12px] text-subtle md:inline">{v.submittedBy?.name}</span>
                <span className="w-24 text-right text-[12px] text-subtle">{relativeTime(v.createdAt)}</span>
              </div>
            ))}
          </Card>
        </TabPanel>
        <TabPanel value="security">{version.data ? <SecurityReport detail={version.data} skill={name} /> : <Skeleton className="h-64" />}</TabPanel>
        <TabPanel value="installs">
          <InstallsChart name={name} />
        </TabPanel>
      </Tabs>
      <AddToTeam skillId={s.id} open={addTeam} onOpenChange={setAddTeam} />
    </div>
  );
}

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <span className="shrink-0 text-subtle">{label}</span>
      <span className="min-w-0 truncate text-right">{value}</span>
    </div>
  );
}

export function VersionPage() {
  const { t } = useTranslation();
  const { name, version } = useParams({ from: '/app/skills/$name/versions/$version' });
  const search = useSearch({ from: '/app/skills/$name/versions/$version' }) as { file?: string };
  const [tab, setTab] = useState('files');
  const [file, setFile] = useState<string | undefined>(search.file);
  const v = useVersion(name, version);
  if (v.isLoading) return <Skeleton className="h-64" />;
  if (!v.data) return <EmptyState title={t('common.notFound')} />;
  const d = v.data;
  return (
    <div>
      <div className="mb-1 text-[12.5px] text-subtle">
        <Link to="/skills/$name" params={{ name }} search={{ tab: 'versions' }} className="hover:text-fg">
          {name}
        </Link>{' '}
        / v{d.version}
      </div>
      <div className="mb-5 flex flex-wrap items-center gap-3">
        <h1 className="font-mono text-[20px] font-semibold">
          {name}@{d.version}
        </h1>
        <StatusPill status={d.status} />
        <RiskBadge level={d.riskLevel} score={d.riskScore} />
        {d.review && (
          <Link to="/reviews/$id" params={{ id: d.review.id }} className="text-[12.5px] text-accent">
            {t('reviews.stages')} →
          </Link>
        )}
        <div className="ml-auto flex gap-2">
          <VersionActions name={name} v={d} />
        </div>
      </div>
      {d.statusReason && <div className="mb-4 rounded-lg border border-border bg-bg-subtle px-3 py-2 text-[13px] text-muted">{d.statusReason}</div>}
      <Tabs
        value={tab}
        onValueChange={setTab}
        tabs={[
          { value: 'files', label: t('skills.tabs.files'), count: d.files.length },
          { value: 'security', label: t('skills.tabs.security'), count: d.scans.reduce((n, s) => n + s.findings.filter((f) => f.severity !== 'info').length, 0) },
        ]}
      >
        <TabPanel value="files">
          <FilesBrowser skill={name} version={d.version} files={d.files} initial={file} />
        </TabPanel>
        <TabPanel value="security">
          <SecurityReport
            detail={d}
            skill={name}
            onFile={(p) => {
              setFile(p);
              setTab('files');
            }}
          />
        </TabPanel>
      </Tabs>
    </div>
  );
}

export function SkillDiffPage() {
  const { t } = useTranslation();
  const { name } = useParams({ from: '/app/skills/$name/diff' });
  const search = useSearch({ from: '/app/skills/$name/diff' }) as { from?: string; to?: string };
  const diff = useQuery({
    queryKey: ['diff', name, search.from, search.to],
    queryFn: () =>
      api.get<{ from: string; to: string; changes: { path: string; change: string; binary: boolean; patch: string | null }[]; frontmatterChanged: boolean }>(
        `skills/${name}/diff?from=${search.from}&to=${search.to}`,
      ),
    enabled: !!search.from && !!search.to,
  });
  return <DiffSummary name={name} data={diff.data} loading={diff.isLoading} title={t('skills.diffTitle', { from: search.from, to: search.to })} />;
}

export function DiffSummary({ name, data, loading, title }: { name: string; data?: { changes: { path: string; change: string; binary: boolean; patch: string | null }[] }; loading?: boolean; title?: string }) {
  const { t } = useTranslation();
  if (loading) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-3">
      {title && (
        <div className="mb-4 flex items-center gap-2">
          <Link to="/skills/$name" params={{ name }} search={{ tab: 'versions' }} className="text-[12.5px] text-subtle hover:text-fg">
            {name}
          </Link>
          <span className="text-subtle">/</span>
          <h1 className="text-[18px] font-semibold">{title}</h1>
        </div>
      )}
      {!data?.changes.length && <Card className="p-6 text-center text-muted">{t('skills.noChanges')}</Card>}
      {data?.changes.map((c) => (
        <Card key={c.path} className="overflow-hidden">
          <div className="flex items-center gap-2 border-b border-border px-4 py-2">
            <Badge tone={c.change === 'added' ? 'ok' : c.change === 'removed' ? 'danger' : 'warn'}>{t(`skills.${c.change}`)}</Badge>
            <code className="font-mono text-[12.5px]">{c.path}</code>
          </div>
          {c.binary ? <p className="px-4 py-3 text-[12.5px] text-muted">{t('skills.binaryFile')}</p> : c.patch && <DiffView patch={c.patch} />}
        </Card>
      ))}
    </div>
  );
}

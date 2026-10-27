import type { PresetSource, SourceDto, SourceItemDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Boxes, CheckCircle2, Download, GitBranch, Plus, RefreshCw, Search, Sparkles, Trash2 } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMe } from '../components/shell';
import { Badge, Button, Card, CardHeader, Checkbox, EmptyState, Field, Input, PageHeader, Select, Skeleton, Spinner, Switch, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { errorMessage, useAction } from '../lib/hooks';
import { cn } from '../lib/utils';

export function SourcesPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['sources'], queryFn: () => api.get<SourceDto[]>('sources') });
  return (
    <div>
      <PageHeader
        icon={<GitBranch className="h-4 w-4" />}
        title={t('sources.title')}
        description={t('sources.subtitle')}
        actions={
          <Link to="/sources/new" search={{ preset: undefined, url: undefined }}>
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />}>
              {t('sources.new')}
            </Button>
          </Link>
        }
      />
      <Card className="overflow-hidden">
        {q.isLoading && <Skeleton className="m-4 h-24" />}
        {q.data?.length === 0 && <EmptyState icon={<GitBranch className="h-5 w-5" />} title={t('sources.new')} description={t('sources.localCopy')} />}
        {q.data?.map((s) => (
          <Link key={s.id} to="/sources/$id" params={{ id: s.id }} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-panel-hover">
            <GitBranch className="h-4 w-4 text-subtle" />
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="font-medium">{s.name}</span>
                <Badge>{t(`sources.kind.${s.kind}`)}</Badge>
                {s.status === 'error' && <Badge tone="danger">error</Badge>}
              </div>
              <div className="truncate font-mono text-[12px] text-subtle">{s.url}</div>
            </div>
            {s.itemCounts.update_available > 0 && <Badge tone="warn">{t('sources.itemStatus.update_available')}: {s.itemCounts.update_available}</Badge>}
            <span className="text-[12px] text-subtle">{t('count.skills', { count: s.itemCounts.imported })}</span>
            <span className="w-28 text-right text-[12px] text-subtle">{s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : t('sources.never')}</span>
          </Link>
        ))}
      </Card>
    </div>
  );
}

interface Preview {
  commit: string | null;
  warnings: string[];
  skills: { name: string; path: string; description: string; files: number; errors: string[]; suites: string[] }[];
  suites: { name: string; description?: string; version?: string; skills: string[] }[];
}

export function NewSourcePage() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const search = useSearch({ from: '/app/sources/new' }) as { preset?: string; url?: string };
  const presets = useQuery({ queryKey: ['presets'], queryFn: () => api.get<PresetSource[]>('sources/presets') });
  const writable = me.namespaces.filter((n) => n.role === 'owner' || n.role === 'maintainer');
  const [form, setForm] = useState({ kind: 'github', name: '', url: search.url ?? '', ref: '', include: '', exclude: '', credential: '', syncCron: '', namePrefix: '', autoTrack: true, namespace: '' });
  const [preview, setPreview] = useState<Preview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [skillsShQ, setSkillsShQ] = useState('');
  const skillsSh = useQuery({ queryKey: ['skills-sh', skillsShQ], queryFn: () => api.get<{ id: string; name: string; source: string; installs: number }[]>(`discover/skills-sh?q=${encodeURIComponent(skillsShQ)}`), enabled: skillsShQ.length > 2 });
  useEffect(() => {
    if (!form.namespace) setForm((f) => ({ ...f, namespace: writable[0]?.slug ?? 'org' }));
  }, [writable, form.namespace]);
  useEffect(() => {
    const p = presets.data?.find((x) => x.id === search.preset);
    if (p) setForm((f) => ({ ...f, kind: p.kind, name: p.name, url: p.url }));
  }, [presets.data, search.preset]);
  const lines = (s: string) => s.split('\n').map((x) => x.trim()).filter(Boolean);
  const runPreview = async () => {
    setPreviewing(true);
    setPreview(null);
    try {
      setPreview(await api.post<Preview>('sources/preview', { kind: form.kind, url: form.url, ref: form.ref || undefined, include: lines(form.include), exclude: lines(form.exclude) }));
    } catch (err) {
      toast.error(errorMessage(err));
    } finally {
      setPreviewing(false);
    }
  };
  const create = useAction(
    () =>
      api.post<SourceDto>('sources', {
        namespace: form.namespace,
        kind: form.kind,
        name: form.name || form.url.replace(/^https?:\/\/(www\.)?/, ''),
        url: form.url,
        ref: form.ref || undefined,
        include: lines(form.include),
        exclude: lines(form.exclude),
        credential: form.credential || undefined,
        syncCron: form.syncCron || undefined,
        namePrefix: form.namePrefix || undefined,
        autoTrack: form.autoTrack,
      }),
    { invalidate: [['sources']], onSuccess: (s) => navigate({ to: '/sources/$id', params: { id: s.id } }) },
  );
  return (
    <div>
      <PageHeader icon={<GitBranch className="h-4 w-4" />} title={t('sources.new')} description={t('sources.localCopy')} />
      <div className="mb-6">
        <div className="mb-2 text-[12px] font-medium text-subtle uppercase">{t('sources.presets')}</div>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {presets.data?.map((p) => (
            <button
              type="button"
              key={p.id}
              onClick={() => {
                setForm((f) => ({ ...f, kind: p.kind, name: p.name, url: p.url }));
                setPreview(null);
              }}
              className={cn('rounded-xl border bg-panel p-3.5 text-left transition-colors hover:border-border-strong', form.url === p.url ? 'border-accent ring-2 ring-[var(--ring)]' : 'border-border')}
            >
              <div className="flex items-center gap-2">
                {p.kindLabel === 'suite' ? <Boxes className="h-4 w-4 text-accent" /> : <Sparkles className="h-4 w-4 text-accent" />}
                <span className="font-medium">{p.name}</span>
              </div>
              <p className="mt-1 line-clamp-2 text-[12.5px] text-muted">{p.description}</p>
            </button>
          ))}
        </div>
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-4">
          <Card className="space-y-3 p-4">
            <div className="grid gap-3 md:grid-cols-[160px_1fr]">
              <Field label={t('common.status')}>
                <Select value={form.kind} onChange={(e) => setForm({ ...form, kind: e.target.value })}>
                  {['github', 'gitlab', 'git', 'well_known', 'skills_sh', 'upload'].map((k) => (
                    <option key={k} value={k}>
                      {t(`sources.kind.${k}`)}
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label={t('sources.url')}>
                <Input value={form.url} onChange={(e) => setForm({ ...form, url: e.target.value })} placeholder="https://github.com/org/skills or owner/repo" className="font-mono" />
              </Field>
            </div>
            <div className="grid gap-3 md:grid-cols-2">
              <Field label={t('common.name')}>
                <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />
              </Field>
              <Field label={t('sources.ref')}>
                <Input value={form.ref} onChange={(e) => setForm({ ...form, ref: e.target.value })} placeholder="main" className="font-mono" />
              </Field>
              <Field label={t('sources.include')} hint={t('sources.globHint')}>
                <Textarea rows={2} value={form.include} onChange={(e) => setForm({ ...form, include: e.target.value })} className="font-mono text-[12px]" placeholder="skills/**" />
              </Field>
              <Field label={t('sources.exclude')} hint={t('sources.globHint')}>
                <Textarea rows={2} value={form.exclude} onChange={(e) => setForm({ ...form, exclude: e.target.value })} className="font-mono text-[12px]" placeholder="skills/in-progress/**" />
              </Field>
            </div>
            <div className="flex justify-end">
              <Button onClick={runPreview} loading={previewing} disabled={!form.url || form.kind === 'upload'} icon={<Search className="h-3.5 w-3.5" />}>
                {t('sources.preview')}
              </Button>
            </div>
          </Card>
          {previewing && (
            <Card className="flex items-center gap-2 p-4 text-muted">
              <Spinner /> {t('common.loading')}
            </Card>
          )}
          {preview && (
            <Card className="overflow-hidden">
              <CardHeader
                title={`${t('sources.discovered')}: ${t('count.skills', { count: preview.skills.length })}, ${t('count.suites', { count: preview.suites.length })}`}
                description={preview.commit ? `commit ${preview.commit.slice(0, 12)}` : undefined}
              />
              {preview.suites.map((s) => (
                <div key={s.name} className="flex items-center gap-2 border-b border-border px-4 py-2 text-[13px]">
                  <Boxes className="h-4 w-4 text-accent" />
                  <span className="font-medium">{s.name}</span>
                  {s.version && <code className="font-mono text-[11.5px] text-subtle">v{s.version}</code>}
                  <span className="text-[12px] text-subtle">{t('count.skills', { count: s.skills.length })}</span>
                </div>
              ))}
              <div className="max-h-80 overflow-y-auto">
                {preview.skills.map((s) => (
                  <div key={s.path} className="flex items-center gap-2 border-b border-border px-4 py-1.5 text-[12.5px] last:border-b-0">
                    <code className="font-mono">{s.name}</code>
                    <span className="min-w-0 flex-1 truncate text-muted">{s.description}</span>
                    {s.errors.length > 0 && <Badge tone="danger">{s.errors.length}</Badge>}
                  </div>
                ))}
              </div>
              {preview.warnings.length > 0 && <div className="border-t border-border px-4 py-2 text-[12px] text-warn">{preview.warnings.slice(0, 5).join(' · ')}</div>}
            </Card>
          )}
          <Card className="p-4">
            <div className="mb-2 flex items-center gap-2 font-medium">
              <Search className="h-4 w-4 text-subtle" /> {t('sources.searchSkillsSh')}
            </div>
            <Input value={skillsShQ} onChange={(e) => setSkillsShQ(e.target.value)} placeholder="react, pdf, testing…" />
            <div className="mt-2 max-h-64 divide-y divide-border overflow-y-auto">
              {skillsSh.data?.map((r) => (
                <button
                  type="button"
                  key={r.id}
                  className="flex w-full items-center gap-2 px-1 py-1.5 text-left text-[12.5px] hover:bg-panel-hover"
                  onClick={() => {
                    setForm((f) => ({ ...f, kind: 'github', url: r.source, name: r.source, include: '' }));
                    setPreview(null);
                  }}
                >
                  <code className="font-mono">{r.name}</code>
                  <span className="truncate text-subtle">{r.source}</span>
                  <span className="ml-auto text-subtle tabular-nums">
                    <Download className="mr-1 inline h-3 w-3" />
                    {r.installs}
                  </span>
                </button>
              ))}
            </div>
          </Card>
        </div>
        <Card className="h-fit space-y-3 p-4 lg:sticky lg:top-4">
          <Field label={t('submit.targetNamespace')}>
            <Select value={form.namespace} onChange={(e) => setForm({ ...form, namespace: e.target.value })}>
              {me.permissions.includes('org.admin') && <option value="org">@org</option>}
              {writable.map((n) => (
                <option key={n.id} value={n.slug}>
                  {n.displayName}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('sources.namePrefix')} hint={t('sources.namePrefixHint')}>
            <Input value={form.namePrefix} onChange={(e) => setForm({ ...form, namePrefix: e.target.value })} className="font-mono" />
          </Field>
          <Field label={t('sources.credential')}>
            <Input type="password" value={form.credential} onChange={(e) => setForm({ ...form, credential: e.target.value })} autoComplete="off" />
          </Field>
          <Field label={t('sources.schedule')} hint={t('sources.scheduleHint')}>
            <Input value={form.syncCron} onChange={(e) => setForm({ ...form, syncCron: e.target.value })} placeholder="0 6 * * 1" className="font-mono" />
          </Field>
          <Switch checked={form.autoTrack} onCheckedChange={(v) => setForm({ ...form, autoTrack: v })} label={t('sources.autoTrack')} />
          <Button variant="primary" className="w-full" disabled={!form.url} loading={create.isPending} onClick={() => create.mutate(undefined)}>
            {t('sources.new')}
          </Button>
        </Card>
      </div>
    </div>
  );
}

export function SourceDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/app/sources/$id' });
  const navigate = useNavigate();
  const src = useQuery({ queryKey: ['source', id], queryFn: () => api.get<SourceDto & { warnings: string[]; canManage: boolean }>(`sources/${id}`) });
  const items = useQuery({ queryKey: ['source-items', id], queryFn: () => api.get<SourceItemDto[]>(`sources/${id}/items`) });
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const keys = [['source', id], ['source-items', id], ['skills'], ['suites']];
  const sync = useAction(() => api.post(`sources/${id}/sync`), { invalidate: keys, success: t('common.done') });
  const remove = useAction(() => api.del(`sources/${id}`), { invalidate: [['sources']], onSuccess: () => navigate({ to: '/sources' }) });
  const importSel = useAction(() => api.post<{ results: { item: string; ok: boolean; message: string }[] }>(`sources/${id}/import`, { items: [...selected] }), {
    invalidate: keys,
    success: (r) => t('sources.importResult', { ok: r.results.filter((x) => x.ok).length, failed: r.results.filter((x) => !x.ok).length }),
    onSuccess: (r) => {
      setSelected(new Set());
      for (const f of r.results.filter((x) => !x.ok)) toast.error(`${f.item}: ${f.message}`);
    },
  });
  const upload = async (file: File) => {
    try {
      await api.post(`sources/${id}/upload`, file, { 'content-type': 'application/octet-stream' });
      void items.refetch();
      void src.refetch();
    } catch (err) {
      toast.error(errorMessage(err));
    }
  };
  const suites = useMemo(() => items.data?.filter((i) => i.kind === 'suite') ?? [], [items.data]);
  const skills = useMemo(() => items.data?.filter((i) => i.kind === 'skill') ?? [], [items.data]);
  const selectable = (i: SourceItemDto) => i.status !== 'removed' && (i.status !== 'imported' || i.kind === 'suite');
  if (src.isLoading) return <Skeleton className="h-64" />;
  const s = src.data;
  if (!s) return <EmptyState title={t('common.notFound')} />;
  const toggle = (itemId: string, on: boolean) => setSelected((prev) => {
    const next = new Set(prev);
    if (on) next.add(itemId);
    else next.delete(itemId);
    return next;
  });
  const Row = ({ i }: { i: SourceItemDto }) => (
    <div className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-b-0">
      <Checkbox checked={selected.has(i.id)} onCheckedChange={(v) => toggle(i.id, v)} className={selectable(i) && s.canManage ? '' : 'invisible'} />
      {i.kind === 'suite' && <Boxes className="h-4 w-4 text-accent" />}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {i.skillId ? (
            <Link to="/skills/$name" params={{ name: i.skillId }} search={{ tab: undefined }} className="font-mono text-[13px] font-medium hover:text-accent">
              {i.upstreamName}
            </Link>
          ) : (
            <code className="font-mono text-[13px] font-medium">{i.upstreamName}</code>
          )}
          <span className="truncate font-mono text-[11.5px] text-subtle">{i.upstreamPath || '/'}</span>
        </div>
        {i.description && <div className="truncate text-[12.5px] text-muted">{i.description}</div>}
        {Array.isArray(i.meta.issues) && (i.meta.issues as string[]).length > 0 && <div className="text-[12px] text-danger">{(i.meta.issues as string[])[0]}</div>}
      </div>
      {i.kind === 'suite' && Array.isArray(i.meta.skills) && <span className="text-[12px] text-subtle">{t('count.skills', { count: (i.meta.skills as string[]).length })}</span>}
      <Badge tone={i.status === 'imported' ? 'ok' : i.status === 'update_available' ? 'warn' : i.status === 'removed' ? 'danger' : 'neutral'}>{t(`sources.itemStatus.${i.status}`)}</Badge>
    </div>
  );
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-tight">{s.name}</h1>
            <Badge>{t(`sources.kind.${s.kind}`)}</Badge>
          </div>
          <div className="mt-1 font-mono text-[12.5px] text-subtle">
            {s.url}
            {s.ref ? `#${s.ref}` : ''}
          </div>
          <div className="mt-1 text-[12.5px] text-subtle">
            @{s.namespace} · {t('sources.lastSync')}: {s.lastSyncedAt ? relativeTime(s.lastSyncedAt) : t('sources.never')}
            {s.lastCommit && <> · {s.lastCommit.slice(0, 10)}</>}
          </div>
          {s.lastError && <p className="mt-2 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{s.lastError}</p>}
        </div>
        {s.canManage && (
          <div className="flex gap-2">
            {s.kind === 'upload' && (
              <label className="inline-flex h-8 cursor-pointer items-center rounded-md border border-border-strong px-3 text-[13px] hover:bg-panel-hover">
                {t('submit.upload')}
                <input type="file" accept=".zip,.tar,.gz,.tgz" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
              </label>
            )}
            <Button icon={<RefreshCw className={cn('h-3.5 w-3.5', sync.isPending && 'animate-spin')} />} disabled={sync.isPending} onClick={() => sync.mutate(undefined)}>
              {sync.isPending ? t('sources.syncing') : t('sources.sync')}
            </Button>
            <Button variant="ghost" size="icon" aria-label={t('common.delete')} onClick={() => confirm(t('common.delete') + '?') && remove.mutate(undefined)}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        )}
      </div>
      <p className="mb-3 flex items-center gap-2 text-[12.5px] text-muted">
        <CheckCircle2 className="h-4 w-4 text-ok" /> {t('sources.localCopy')}
      </p>
      {items.isLoading && <Skeleton className="h-40" />}
      {suites.length > 0 && (
        <Card className="mb-4 overflow-hidden">
          <CardHeader title={t('nav.suites')} />
          {suites.map((i) => (
            <Row key={i.id} i={i} />
          ))}
        </Card>
      )}
      <Card className="overflow-hidden">
        <CardHeader
          title={t('nav.skills')}
          description={t('count.skills', { count: skills.length })}
          actions={
            s.canManage && (
              <>
                <Button size="sm" variant="ghost" onClick={() => setSelected(new Set(skills.filter(selectable).map((i) => i.id)))}>
                  {t('sources.selectAll')}
                </Button>
                <Button size="sm" variant="primary" disabled={!selected.size} loading={importSel.isPending} onClick={() => importSel.mutate(undefined)}>
                  {importSel.isPending ? t('sources.importing') : `${t('sources.import')} (${selected.size})`}
                </Button>
              </>
            )
          }
        />
        {skills.map((i) => (
          <Row key={i.id} i={i} />
        ))}
      </Card>
    </div>
  );
}

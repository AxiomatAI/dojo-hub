import type {
  InstallCommands,
  NamespaceDto,
  Paginated,
  PolicyDocument,
  SkillSummaryDto,
  SuiteDto,
  UserSummary,
} from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Boxes, Lock, Plus, Trash2, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { InstallPanel, SkillRow, StatusPill } from '../components/dojo';
import { PolicyEditor } from '../components/policy-editor';
import { isAdmin, useMe } from '../components/shell';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Skeleton,
  Table,
  TabPanel,
  Tabs,
  Td,
  Textarea,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';

type TeamDetail = NamespaceDto & {
  catalog: {
    id: string;
    level: string;
    pinnedVersion: string | null;
    note: string | null;
    skill: SkillSummaryDto | null;
    suite: {
      id: string;
      name: string;
      displayName: string;
      namespace: string;
      status: string;
      description: string;
    } | null;
  }[];
  install: InstallCommands;
  installableCount: number;
  canManage: boolean;
  canAdmin: boolean;
};

function NewTeamDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [form, setForm] = useState({
    displayName: '',
    slug: '',
    description: '',
    visibility: 'internal',
    color: '#6366f1',
  });
  const create = useAction(() => api.post<{ slug: string }>('namespaces', form), {
    invalidate: [['namespaces'], ['me']],
    onSuccess: (r) => {
      onOpenChange(false);
      void navigate({ to: '/teams/$slug', params: { slug: r.slug }, search: { tab: undefined } });
    },
  });
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={t('teams.new')}
      footer={
        <Button
          variant="primary"
          loading={create.isPending}
          disabled={!form.displayName || !form.slug}
          onClick={() => create.mutate(undefined)}
        >
          {t('common.create')}
        </Button>
      }
    >
      <div className="space-y-3">
        <Field label={t('common.name')}>
          <Input
            autoFocus
            value={form.displayName}
            onChange={(e) =>
              setForm((f) => ({
                ...f,
                displayName: e.target.value,
                slug: f.slug && f.slug !== slugify(f.displayName) ? f.slug : slugify(e.target.value),
              }))
            }
          />
        </Field>
        <Field label={t('teams.slug')} hint={t('teams.slugHint')}>
          <Input
            value={form.slug}
            onChange={(e) => setForm({ ...form, slug: slugify(e.target.value) })}
            className="font-mono"
          />
        </Field>
        <Field label={t('common.description')}>
          <Textarea
            rows={2}
            value={form.description}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
        </Field>
        <div className="grid grid-cols-[minmax(0,1fr)_90px] gap-3">
          <Field label="Visibility" hint={t(`visibility.help.${form.visibility}`)}>
            <Select
              value={form.visibility}
              onChange={(e) => setForm({ ...form, visibility: e.target.value })}
            >
              {['internal', 'private', 'public'].map((v) => (
                <option key={v} value={v}>
                  {t(`visibility.${v}`)}
                </option>
              ))}
            </Select>
          </Field>
          <Field label={t('teams.color')}>
            <input
              type="color"
              value={form.color}
              onChange={(e) => setForm({ ...form, color: e.target.value })}
              className="h-8 w-full cursor-pointer rounded-md border border-border-strong bg-panel"
            />
          </Field>
        </div>
      </div>
    </Dialog>
  );
}

const slugify = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);

export function TeamsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const [open, setOpen] = useState(false);
  const q = useQuery({ queryKey: ['namespaces'], queryFn: () => api.get<NamespaceDto[]>('namespaces') });
  return (
    <div>
      <PageHeader
        icon={<Users className="h-4 w-4" />}
        title={t('teams.title')}
        description={t('teams.subtitle')}
        actions={
          isAdmin(me) && (
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
              {t('teams.new')}
            </Button>
          )
        }
      />
      {q.isLoading && <Skeleton className="h-40" />}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.data?.map((n) => (
          <Link key={n.id} to="/teams/$slug" params={{ slug: n.slug }} search={{ tab: undefined }}>
            <Card className="h-full p-4 transition-colors hover:border-border-strong">
              <div className="flex items-center gap-2.5">
                <span
                  className="flex h-8 w-8 items-center justify-center rounded-lg text-[13px] font-semibold text-white"
                  style={{ background: n.color ?? 'var(--accent)' }}
                >
                  {n.displayName.slice(0, 1).toUpperCase()}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5 truncate font-medium">
                    {n.displayName}
                    {n.visibility === 'private' && <Lock className="h-3 w-3 text-subtle" />}
                  </div>
                  <div className="font-mono text-[12px] text-subtle">@{n.slug}</div>
                </div>
                {n.myRole && <Badge tone="accent">{t(`roles.${n.myRole}`)}</Badge>}
              </div>
              {n.description && <p className="mt-3 line-clamp-2 text-[12.5px] text-muted">{n.description}</p>}
              <div className="mt-3 flex gap-4 text-[12px] text-subtle">
                <span>{t('count.skills', { count: n.catalogCount })}</span>
                <span>{t('count.members', { count: n.memberCount })}</span>
              </div>
            </Card>
          </Link>
        ))}
      </div>
      <NewTeamDialog open={open} onOpenChange={setOpen} />
    </div>
  );
}

function AddCatalogDialog({
  slug,
  open,
  onOpenChange,
}: {
  slug: string;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const { t } = useTranslation();
  const [q, setQ] = useState('');
  const [level, setLevel] = useState('recommended');
  const skills = useQuery({
    queryKey: ['skills', 'picker', q],
    queryFn: () =>
      api.get<Paginated<SkillSummaryDto>>(
        `skills?q=${encodeURIComponent(q)}&status=approved,deprecated&pageSize=10`,
      ),
    enabled: open,
  });
  const suites = useQuery({
    queryKey: ['suites', 'picker', q],
    queryFn: () => api.get<SuiteDto[]>(`suites?q=${encodeURIComponent(q)}`),
    enabled: open,
  });
  const add = useAction(
    (body: { skillId?: string; suiteId?: string }) =>
      api.post(`namespaces/${slug}/catalog`, { ...body, level }),
    { invalidate: [['namespace', slug]], success: t('common.done') },
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title={t('teams.addSkill')} wide>
      <div className="mb-3 flex gap-2">
        <Input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('skills.searchPlaceholder')}
        />
        <Select value={level} onChange={(e) => setLevel(e.target.value)} className="w-40">
          {['required', 'recommended', 'optional'].map((l) => (
            <option key={l} value={l}>
              {t(`level.${l}`)}
            </option>
          ))}
        </Select>
      </div>
      <div className="max-h-[50vh] divide-y divide-border overflow-y-auto rounded-lg border border-border">
        {suites.data?.slice(0, 5).map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2">
            <Boxes className="h-4 w-4 text-accent" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">{s.displayName}</div>
              <div className="truncate text-[12px] text-subtle">{s.description}</div>
            </div>
            <Button
              size="sm"
              loading={add.isPending && add.variables?.suiteId === s.id}
              onClick={() => add.mutate({ suiteId: s.id })}
            >
              {t('common.add')}
            </Button>
          </div>
        ))}
        {skills.data?.items.map((s) => (
          <div key={s.id} className="flex items-center gap-3 px-3 py-2">
            <div className="min-w-0 flex-1">
              <div className="truncate text-[13px] font-medium">
                {s.displayName} <span className="font-mono text-[11.5px] text-subtle">@{s.namespace}</span>
              </div>
              <div className="truncate text-[12px] text-subtle">{s.summary}</div>
            </div>
            <Button
              size="sm"
              loading={add.isPending && add.variables?.skillId === s.id}
              onClick={() => add.mutate({ skillId: s.id })}
            >
              {t('common.add')}
            </Button>
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function Members({ slug, canAdmin }: { slug: string; canAdmin: boolean }) {
  const { t } = useTranslation();
  const members = useQuery({
    queryKey: ['members', slug],
    queryFn: () =>
      api.get<(UserSummary & { userId: string; role: string; managed: boolean })[]>(
        `namespaces/${slug}/members`,
      ),
  });
  const [q, setQ] = useState('');
  const users = useQuery({
    queryKey: ['users', q],
    queryFn: () => api.get<UserSummary[]>(`users?q=${encodeURIComponent(q)}`),
    enabled: canAdmin && q.length > 1,
  });
  const setRole = useAction(
    (b: { userId: string; role: string }) => api.post(`namespaces/${slug}/members`, b),
    { invalidate: [['members', slug]] },
  );
  const remove = useAction((userId: string) => api.del(`namespaces/${slug}/members/${userId}`), {
    invalidate: [['members', slug]],
  });
  return (
    <Card>
      <CardHeader
        title={t('common.members')}
        actions={
          canAdmin && (
            <div className="relative">
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder={t('teams.addMember')}
                className="w-56"
              />
              {!!users.data?.length && (
                <div className="absolute right-0 z-10 mt-1 w-72 rounded-lg border border-border bg-panel p-1 shadow-float">
                  {users.data.map((u) => (
                    <button
                      type="button"
                      key={u.id}
                      className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] hover:bg-panel-hover"
                      onClick={() => {
                        setRole.mutate({ userId: u.id, role: 'member' });
                        setQ('');
                      }}
                    >
                      <Avatar name={u.name} size={20} />
                      <span className="truncate">{u.name}</span>
                      <span className="truncate text-[12px] text-subtle">{u.email}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )
        }
      />
      <Table>
        <tbody>
          {members.data?.map((m) => (
            <tr key={m.userId}>
              <Td>
                <div className="flex items-center gap-2">
                  <Avatar name={m.name} image={m.image} />
                  <span className="font-medium">{m.name}</span>
                  <span className="text-[12px] text-subtle">{m.email}</span>
                </div>
              </Td>
              <Td className="w-48">
                {canAdmin && !m.managed ? (
                  <Select
                    value={m.role}
                    onChange={(e) => setRole.mutate({ userId: m.userId, role: e.target.value })}
                  >
                    {['owner', 'maintainer', 'reviewer', 'member'].map((r) => (
                      <option key={r} value={r}>
                        {t(`roles.${r}`)}
                      </option>
                    ))}
                  </Select>
                ) : (
                  <span className="text-[12.5px]">
                    {t(`roles.${m.role}`)}{' '}
                    {m.managed && <Badge className="ml-1">{t('teams.managedByIdp')}</Badge>}
                  </span>
                )}
              </Td>
              <Td className="w-10">
                {canAdmin && !m.managed && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={t('common.remove')}
                    onClick={() => remove.mutate(m.userId)}
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

function TeamPolicy({ slug }: { slug: string }) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['policy', slug],
    queryFn: () =>
      api.get<{ inherited: boolean; document: PolicyDocument; canEdit: boolean }>(
        `namespaces/${slug}/policy`,
      ),
  });
  const save = useAction((document: PolicyDocument) => api.put(`namespaces/${slug}/policy`, { document }), {
    invalidate: [['policy', slug]],
    success: t('common.done'),
  });
  const reset = useAction(() => api.del(`namespaces/${slug}/policy`), { invalidate: [['policy', slug]] });
  if (!q.data) return <Skeleton className="h-64" />;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between rounded-lg border border-border bg-bg-subtle px-3 py-2 text-[13px]">
        <span className="text-muted">{q.data.inherited ? t('teams.inherited') : t('teams.policy')}</span>
        {!q.data.inherited && q.data.canEdit && (
          <Button size="sm" variant="ghost" onClick={() => reset.mutate(undefined)}>
            {t('teams.resetPolicy')}
          </Button>
        )}
      </div>
      <PolicyEditor
        value={q.data.document}
        onSave={(d) => save.mutate(d)}
        saving={save.isPending}
        readOnly={!q.data.canEdit}
      />
    </div>
  );
}

export function TeamDetailPage() {
  const { t } = useTranslation();
  const { slug } = useParams({ from: '/app/teams/$slug' });
  const search = useSearch({ from: '/app/teams/$slug' }) as { tab?: string };
  const navigate = useNavigate();
  const [adding, setAdding] = useState(false);
  const team = useQuery({
    queryKey: ['namespace', slug],
    queryFn: () => api.get<TeamDetail>(`namespaces/${slug}`),
  });
  const removeEntry = useAction((id: string) => api.del(`namespaces/${slug}/catalog/${id}`), {
    invalidate: [['namespace', slug]],
  });
  const setLevel = useAction(
    (b: { id: string; level: string }) => api.patch(`namespaces/${slug}/catalog/${b.id}`, { level: b.level }),
    { invalidate: [['namespace', slug]] },
  );
  if (team.isLoading) return <Skeleton className="h-64" />;
  const d = team.data;
  if (!d) return <EmptyState title={t('common.notFound')} />;
  const tab = search.tab ?? 'catalog';
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <span
          className="flex h-11 w-11 items-center justify-center rounded-xl text-lg font-semibold text-white"
          style={{ background: d.color ?? 'var(--accent)' }}
        >
          {d.displayName.slice(0, 1).toUpperCase()}
        </span>
        <div className="min-w-[16rem] flex-1">
          <div className="flex items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-tight">{d.displayName}</h1>
            <Badge>{t(`visibility.${d.visibility}`)}</Badge>
          </div>
          <div className="font-mono text-[12.5px] text-subtle">@{d.slug}</div>
          {d.description && <p className="mt-1 max-w-2xl text-muted">{d.description}</p>}
        </div>
        {d.canManage && (
          <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
            {t('teams.addSkill')}
          </Button>
        )}
      </div>
      <Tabs
        value={tab}
        onValueChange={(v) =>
          navigate({ to: '/teams/$slug', params: { slug }, search: { tab: v }, replace: true })
        }
        tabs={[
          { value: 'catalog', label: t('teams.catalog'), count: d.catalog.length },
          { value: 'members', label: t('common.members'), count: d.memberCount },
          { value: 'policy', label: t('teams.policy') },
        ]}
      >
        <TabPanel value="catalog">
          <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
            <Card className="overflow-hidden">
              {d.catalog.length === 0 && (
                <EmptyState icon={<Boxes className="h-5 w-5" />} title={t('teams.catalogEmpty')} />
              )}
              {d.catalog.map((e) =>
                e.skill ? (
                  <SkillRow
                    key={e.id}
                    skill={e.skill}
                    right={
                      d.canManage ? (
                        // biome-ignore lint/a11y/noStaticElementInteractions: stop row navigation
                        <div
                          className="flex items-center gap-1"
                          onClick={(ev) => ev.preventDefault()}
                          onKeyDown={() => {}}
                        >
                          <Select
                            value={e.level}
                            onChange={(ev) => setLevel.mutate({ id: e.id, level: ev.target.value })}
                            className="h-7 w-32 text-[12px]"
                          >
                            {['required', 'recommended', 'optional'].map((l) => (
                              <option key={l} value={l}>
                                {t(`level.${l}`)}
                              </option>
                            ))}
                          </Select>
                          <Button
                            variant="ghost"
                            size="icon"
                            aria-label={t('common.remove')}
                            onClick={() => removeEntry.mutate(e.id)}
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </Button>
                        </div>
                      ) : (
                        <Badge tone={e.level === 'required' ? 'accent' : 'neutral'}>
                          {t(`level.${e.level}`)}
                        </Badge>
                      )
                    }
                  />
                ) : e.suite ? (
                  <Link
                    key={e.id}
                    to="/suites/$ns/$name"
                    params={{ ns: e.suite.namespace, name: e.suite.name }}
                    className="flex items-center gap-3 border-b border-border px-4 py-2.5 hover:bg-panel-hover"
                  >
                    <span className="flex h-8 w-8 items-center justify-center rounded-lg border border-border bg-accent-soft text-accent">
                      <Boxes className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="font-medium">{e.suite.displayName}</div>
                      <div className="truncate text-[12.5px] text-muted">{e.suite.description}</div>
                    </div>
                    <StatusPill status={e.suite.status as never} withHelp={false} />
                    <Badge tone={e.level === 'required' ? 'accent' : 'neutral'}>
                      {t(`level.${e.level}`)}
                    </Badge>
                    {d.canManage && (
                      <Button
                        variant="ghost"
                        size="icon"
                        aria-label={t('common.remove')}
                        onClick={(ev) => {
                          ev.preventDefault();
                          removeEntry.mutate(e.id);
                        }}
                      >
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    )}
                  </Link>
                ) : null,
              )}
            </Card>
            <Card className="h-fit p-4">
              <div className="mb-1 font-semibold">{t('teams.installTeam')}</div>
              <p className="mb-3 text-[12.5px] text-muted">
                {t('count.skills', { count: d.installableCount })}
              </p>
              <InstallPanel install={d.install} />
            </Card>
          </div>
        </TabPanel>
        <TabPanel value="members">
          <Members slug={slug} canAdmin={d.canAdmin} />
        </TabPanel>
        <TabPanel value="policy">
          <TeamPolicy slug={slug} />
        </TabPanel>
      </Tabs>
      <AddCatalogDialog slug={slug} open={adding} onOpenChange={setAdding} />
    </div>
  );
}

export { Th };

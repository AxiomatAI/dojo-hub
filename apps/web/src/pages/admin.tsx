import {
  LLM_PROVIDERS,
  type NamespaceDto,
  ORG_ROLES,
  type PolicyDocument,
  WEBHOOK_EVENTS,
} from '@dojohub/contract';
import { LOCALE_LABELS, LOCALES } from '@dojohub/i18n';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { CheckCircle2, Plus, RefreshCw, Send, Shield, Trash2, UploadCloud } from 'lucide-react';
import { type ChangeEvent, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { PolicyEditor } from '../components/policy-editor';
import { isAdmin, OrgLogo, useMe } from '../components/shell';
import {
  Avatar,
  Badge,
  Button,
  Card,
  CardHeader,
  Checkbox,
  CopyField,
  Dialog,
  EmptyState,
  Field,
  Input,
  PageHeader,
  Select,
  Switch,
  Table,
  TabPanel,
  Tabs,
  Td,
  Textarea,
  Th,
} from '../components/ui';
import { api } from '../lib/api';
import { formatDateTime, relativeTime } from '../lib/format';
import { errorMessage, useAction } from '../lib/hooks';

// ───────── SSO ─────────
const PRESETS = ['entra', 'google', 'okta', 'auth0', 'keycloak', 'oidc', 'saml'] as const;
const ISSUER_HINT: Record<string, string> = {
  entra: 'https://login.microsoftonline.com/<tenant-id>/v2.0',
  google: 'https://accounts.google.com',
  okta: 'https://<your-org>.okta.com',
  auth0: 'https://<tenant>.auth0.com',
  keycloak: 'https://keycloak.example.com/realms/<realm>',
  oidc: 'https://idp.example.com',
  saml: 'https://idp.example.com/metadata',
};

export function SsoProviderForm({ onDone }: { onDone?: () => void }) {
  const { t } = useTranslation();
  const [f, setF] = useState({
    preset: 'entra',
    providerId: 'entra',
    domain: '',
    issuer: '',
    clientId: '',
    clientSecret: '',
    groupsClaim: 'groups',
    samlEntryPoint: '',
    samlCert: '',
  });
  const base = window.location.origin;
  const callback =
    f.preset === 'saml'
      ? `${base}/api/auth/sso/saml2/callback/${f.providerId}`
      : `${base}/api/auth/sso/callback/${f.providerId}`;
  const test = useAction(
    () =>
      api.post<{ issuer: string }>('admin/sso/test', {
        issuer: f.preset === 'google' ? 'https://accounts.google.com' : f.issuer,
      }),
    { success: t('admin.connectionOk') },
  );
  const save = useAction(
    () =>
      api.post('admin/sso', {
        ...f,
        issuer: f.preset === 'google' ? 'https://accounts.google.com' : f.issuer,
      }),
    {
      invalidate: [['admin-sso'], ['setup-status']],
      success: t('common.done'),
      onSuccess: () => onDone?.(),
    },
  );
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-1.5">
        {PRESETS.map((p) => (
          <button
            type="button"
            key={p}
            onClick={() =>
              setF({ ...f, preset: p, providerId: f.providerId === f.preset ? p : f.providerId })
            }
            className={`rounded-lg border px-3 py-1.5 text-[13px] ${f.preset === p ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted hover:text-fg'}`}
          >
            {p === 'entra'
              ? 'Entra ID'
              : p === 'google'
                ? 'Google'
                : p === 'oidc'
                  ? 'OIDC'
                  : p === 'saml'
                    ? 'SAML'
                    : p[0]!.toUpperCase() + p.slice(1)}
          </button>
        ))}
      </div>
      <p className="rounded-md bg-bg-subtle px-3 py-2 text-[12.5px] text-muted">
        {t(`admin.presetHelp.${f.preset}`)}
      </p>
      <CopyField label={t('admin.callbackUrl')} value={callback} />
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('admin.providerId')}>
          <Input
            value={f.providerId}
            onChange={(e) =>
              setF({ ...f, providerId: e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '') })
            }
            className="font-mono"
          />
        </Field>
        <Field label={t('admin.domain')} hint={t('admin.domainHint')}>
          <Input
            value={f.domain}
            onChange={(e) => setF({ ...f, domain: e.target.value })}
            placeholder="acme.com"
          />
        </Field>
        {f.preset !== 'google' && (
          <Field
            label={f.preset === 'saml' ? t('admin.samlIssuer') : t('admin.issuer')}
            className="md:col-span-2"
          >
            <Input
              value={f.issuer}
              onChange={(e) => setF({ ...f, issuer: e.target.value })}
              placeholder={ISSUER_HINT[f.preset]}
              className="font-mono"
            />
          </Field>
        )}
        {f.preset === 'saml' ? (
          <>
            <Field label={t('admin.samlEntryPoint')} className="md:col-span-2">
              <Input
                value={f.samlEntryPoint}
                onChange={(e) => setF({ ...f, samlEntryPoint: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label={t('admin.samlCert')} className="md:col-span-2">
              <Textarea
                rows={4}
                value={f.samlCert}
                onChange={(e) => setF({ ...f, samlCert: e.target.value })}
                className="font-mono text-[11.5px]"
              />
            </Field>
          </>
        ) : (
          <>
            <Field label={t('admin.clientId')}>
              <Input
                value={f.clientId}
                onChange={(e) => setF({ ...f, clientId: e.target.value })}
                className="font-mono"
              />
            </Field>
            <Field label={t('admin.clientSecret')}>
              <Input
                type="password"
                value={f.clientSecret}
                onChange={(e) => setF({ ...f, clientSecret: e.target.value })}
                autoComplete="off"
              />
            </Field>
          </>
        )}
        <Field label={t('admin.groupsClaim')}>
          <Input
            value={f.groupsClaim}
            onChange={(e) => setF({ ...f, groupsClaim: e.target.value })}
            className="font-mono"
          />
        </Field>
      </div>
      <div className="flex justify-end gap-2">
        {f.preset !== 'saml' && (
          <Button loading={test.isPending} onClick={() => test.mutate(undefined)}>
            {t('admin.testConnection')}
          </Button>
        )}
        <Button
          variant="primary"
          loading={save.isPending}
          disabled={!f.domain || !f.providerId}
          onClick={() => save.mutate(undefined)}
        >
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function SsoTab() {
  const { t } = useTranslation();
  const [adding, setAdding] = useState(false);
  const q = useQuery({
    queryKey: ['admin-sso'],
    queryFn: () =>
      api.get<
        {
          providerId: string;
          name: string;
          domain: string;
          type: string;
          issuer: string;
          callbackUrl: string;
          groupsClaim: string;
        }[]
      >('admin/sso'),
  });
  const del = useAction((id: string) => api.del(`admin/sso/${id}`), { invalidate: [['admin-sso']] });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('admin.ssoProviders')}
          actions={
            <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setAdding(true)}>
              {t('admin.addProvider')}
            </Button>
          }
        />
        {q.data?.length === 0 && (
          <EmptyState
            icon={<Shield className="h-5 w-5" />}
            title={t('onboarding.sso.title')}
            description={t('onboarding.sso.body')}
          />
        )}
        {q.data?.map((p) => (
          <div
            key={p.providerId}
            className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0"
          >
            <CheckCircle2 className="h-4 w-4 text-ok" />
            <div className="min-w-0 flex-1">
              <div className="font-medium">
                {p.name} <Badge>{p.type.toUpperCase()}</Badge>
              </div>
              <div className="truncate font-mono text-[12px] text-subtle">
                @{p.domain} · {p.issuer}
              </div>
            </div>
            <CopyField value={p.callbackUrl} className="hidden w-80 lg:flex" />
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common.delete')}
              onClick={() => confirm(`${t('common.delete')} ${p.name}?`) && del.mutate(p.providerId)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </Card>
      <Dialog open={adding} onOpenChange={setAdding} title={t('admin.addProvider')} wide>
        <SsoProviderForm onDone={() => setAdding(false)} />
      </Dialog>
    </div>
  );
}

// ───────── Members ─────────
function MembersTab() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['admin-members'],
    queryFn: () =>
      api.get<
        {
          id: string;
          name: string;
          email: string;
          image: string | null;
          role: string;
          managed: boolean;
          lastSeenAt: string | null;
        }[]
      >('admin/members'),
  });
  const setRole = useAction(
    (b: { id: string; role: string }) => api.patch(`admin/members/${b.id}`, { role: b.role }),
    { invalidate: [['admin-members']] },
  );
  const [open, setOpen] = useState(false);
  const [u, setU] = useState({ name: '', email: '', password: '', role: 'member' });
  const create = useAction(() => api.post('admin/users', u), {
    invalidate: [['admin-members']],
    success: t('common.done'),
    onSuccess: () => setOpen(false),
  });
  return (
    <Card>
      <CardHeader
        title={t('admin.members')}
        actions={
          <Button icon={<Plus className="h-3.5 w-3.5" />} onClick={() => setOpen(true)}>
            {t('admin.addUser')}
          </Button>
        }
      />
      <Table>
        <tbody>
          {q.data?.map((m) => (
            <tr key={m.id}>
              <Td>
                <div className="flex items-center gap-2">
                  <Avatar name={m.name} image={m.image} />
                  <span className="font-medium">{m.name}</span>
                  <span className="text-[12px] text-subtle">{m.email}</span>
                </div>
              </Td>
              <Td className="text-[12.5px] text-subtle">{relativeTime(m.lastSeenAt)}</Td>
              <Td className="w-56">
                <Select value={m.role} onChange={(e) => setRole.mutate({ id: m.id, role: e.target.value })}>
                  {ORG_ROLES.map((r) => (
                    <option key={r} value={r}>
                      {t(`roles.${r}`)}
                    </option>
                  ))}
                </Select>
              </Td>
              <Td className="w-32">{m.managed && <Badge>{t('teams.managedByIdp')}</Badge>}</Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('admin.addUser')}
        footer={
          <Button variant="primary" loading={create.isPending} onClick={() => create.mutate(undefined)}>
            {t('common.create')}
          </Button>
        }
      >
        <div className="space-y-3">
          <Field label={t('setup.fullName')}>
            <Input value={u.name} onChange={(e) => setU({ ...u, name: e.target.value })} />
          </Field>
          <Field label={t('common.email')}>
            <Input type="email" value={u.email} onChange={(e) => setU({ ...u, email: e.target.value })} />
          </Field>
          <Field label={t('common.password')} hint={t('setup.passwordHint')}>
            <Input
              type="password"
              value={u.password}
              onChange={(e) => setU({ ...u, password: e.target.value })}
              autoComplete="new-password"
            />
          </Field>
          <Field label={t('common.role')}>
            <Select value={u.role} onChange={(e) => setU({ ...u, role: e.target.value })}>
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </Select>
          </Field>
        </div>
      </Dialog>
    </Card>
  );
}

// ───────── Access: groups, mappings, SCIM, directory sync ─────────
function AccessTab() {
  const { t } = useTranslation();
  const groups = useQuery({
    queryKey: ['admin-groups'],
    queryFn: () =>
      api.get<{ id: string; externalId: string; displayName: string; source: string; members: number }[]>(
        'admin/groups',
      ),
  });
  const mappings = useQuery({
    queryKey: ['admin-mappings'],
    queryFn: () =>
      api.get<
        {
          id: string;
          group: string;
          externalId: string;
          namespace: string | null;
          orgRole: string | null;
          namespaceRole: string | null;
        }[]
      >('admin/group-mappings'),
  });
  const teams = useQuery({ queryKey: ['namespaces'], queryFn: () => api.get<NamespaceDto[]>('namespaces') });
  const scim = useQuery({
    queryKey: ['admin-scim'],
    queryFn: () =>
      api.get<{ endpoint: string; tokens: { id: string; name: string; lastUsedAt: string | null }[] }>(
        'admin/scim-tokens',
      ),
  });
  const dirs = useQuery({
    queryKey: ['admin-dirsync'],
    queryFn: () =>
      api.get<{ id: string; kind: string; lastRunAt: string | null; lastStatus: string | null }[]>(
        'admin/directory-sync',
      ),
  });
  const [m, setM] = useState({ groupId: '', namespaceId: '', orgRole: 'member', namespaceRole: 'member' });
  const [g, setG] = useState({ externalId: '', displayName: '' });
  const [scimToken, setScimToken] = useState<string | null>(null);
  const [dir, setDir] = useState<{ kind: string; [k: string]: string }>({
    kind: 'microsoft_graph',
    tenantId: '',
    clientId: '',
    clientSecret: '',
  });
  const addGroup = useAction(() => api.post('admin/groups', g), {
    invalidate: [['admin-groups']],
    onSuccess: () => setG({ externalId: '', displayName: '' }),
  });
  const addMapping = useAction(
    () =>
      api.post(
        'admin/group-mappings',
        m.namespaceId
          ? { groupId: m.groupId, namespaceId: m.namespaceId, namespaceRole: m.namespaceRole }
          : { groupId: m.groupId, orgRole: m.orgRole },
      ),
    { invalidate: [['admin-mappings']], success: t('common.done') },
  );
  const delMapping = useAction((id: string) => api.del(`admin/group-mappings/${id}`), {
    invalidate: [['admin-mappings']],
  });
  const newScim = useAction(
    () =>
      api.post<{ token: string }>('admin/scim-tokens', {
        name: `SCIM ${new Date().toISOString().slice(0, 10)}`,
      }),
    { invalidate: [['admin-scim']], onSuccess: (r) => setScimToken(r.token) },
  );
  const revokeScim = useAction((id: string) => api.del(`admin/scim-tokens/${id}`), {
    invalidate: [['admin-scim']],
  });
  const addDir = useAction(() => api.post('admin/directory-sync', dir), {
    invalidate: [['admin-dirsync']],
    success: t('common.done'),
  });
  const runDir = useAction((id: string) => api.post(`admin/directory-sync/${id}/run`), {
    invalidate: [['admin-dirsync']],
    success: t('common.done'),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('admin.groupMappings')} />
        <div className="grid gap-2 border-b border-border p-4 md:grid-cols-[minmax(0,1fr)_1fr_1fr_auto]">
          <Select
            value={m.groupId}
            onChange={(e) => setM({ ...m, groupId: e.target.value })}
            aria-label={t('admin.groups')}
          >
            <option value="">{t('admin.groups')}…</option>
            {groups.data?.map((x) => (
              <option key={x.id} value={x.id}>
                {x.displayName}
              </option>
            ))}
          </Select>
          <Select
            value={m.namespaceId}
            onChange={(e) => setM({ ...m, namespaceId: e.target.value })}
            aria-label={t('common.team')}
          >
            <option value="">{t('admin.orgRole')}</option>
            {teams.data?.map((n) => (
              <option key={n.id} value={n.id}>
                @{n.slug}
              </option>
            ))}
          </Select>
          {m.namespaceId ? (
            <Select
              value={m.namespaceRole}
              onChange={(e) => setM({ ...m, namespaceRole: e.target.value })}
              aria-label={t('admin.teamRole')}
            >
              {['owner', 'maintainer', 'reviewer', 'member'].map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </Select>
          ) : (
            <Select
              value={m.orgRole}
              onChange={(e) => setM({ ...m, orgRole: e.target.value })}
              aria-label={t('admin.orgRole')}
            >
              {ORG_ROLES.map((r) => (
                <option key={r} value={r}>
                  {t(`roles.${r}`)}
                </option>
              ))}
            </Select>
          )}
          <Button
            variant="primary"
            disabled={!m.groupId}
            loading={addMapping.isPending}
            onClick={() => addMapping.mutate(undefined)}
          >
            {t('admin.addMapping')}
          </Button>
        </div>
        {mappings.data?.map((x) => (
          <div
            key={x.id}
            className="flex items-center gap-3 border-b border-border px-4 py-2 text-[13px] last:border-b-0"
          >
            <span className="font-medium">{x.group}</span>
            <span className="text-subtle">→</span>
            {x.namespace ? <Badge>@{x.namespace}</Badge> : <Badge tone="accent">org</Badge>}
            <span>{t(`roles.${x.namespaceRole ?? x.orgRole}`)}</span>
            <Button
              variant="ghost"
              size="icon"
              className="ml-auto"
              aria-label={t('common.delete')}
              onClick={() => delMapping.mutate(x.id)}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          </div>
        ))}
      </Card>
      <Card>
        <CardHeader title={t('admin.groups')} />
        <div className="flex gap-2 border-b border-border p-4">
          <Input
            value={g.externalId}
            onChange={(e) => setG({ ...g, externalId: e.target.value })}
            placeholder={t('admin.externalId')}
            className="font-mono"
          />
          <Input
            value={g.displayName}
            onChange={(e) => setG({ ...g, displayName: e.target.value })}
            placeholder={t('common.name')}
          />
          <Button disabled={!g.externalId} onClick={() => addGroup.mutate(undefined)}>
            {t('admin.registerGroup')}
          </Button>
        </div>
        <div className="max-h-72 overflow-y-auto">
          {groups.data?.map((x) => (
            <div
              key={x.id}
              className="flex items-center gap-3 border-b border-border px-4 py-1.5 text-[13px] last:border-b-0"
            >
              <span className="font-medium">{x.displayName}</span>
              <code className="truncate font-mono text-[11.5px] text-subtle">{x.externalId}</code>
              <Badge className="ml-auto">{x.source}</Badge>
              <span className="w-24 text-right text-[12px] text-subtle">
                {t('count.members', { count: x.members })}
              </span>
            </div>
          ))}
        </div>
      </Card>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader
            title={t('admin.scim')}
            description={t('admin.scimBody')}
            actions={
              <Button size="sm" onClick={() => newScim.mutate(undefined)}>
                {t('admin.newScimToken')}
              </Button>
            }
          />
          <div className="space-y-2 p-4">
            {scim.data && <CopyField label={t('admin.scimEndpoint')} value={scim.data.endpoint} />}
            {scimToken && <CopyField label="token" value={scimToken} />}
            {scim.data?.tokens.map((tk) => (
              <div key={tk.id} className="flex items-center gap-2 text-[13px]">
                <span>{tk.name}</span>
                <span className="text-[12px] text-subtle">{relativeTime(tk.lastUsedAt)}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  onClick={() => revokeScim.mutate(tk.id)}
                >
                  {t('settings.revoke')}
                </Button>
              </div>
            ))}
          </div>
        </Card>
        <Card>
          <CardHeader title={t('admin.directorySync')} description={t('admin.directorySyncBody')} />
          <div className="space-y-2 p-4">
            {dirs.data?.map((d) => (
              <div key={d.id} className="flex items-center gap-2 text-[13px]">
                <Badge>{d.kind}</Badge>
                <span className="truncate text-[12px] text-subtle">{d.lastStatus ?? '—'}</span>
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto"
                  icon={<RefreshCw className="h-3.5 w-3.5" />}
                  onClick={() => runDir.mutate(d.id)}
                >
                  {t('admin.runNow')}
                </Button>
              </div>
            ))}
            <Select value={dir.kind} onChange={(e) => setDir({ kind: e.target.value })}>
              <option value="microsoft_graph">Microsoft Graph (Entra ID)</option>
              <option value="google_directory">Google Workspace Directory</option>
            </Select>
            {dir.kind === 'microsoft_graph' ? (
              <>
                <Input
                  placeholder="Tenant ID"
                  value={dir.tenantId ?? ''}
                  onChange={(e) => setDir({ ...dir, tenantId: e.target.value })}
                />
                <Input
                  placeholder={t('admin.clientId')}
                  value={dir.clientId ?? ''}
                  onChange={(e) => setDir({ ...dir, clientId: e.target.value })}
                />
                <Input
                  type="password"
                  placeholder={t('admin.clientSecret')}
                  value={dir.clientSecret ?? ''}
                  onChange={(e) => setDir({ ...dir, clientSecret: e.target.value })}
                />
              </>
            ) : (
              <>
                <Input
                  placeholder="admin@acme.com"
                  value={dir.adminEmail ?? ''}
                  onChange={(e) => setDir({ ...dir, adminEmail: e.target.value })}
                />
                <Input
                  placeholder="acme.com"
                  value={dir.domain ?? ''}
                  onChange={(e) => setDir({ ...dir, domain: e.target.value })}
                />
                <Textarea
                  placeholder="Service account JSON"
                  rows={3}
                  value={dir.serviceAccountJson ?? ''}
                  onChange={(e) => setDir({ ...dir, serviceAccountJson: e.target.value })}
                  className="font-mono text-[11px]"
                />
              </>
            )}
            <Button
              variant="primary"
              className="w-full"
              loading={addDir.isPending}
              onClick={() => addDir.mutate(undefined)}
            >
              {t('common.save')}
            </Button>
          </div>
        </Card>
      </div>
    </div>
  );
}

// ───────── Verification: LLM, decision model, rules ─────────
const MODEL_HINT: Record<string, string> = {
  anthropic: 'claude-sonnet-5-5',
  openai: 'gpt-4.1',
  azure: '<deployment-name>',
  bedrock: '<bedrock-model-id>',
  google: 'gemini-2.5-pro',
  'openai-compatible': 'llama3.3:70b',
};

export function LlmForm({
  purpose = 'judge',
  onDone,
}: {
  purpose?: 'judge' | 'embedding';
  onDone?: () => void;
}) {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['admin-llm'],
    queryFn: () =>
      api.get<
        {
          purpose: string;
          provider: string;
          model: string;
          baseUrl: string | null;
          hasKey: boolean;
          options: Record<string, unknown>;
          enabled: boolean;
        }[]
      >('admin/llm'),
  });
  const existing = q.data?.find((x) => x.purpose === purpose);
  const [f, setF] = useState<{
    provider: string;
    model: string;
    baseUrl: string;
    apiKey: string;
    consensus: string;
    language: string;
    enabled: boolean;
  } | null>(null);
  const v = f ?? {
    provider: existing?.provider ?? (purpose === 'embedding' ? 'openai' : 'anthropic'),
    model: existing?.model ?? (purpose === 'embedding' ? 'text-embedding-3-small' : 'claude-sonnet-5-5'),
    baseUrl: existing?.baseUrl ?? '',
    apiKey: '',
    consensus: String(existing?.options.consensus ?? 1),
    language: String(existing?.options.language ?? 'pl'),
    enabled: existing?.enabled ?? true,
  };
  const set = (patch: Partial<typeof v>) => setF({ ...v, ...patch });
  const save = useAction(
    () =>
      api.put('admin/llm', {
        purpose,
        provider: v.provider,
        model: v.model,
        baseUrl: v.baseUrl || undefined,
        apiKey: v.apiKey || undefined,
        options: { consensus: Number(v.consensus), ...(purpose === 'judge' ? { language: v.language } : {}) },
        enabled: v.enabled,
      }),
    { invalidate: [['admin-llm'], ['setup-status']], success: t('common.done'), onSuccess: () => onDone?.() },
  );
  const [testResult, setTestResult] = useState<string | null>(null);
  const test = async () => {
    setTestResult('…');
    try {
      const r = await api.post<{ ok: boolean; reply?: string; error?: string; latencyMs: number }>(
        'admin/llm/test',
      );
      setTestResult(r.ok ? `✓ "${r.reply}" (${r.latencyMs} ms)` : `✗ ${r.error}`);
    } catch (err) {
      setTestResult(`✗ ${errorMessage(err)}`);
    }
  };
  return (
    <div className="space-y-3">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label={t('admin.provider')}>
          <Select
            value={v.provider}
            onChange={(e) => set({ provider: e.target.value, model: MODEL_HINT[e.target.value] ?? '' })}
          >
            {LLM_PROVIDERS.filter((p) => purpose === 'judge' || p !== 'anthropic').map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </Select>
        </Field>
        <Field label={t('admin.model')}>
          <Input
            value={v.model}
            onChange={(e) => set({ model: e.target.value })}
            placeholder={MODEL_HINT[v.provider]}
            className="font-mono"
          />
        </Field>
        <Field label={t('admin.apiKey')} hint={existing?.hasKey ? t('admin.apiKeySet') : undefined}>
          <Input
            type="password"
            value={v.apiKey}
            onChange={(e) => set({ apiKey: e.target.value })}
            autoComplete="off"
          />
        </Field>
        <Field label={t('admin.baseUrl')} hint={t('common.optional')}>
          <Input
            value={v.baseUrl}
            onChange={(e) => set({ baseUrl: e.target.value })}
            placeholder={v.provider === 'openai-compatible' ? 'http://ollama:11434/v1' : ''}
            className="font-mono"
          />
        </Field>
        {purpose === 'judge' && (
          <>
            <Field label={t('admin.consensus')}>
              <Select value={v.consensus} onChange={(e) => set({ consensus: e.target.value })}>
                {['1', '2', '3'].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label={t('admin.reportLanguage')}>
              <Select value={v.language} onChange={(e) => set({ language: e.target.value })}>
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_LABELS[l]}
                  </option>
                ))}
              </Select>
            </Field>
          </>
        )}
        <div className="flex items-end">
          <Switch
            checked={v.enabled}
            onCheckedChange={(enabled) => set({ enabled })}
            label={t('common.enabled')}
          />
        </div>
      </div>
      <div className="flex items-center justify-end gap-2">
        {testResult && <span className="mr-auto truncate text-[12.5px] text-muted">{testResult}</span>}
        {purpose === 'judge' && existing && (
          <Button icon={<Send className="h-3.5 w-3.5" />} onClick={test}>
            {t('admin.testPrompt')}
          </Button>
        )}
        <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
          {t('common.save')}
        </Button>
      </div>
    </div>
  );
}

function VerificationTab() {
  const { t } = useTranslation();
  const dm = useQuery({
    queryKey: ['admin-dm'],
    queryFn: () =>
      api.get<{
        name: string;
        url: string;
        hasSecret: boolean;
        timeoutMs: number;
        onError: string;
        enabled: boolean;
      } | null>('admin/decision-model'),
  });
  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api.get<{ anonymousInternal: boolean; securityRules: string }>('admin/settings'),
  });
  const [d, setD] = useState<{
    name: string;
    url: string;
    secret: string;
    timeoutMs: number;
    onError: string;
    enabled: boolean;
  } | null>(null);
  const dv = d ?? {
    name: dm.data?.name ?? 'Decision model',
    url: dm.data?.url ?? '',
    secret: '',
    timeoutMs: dm.data?.timeoutMs ?? 15000,
    onError: dm.data?.onError ?? 'review',
    enabled: dm.data?.enabled ?? true,
  };
  const saveDm = useAction(() => api.put('admin/decision-model', { ...dv, secret: dv.secret || undefined }), {
    invalidate: [['admin-dm']],
    success: t('common.done'),
  });
  const [rules, setRules] = useState<string | null>(null);
  const saveRules = useAction(() => api.put('admin/settings', { securityRules: rules ?? '' }), {
    invalidate: [['admin-settings']],
    success: t('common.done'),
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title={t('admin.llm')} description={t('admin.llmBody')} />
        <div className="p-4">
          <LlmForm purpose="judge" />
        </div>
      </Card>
      <Card>
        <CardHeader title={t('admin.embedding')} />
        <div className="p-4">
          <LlmForm purpose="embedding" />
        </div>
      </Card>
      <Card>
        <CardHeader title={t('admin.decisionModel')} description={t('admin.decisionModelBody')} />
        <div className="grid gap-3 p-4 md:grid-cols-2">
          <Field label="URL" className="md:col-span-2">
            <Input
              value={dv.url}
              onChange={(e) => setD({ ...dv, url: e.target.value })}
              placeholder="https://decide.internal/v1/skills"
              className="font-mono"
            />
          </Field>
          <Field label={t('admin.secret')} hint={dm.data?.hasSecret ? t('admin.apiKeySet') : undefined}>
            <Input
              type="password"
              value={dv.secret}
              onChange={(e) => setD({ ...dv, secret: e.target.value })}
            />
          </Field>
          <Field label={t('admin.timeout')}>
            <Input
              type="number"
              value={dv.timeoutMs}
              onChange={(e) => setD({ ...dv, timeoutMs: Number(e.target.value) })}
            />
          </Field>
          <Field label={t('admin.onError')}>
            <Select value={dv.onError} onChange={(e) => setD({ ...dv, onError: e.target.value })}>
              <option value="review">{t('admin.onErrorReview')}</option>
              <option value="ignore">{t('admin.onErrorIgnore')}</option>
            </Select>
          </Field>
          <div className="flex items-end justify-between gap-2">
            <Switch
              checked={dv.enabled}
              onCheckedChange={(enabled) => setD({ ...dv, enabled })}
              label={t('common.enabled')}
            />
            <Button
              variant="primary"
              disabled={!dv.url}
              loading={saveDm.isPending}
              onClick={() => saveDm.mutate(undefined)}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Card>
      <Card>
        <CardHeader title={t('admin.rules')} description={t('admin.rulesBody')} />
        <div className="space-y-2 p-4">
          <Textarea
            rows={8}
            className="font-mono text-[12px]"
            value={rules ?? settings.data?.securityRules ?? ''}
            onChange={(e) => setRules(e.target.value)}
            placeholder={
              '- id: custom.internal_hosts\n  category: network\n  severity: medium\n  message: Calls an internal-only host\n  pattern: "corp-internal\\\\.example\\\\.com"'
            }
          />
          <div className="flex justify-end">
            <Button
              variant="primary"
              loading={saveRules.isPending}
              onClick={() => saveRules.mutate(undefined)}
            >
              {t('common.save')}
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
}

// ───────── General / policies / webhooks / audit ─────────

const ICON_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/svg+xml'];
const MAX_ICON_BYTES = 2 * 1024 * 1024;

/** Client-side pre-checks mirroring the server rules (the server remains the source of truth). */
async function checkIconFile(file: File, t: (k: string) => string): Promise<void> {
  if (!ICON_TYPES.includes(file.type)) throw new Error(t('admin.orgIconBadType'));
  if (file.size > MAX_ICON_BYTES) throw new Error(t('admin.orgIconTooLarge'));
  const dims = await new Promise<{ w: number; h: number } | null>((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ w: img.naturalWidth, h: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null); // e.g. SVG without intrinsic size — let the server judge
    };
    img.src = url;
  });
  if (dims && dims.w > 0 && dims.h > 0) {
    const ratio = dims.w / dims.h;
    if (ratio < 0.5 || ratio > 2) throw new Error(t('admin.orgIconBadRatio'));
  }
}

function GeneralTab() {
  const { t } = useTranslation();
  const me = useMe();
  const settings = useQuery({
    queryKey: ['admin-settings'],
    queryFn: () => api.get<{ anonymousInternal: boolean }>('admin/settings'),
  });
  const [name, setName] = useState(me.orgName);
  const rename = useAction(() => api.patch('admin/org', { name }), {
    invalidate: [['me']],
    success: t('common.done'),
  });
  const toggle = useAction((v: boolean) => api.put('admin/settings', { anonymousInternal: v }), {
    invalidate: [['admin-settings']],
  });
  const fileInput = useRef<HTMLInputElement>(null);
  const uploadIcon = useAction(
    async (file: File) => {
      await checkIconFile(file, t);
      return api.put<{ ok: boolean; iconUrl: string }>('admin/org/icon', file, {
        'content-type': file.type || 'application/octet-stream',
      });
    },
    { invalidate: [['me']], success: t('admin.orgIconUpdated') },
  );
  const removeIcon = useAction(() => api.del('admin/org/icon'), {
    invalidate: [['me']],
    success: t('common.done'),
  });
  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (file) uploadIcon.mutate(file);
  };
  return (
    <Card className="max-w-2xl space-y-4 p-5">
      <Field label={t('admin.orgIcon')} hint={t('admin.orgIconHelp')}>
        <div className="flex items-center gap-3">
          <OrgLogo iconUrl={me.orgIconUrl} className="h-12 w-12" />
          <input
            ref={fileInput}
            type="file"
            accept={ICON_TYPES.join(',')}
            className="hidden"
            onChange={onPick}
          />
          <Button
            icon={<UploadCloud className="h-4 w-4" />}
            loading={uploadIcon.isPending}
            onClick={() => fileInput.current?.click()}
          >
            {t('admin.orgIconUpload')}
          </Button>
          {me.orgIconUrl && (
            <Button
              variant="ghost"
              loading={removeIcon.isPending}
              onClick={() => removeIcon.mutate(undefined)}
            >
              {t('common.remove')}
            </Button>
          )}
        </div>
      </Field>
      <Field label={t('admin.orgName')}>
        <div className="flex gap-2">
          <Input value={name} onChange={(e) => setName(e.target.value)} />
          <Button onClick={() => rename.mutate(undefined)} loading={rename.isPending}>
            {t('common.save')}
          </Button>
        </div>
      </Field>
      {settings.data && (
        <Switch
          checked={settings.data.anonymousInternal}
          onCheckedChange={(v) => toggle.mutate(v)}
          label={t('admin.anonymousInternal')}
          description={t('admin.anonymousInternalHelp')}
        />
      )}
    </Card>
  );
}

function PoliciesTab() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['admin-policy'],
    queryFn: () => api.get<{ document: PolicyDocument }>('admin/policy'),
  });
  const save = useAction((document: PolicyDocument) => api.put('admin/policy', { document }), {
    invalidate: [['admin-policy']],
    success: t('common.done'),
  });
  return (
    <div>
      <h2 className="mb-3 font-semibold">{t('admin.orgPolicy')}</h2>
      {q.data && (
        <PolicyEditor value={q.data.document} onSave={(d) => save.mutate(d)} saving={save.isPending} />
      )}
    </div>
  );
}

function WebhooksTab() {
  const { t } = useTranslation();
  const hooks = useQuery({
    queryKey: ['admin-webhooks'],
    queryFn: () =>
      api.get<{ id: string; name: string; url: string; events: string[]; format: string; active: boolean }[]>(
        'admin/webhooks',
      ),
  });
  const [open, setOpen] = useState(false);
  const [secret, setSecret] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [f, setF] = useState({
    name: '',
    url: '',
    events: ['version.published', 'version.blocked', 'review.requested'] as string[],
    format: 'json',
  });
  const create = useAction(() => api.post<{ secret: string }>('admin/webhooks', f), {
    invalidate: [['admin-webhooks']],
    onSuccess: (r) => setSecret(r.secret),
  });
  const del = useAction((id: string) => api.del(`admin/webhooks/${id}`), {
    invalidate: [['admin-webhooks']],
  });
  const test = useAction(
    (id: string) => api.post<{ status: string; responseStatus: number | null }>(`admin/webhooks/${id}/test`),
    {
      invalidate: [['deliveries']],
      onSuccess: (r) =>
        r.status === 'success'
          ? toast.success(`HTTP ${r.responseStatus}`)
          : toast.error(`HTTP ${r.responseStatus ?? 'error'}`),
    },
  );
  const deliveries = useQuery({
    queryKey: ['deliveries', selected],
    queryFn: () =>
      api.get<
        {
          id: string;
          event: string;
          status: string;
          attempts: number;
          responseStatus: number | null;
          createdAt: string;
        }[]
      >(`admin/webhooks/${selected}/deliveries`),
    enabled: !!selected,
  });
  const redeliver = useAction((id: string) => api.post(`admin/deliveries/${id}/redeliver`), {
    invalidate: [['deliveries']],
  });
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader
          title={t('admin.webhooks')}
          actions={
            <Button
              variant="primary"
              icon={<Plus className="h-3.5 w-3.5" />}
              onClick={() => {
                setSecret(null);
                setOpen(true);
              }}
            >
              {t('admin.newWebhook')}
            </Button>
          }
        />
        {hooks.data?.map((h) => (
          <div
            key={h.id}
            className={`flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 ${selected === h.id ? 'bg-panel-hover' : ''}`}
          >
            <button type="button" className="min-w-0 flex-1 text-left" onClick={() => setSelected(h.id)}>
              <div className="font-medium">
                {h.name} <Badge>{h.format}</Badge>
              </div>
              <div className="truncate font-mono text-[12px] text-subtle">{h.url}</div>
            </button>
            <span className="hidden text-[12px] text-subtle md:inline">{h.events.length} events</span>
            <Button
              size="sm"
              onClick={() => test.mutate(h.id)}
              loading={test.isPending && test.variables === h.id}
            >
              {t('admin.sendTest')}
            </Button>
            <Button
              variant="ghost"
              size="icon"
              aria-label={t('common.delete')}
              onClick={() => del.mutate(h.id)}
            >
              <Trash2 className="h-4 w-4" />
            </Button>
          </div>
        ))}
      </Card>
      {selected && (
        <Card>
          <CardHeader title={t('admin.deliveries')} />
          <Table>
            <tbody>
              {deliveries.data?.map((d) => (
                <tr key={d.id}>
                  <Td>
                    <code className="font-mono text-[12px]">{d.event}</code>
                  </Td>
                  <Td>
                    <Badge
                      tone={d.status === 'success' ? 'ok' : d.status === 'failed' ? 'danger' : 'neutral'}
                    >
                      {d.status} {d.responseStatus ?? ''}
                    </Badge>
                  </Td>
                  <Td className="text-[12px] text-subtle">×{d.attempts}</Td>
                  <Td className="text-[12px] text-subtle">{formatDateTime(d.createdAt)}</Td>
                  <Td className="text-right">
                    <Button size="sm" variant="ghost" onClick={() => redeliver.mutate(d.id)}>
                      {t('admin.redeliver')}
                    </Button>
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </Card>
      )}
      <Dialog
        open={open}
        onOpenChange={setOpen}
        wide
        title={t('admin.newWebhook')}
        footer={
          secret ? (
            <Button onClick={() => setOpen(false)}>{t('common.done')}</Button>
          ) : (
            <Button
              variant="primary"
              disabled={!f.name || !f.url || !f.events.length}
              loading={create.isPending}
              onClick={() => create.mutate(undefined)}
            >
              {t('common.create')}
            </Button>
          )
        }
      >
        {secret ? (
          <div className="space-y-2">
            <p className="text-[13px] text-warn">{t('admin.secretCreated')}</p>
            <CopyField value={secret} />
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_140px]">
              <Field label={t('common.name')}>
                <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
              </Field>
              <Field label={t('admin.format')}>
                <Select value={f.format} onChange={(e) => setF({ ...f, format: e.target.value })}>
                  <option value="json">JSON</option>
                  <option value="slack">Slack</option>
                  <option value="teams">Microsoft Teams</option>
                </Select>
              </Field>
            </div>
            <Field label="URL">
              <Input
                value={f.url}
                onChange={(e) => setF({ ...f, url: e.target.value })}
                placeholder="https://hooks.example.com/dojohub"
                className="font-mono"
              />
            </Field>
            <Field label={t('admin.events')}>
              <div className="grid gap-1.5 sm:grid-cols-2">
                {WEBHOOK_EVENTS.map((ev) => (
                  // biome-ignore lint/a11y/noLabelWithoutControl: checkbox inside
                  <label key={ev} className="flex items-center gap-2 text-[12.5px]">
                    <Checkbox
                      checked={f.events.includes(ev)}
                      onCheckedChange={(on) =>
                        setF({ ...f, events: on ? [...f.events, ev] : f.events.filter((x) => x !== ev) })
                      }
                    />
                    <code className="font-mono">{ev}</code>
                  </label>
                ))}
              </div>
            </Field>
          </div>
        )}
      </Dialog>
    </div>
  );
}

function AuditTab() {
  const { t } = useTranslation();
  const q = useQuery({
    queryKey: ['audit'],
    queryFn: () =>
      api.get<
        {
          id: number;
          actor: { name: string } | null;
          actorType: string;
          action: string;
          targetType: string | null;
          targetId: string | null;
          metadata: Record<string, unknown>;
          createdAt: string;
        }[]
      >('admin/audit?limit=200'),
  });
  return (
    <Card className="overflow-hidden">
      {q.data?.length === 0 && <EmptyState title={t('admin.auditEmpty')} />}
      <Table>
        <thead>
          <tr>
            <Th>{t('admin.when')}</Th>
            <Th>{t('admin.actor')}</Th>
            <Th>{t('admin.action')}</Th>
            <Th>{t('admin.target')}</Th>
          </tr>
        </thead>
        <tbody>
          {q.data?.map((e) => (
            <tr key={e.id}>
              <Td className="whitespace-nowrap text-[12px] text-subtle">{formatDateTime(e.createdAt)}</Td>
              <Td className="text-[12.5px]">{e.actor?.name ?? e.actorType}</Td>
              <Td>
                <code className="font-mono text-[12px]">{e.action}</code>
              </Td>
              <Td className="max-w-md truncate font-mono text-[11.5px] text-subtle">
                {e.targetType ? `${e.targetType}:${e.targetId?.slice(0, 8)}` : ''}{' '}
                {Object.keys(e.metadata).length ? JSON.stringify(e.metadata).slice(0, 120) : ''}
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
    </Card>
  );
}

export function AdminPage() {
  const { t } = useTranslation();
  const me = useMe();
  const search = useSearch({ from: '/app/admin' }) as { tab?: string };
  const navigate = useNavigate();
  const admin = isAdmin(me);
  const tab = search.tab ?? (admin ? 'general' : 'audit');
  const tabs = admin
    ? ['general', 'members', 'sso', 'access', 'verification', 'policies', 'webhooks', 'audit']
    : ['audit'];
  return (
    <div>
      <PageHeader icon={<Shield className="h-4 w-4" />} title={t('admin.title')} />
      <Tabs
        value={tab}
        onValueChange={(v) => navigate({ to: '/admin', search: { tab: v }, replace: true })}
        tabs={tabs.map((x) => ({ value: x, label: t(`admin.${x}`) }))}
      >
        {admin && (
          <>
            <TabPanel value="general">
              <GeneralTab />
            </TabPanel>
            <TabPanel value="members">
              <MembersTab />
            </TabPanel>
            <TabPanel value="sso">
              <SsoTab />
            </TabPanel>
            <TabPanel value="access">
              <AccessTab />
            </TabPanel>
            <TabPanel value="verification">
              <VerificationTab />
            </TabPanel>
            <TabPanel value="policies">
              <PoliciesTab />
            </TabPanel>
            <TabPanel value="webhooks">
              <WebhooksTab />
            </TabPanel>
          </>
        )}
        <TabPanel value="audit">
          <AuditTab />
        </TabPanel>
      </Tabs>
    </div>
  );
}

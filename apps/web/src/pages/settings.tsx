import { PAT_SCOPES, type TokenDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { KeyRound, Plus, Settings } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../components/shell';
import { Avatar, Badge, Button, Card, CardHeader, CopyField, Dialog, Field, Input, PageHeader, Select, Table, TabPanel, Tabs, Td, Th } from '../components/ui';
import { api } from '../lib/api';
import { formatDate, relativeTime } from '../lib/format';
import { useAction } from '../lib/hooks';

function Tokens() {
  const { t } = useTranslation();
  const me = useMe();
  const q = useQuery({ queryKey: ['tokens'], queryFn: () => api.get<TokenDto[]>('tokens') });
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<string[]>(['read', 'install', 'submit']);
  const [days, setDays] = useState('90');
  const [created, setCreated] = useState<string | null>(null);
  const create = useAction(() => api.post<{ token: string }>('tokens', { name, scopes, expiresInDays: days === 'never' ? null : Number(days) }), {
    invalidate: [['tokens']],
    onSuccess: (r) => setCreated(r.token),
  });
  const revoke = useAction((id: string) => api.del(`tokens/${id}`), { invalidate: [['tokens']] });
  const allowed = PAT_SCOPES.filter((s) => s !== 'admin' || me.permissions.includes('org.admin'));
  return (
    <Card>
      <CardHeader
        title={t('settings.tokens')}
        description={t('settings.tokensBody')}
        actions={
          <Button
            variant="primary"
            icon={<Plus className="h-3.5 w-3.5" />}
            onClick={() => {
              setCreated(null);
              setName('');
              setOpen(true);
            }}
          >
            {t('settings.newToken')}
          </Button>
        }
      />
      <Table>
        <thead>
          <tr>
            <Th>{t('common.name')}</Th>
            <Th>{t('settings.scopes')}</Th>
            <Th>{t('settings.lastUsed')}</Th>
            <Th>{t('settings.expires')}</Th>
            <Th />
          </tr>
        </thead>
        <tbody>
          {q.data?.map((tk) => (
            <tr key={tk.id}>
              <Td>
                <div className="flex items-center gap-2">
                  <KeyRound className="h-3.5 w-3.5 text-subtle" />
                  <span className="font-medium">{tk.name}</span>
                  <code className="font-mono text-[11.5px] text-subtle">{tk.prefix}…</code>
                  {tk.kind === 'cli' && <Badge>CLI</Badge>}
                </div>
              </Td>
              <Td>
                <div className="flex flex-wrap gap-1">
                  {tk.scopes.map((s) => (
                    <Badge key={s}>{t(`settings.scope.${s}`)}</Badge>
                  ))}
                </div>
              </Td>
              <Td className="text-[12.5px] text-muted">{relativeTime(tk.lastUsedAt)}</Td>
              <Td className="text-[12.5px] text-muted">{tk.expiresAt ? formatDate(tk.expiresAt) : t('settings.noExpiry')}</Td>
              <Td className="text-right">
                <Button size="sm" variant="ghost" onClick={() => revoke.mutate(tk.id)}>
                  {t('settings.revoke')}
                </Button>
              </Td>
            </tr>
          ))}
        </tbody>
      </Table>
      <Dialog
        open={open}
        onOpenChange={setOpen}
        title={t('settings.newToken')}
        footer={
          created ? (
            <Button onClick={() => setOpen(false)}>{t('common.done')}</Button>
          ) : (
            <Button variant="primary" disabled={!name || !scopes.length} loading={create.isPending} onClick={() => create.mutate(undefined)}>
              {t('common.create')}
            </Button>
          )
        }
      >
        {created ? (
          <div className="space-y-2">
            <p className="text-[13px] text-warn">{t('settings.tokenCreated')}</p>
            <CopyField value={created} />
          </div>
        ) : (
          <div className="space-y-3">
            <Field label={t('common.name')}>
              <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="CI pipeline" />
            </Field>
            <Field label={t('settings.scopes')}>
              <div className="flex flex-wrap gap-1.5">
                {allowed.map((s) => (
                  <button
                    type="button"
                    key={s}
                    onClick={() => setScopes((cur) => (cur.includes(s) ? cur.filter((x) => x !== s) : [...cur, s]))}
                    className={`rounded-md border px-2 py-1 text-[12.5px] ${scopes.includes(s) ? 'border-accent bg-accent-soft text-accent' : 'border-border text-muted'}`}
                  >
                    {t(`settings.scope.${s}`)}
                  </button>
                ))}
              </div>
            </Field>
            <Field label={t('settings.expires')}>
              <Select value={days} onChange={(e) => setDays(e.target.value)}>
                {['30', '90', '365'].map((d) => (
                  <option key={d} value={d}>
                    {t('settings.days', { count: Number(d) })}
                  </option>
                ))}
                <option value="never">{t('settings.noExpiry')}</option>
              </Select>
            </Field>
          </div>
        )}
      </Dialog>
    </Card>
  );
}

export function SettingsPage() {
  const { t } = useTranslation();
  const me = useMe();
  const search = useSearch({ from: '/app/settings' }) as { tab?: string };
  const navigate = useNavigate();
  const [name, setName] = useState(me.name);
  const save = useAction(() => api.patch('me', { name }), { invalidate: [['me']], success: t('common.done') });
  return (
    <div>
      <PageHeader icon={<Settings className="h-4 w-4" />} title={t('settings.title')} />
      <Tabs
        value={search.tab ?? 'profile'}
        onValueChange={(v) => navigate({ to: '/settings', search: { tab: v }, replace: true })}
        tabs={[
          { value: 'profile', label: t('settings.profile') },
          { value: 'tokens', label: t('settings.tokens') },
        ]}
      >
        <TabPanel value="profile">
          <Card className="max-w-xl space-y-4 p-5">
            <div className="flex items-center gap-3">
              <Avatar name={me.name} image={me.image} size={44} />
              <div>
                <div className="font-medium">{me.email}</div>
                <div className="text-[12.5px] text-subtle">
                  {t(`roles.${me.role}`)} · {me.orgName}
                </div>
              </div>
            </div>
            <Field label={t('setup.fullName')}>
              <Input value={name} onChange={(e) => setName(e.target.value)} />
            </Field>
            <div className="flex flex-wrap gap-1.5">
              {me.namespaces.map((n) => (
                <Badge key={n.id}>
                  @{n.slug} · {t(`roles.${n.role}`)}
                </Badge>
              ))}
            </div>
            <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined)}>
              {t('common.save')}
            </Button>
          </Card>
        </TabPanel>
        <TabPanel value="tokens">
          <Tokens />
        </TabPanel>
      </Tabs>
    </div>
  );
}

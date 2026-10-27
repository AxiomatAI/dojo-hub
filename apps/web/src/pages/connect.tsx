import { useQuery } from '@tanstack/react-query';
import { useSearch } from '@tanstack/react-router';
import { Bot, CheckCircle2, Terminal, XCircle } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useMe } from '../components/shell';
import { Button, Card, CardHeader, CopyField, Input, PageHeader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';

export function ConnectPage() {
  const { t } = useTranslation();
  const me = useMe();
  const base = window.location.origin;
  const team = me.namespaces.find((n) => n.slug !== 'org')?.slug ?? 'org';
  return (
    <div className="max-w-3xl">
      <PageHeader icon={<Terminal className="h-4 w-4" />} title={t('connect.title')} description={t('connect.subtitle')} />
      <div className="space-y-4">
        <Card>
          <CardHeader title={t('connect.skillsCli')} description={t('connect.skillsCliBody')} />
          <div className="space-y-2 p-4">
            <CopyField value="export DISABLE_TELEMETRY=1" />
            <CopyField value={`npx skills add ${base}/t/${team}`} />
            <CopyField value={`npx skills add ${base}/git/t/${team}.git`} />
            <CopyField value={`SKILLS_API_URL=${base} npx skills find <query>`} />
          </div>
        </Card>
        <Card>
          <CardHeader title={t('connect.dojoCli')} description={t('connect.dojoCliBody')} />
          <div className="space-y-2 p-4">
            <CopyField value="npm install -g @axiomat/dojo" />
            <CopyField value={`dojo login ${base}`} />
            <CopyField value={`dojo sync --team ${team}`} />
            <CopyField value="dojo add @platform/conventional-commits" />
            <CopyField value="dojo submit ./my-skill --namespace platform" />
          </div>
        </Card>
        <Card>
          <CardHeader title={t('connect.mcp')} description={t('connect.mcpBody')} />
          <div className="space-y-2 p-4">
            <CopyField value={`claude mcp add --transport http dojohub ${base}/mcp --header "Authorization: Bearer <token>"`} />
            <pre className="overflow-x-auto rounded-md border border-border bg-bg-subtle p-3 font-mono text-[12px]">
              {JSON.stringify({ mcpServers: { dojohub: { type: 'http', url: `${base}/mcp`, headers: { Authorization: 'Bearer dojo_pat_…' } } } }, null, 2)}
            </pre>
          </div>
        </Card>
        <p className="text-[12.5px] text-subtle">{t('connect.telemetry')}</p>
      </div>
    </div>
  );
}

export function DevicePage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/app/device' }) as { code?: string };
  const [code, setCode] = useState(search.code ?? '');
  const [result, setResult] = useState<'approved' | 'denied' | null>(null);
  const lookup = useQuery({
    queryKey: ['device', code],
    queryFn: () => api.get<{ clientName: string; userCode: string }>(`cli/device/${encodeURIComponent(code)}`),
    enabled: /^[A-Z0-9]{4}-[A-Z0-9]{4}$/i.test(code) && !result,
    retry: false,
  });
  const decide = useAction((approve: boolean) => api.post('cli/device/approve', { userCode: code, approve }), { onSuccess: (_r) => setResult(decide.variables ? 'approved' : 'denied') });
  return (
    <div className="mx-auto max-w-md pt-10">
      <Card className="p-6 text-center">
        <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-xl bg-accent-soft text-accent">
          <Bot className="h-5 w-5" />
        </div>
        <h1 className="text-[17px] font-semibold">{t('device.title')}</h1>
        {result ? (
          <p className="mt-4 flex items-center justify-center gap-2 text-[14px]">
            {result === 'approved' ? <CheckCircle2 className="h-5 w-5 text-ok" /> : <XCircle className="h-5 w-5 text-danger" />}
            {t(`device.${result}`)}
          </p>
        ) : (
          <>
            <p className="mt-1 text-[13px] text-muted">{t('device.body')}</p>
            <div className="mt-5">
              <Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-1234" className="h-11 text-center font-mono text-lg tracking-[0.3em]" aria-label={t('device.enterCode')} />
            </div>
            {lookup.isFetching && <Spinner className="mx-auto mt-4" />}
            {lookup.isError && <p className="mt-3 text-[12.5px] text-danger">{t('device.invalid')}</p>}
            {lookup.data && (
              <div className="mt-4 space-y-3">
                <p className="text-[13px] text-muted">
                  {t('device.code')} <strong className="font-mono">{lookup.data.clientName}</strong>
                </p>
                <div className="flex justify-center gap-2">
                  <Button variant="ghost" onClick={() => decide.mutate(false)}>
                    {t('device.deny')}
                  </Button>
                  <Button variant="primary" loading={decide.isPending} onClick={() => decide.mutate(true)}>
                    {t('device.approve')}
                  </Button>
                </div>
              </div>
            )}
          </>
        )}
      </Card>
    </div>
  );
}

import type { SuiteDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Boxes, ExternalLink, Star } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { InstallMenu, SkillGlyph, StatusPill } from '../components/dojo';
import { Badge, Card, CardHeader, EmptyState, PageHeader, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { formatDate } from '../lib/format';

export function SuitesPage() {
  const { t } = useTranslation();
  const q = useQuery({ queryKey: ['suites'], queryFn: () => api.get<SuiteDto[]>('suites') });
  return (
    <div>
      <PageHeader
        icon={<Boxes className="h-4 w-4" />}
        title={t('suites.title')}
        description={t('suites.subtitle')}
      />
      {q.isLoading && <Skeleton className="h-40" />}
      {q.data?.length === 0 && (
        <Card>
          <EmptyState
            icon={<Boxes className="h-5 w-5" />}
            title={t('suites.empty')}
            action={
              <Link to="/sources/new" search={{ preset: undefined, url: undefined }} className="text-accent">
                {t('sources.new')} →
              </Link>
            }
          />
        </Card>
      )}
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {q.data?.map((s) => (
          <Link key={s.id} to="/suites/$ns/$name" params={{ ns: s.namespace, name: s.name }}>
            <Card className="h-full p-4 transition-colors hover:border-border-strong">
              <div className="flex items-start gap-3">
                <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border border-border bg-accent-soft text-accent">
                  <Boxes className="h-4 w-4" />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.displayName}</div>
                  <div className="text-[12px] text-subtle">
                    @{s.namespace} · v{s.publishedVersion ?? s.latestVersion}
                  </div>
                </div>
                <StatusPill status={s.status} withHelp={false} />
              </div>
              <p className="mt-3 line-clamp-2 text-[12.5px] text-muted">{s.description}</p>
              <div className="mt-3 flex gap-3 text-[12px] text-subtle">
                <span>{t('count.skills', { count: s.skillCount })}</span>
                <span>{t('count.installs', { count: s.installCount })}</span>
                {s.author && <span>{s.author}</span>}
              </div>
            </Card>
          </Link>
        ))}
      </div>
    </div>
  );
}

export function SuiteDetailPage() {
  const { t } = useTranslation();
  const { ns, name } = useParams({ from: '/app/suites/$ns/$name' });
  const q = useQuery({
    queryKey: ['suite', ns, name],
    queryFn: () =>
      api.get<
        SuiteDto & {
          versions: {
            id: string;
            version: string;
            status: string;
            statusReason: string | null;
            createdAt: string;
            assets: { path: string }[];
          }[];
        }
      >(`suites/${ns}/${name}`),
  });
  if (q.isLoading) return <Skeleton className="h-64" />;
  const s = q.data;
  if (!s) return <EmptyState title={t('common.notFound')} />;
  return (
    <div>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <span className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-accent-soft text-accent">
          <Boxes className="h-6 w-6" />
        </span>
        <div className="min-w-[16rem] flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[22px] font-semibold tracking-tight">{s.displayName}</h1>
            <StatusPill status={s.status} />
          </div>
          <p className="mt-1 max-w-3xl text-muted">{s.description}</p>
          <div className="mt-2 flex flex-wrap gap-x-4 text-[12.5px] text-subtle">
            <span>@{s.namespace}</span>
            {s.publishedVersion && <span>v{s.publishedVersion}</span>}
            {s.author && (
              <span>
                {t('suites.author')}: {s.author}
              </span>
            )}
            {s.license && <span>{s.license}</span>}
            {s.homepage && (
              <a
                href={s.homepage}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 hover:text-fg"
              >
                {t('suites.homepage')} <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </div>
        {s.install && s.publishedVersion && <InstallMenu install={s.install} />}
      </div>
      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_300px]">
        <Card className="overflow-hidden">
          <CardHeader
            title={t('suites.members')}
            description={t('count.skills', { count: s.members?.length ?? 0 })}
          />
          {s.members?.map((m) => (
            <Link
              key={m.versionId}
              to="/skills/$name"
              params={{ name: m.name }}
              search={{ tab: undefined }}
              className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-panel-hover"
            >
              <SkillGlyph name={m.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 font-medium">
                  {m.displayName}
                  {m.isEntry && (
                    <Badge tone="accent">
                      <Star className="h-3 w-3" />
                      {t('suites.entry')}
                    </Badge>
                  )}
                </div>
                <code className="font-mono text-[11.5px] text-subtle">
                  {m.name}@{m.version}
                </code>
              </div>
              <StatusPill status={m.status} withHelp={false} />
            </Link>
          ))}
        </Card>
        <Card className="h-fit overflow-hidden">
          <CardHeader title={t('common.versions')} />
          {s.versions.map((v) => (
            <div
              key={v.id}
              className="flex items-center gap-2 border-b border-border px-4 py-2 text-[13px] last:border-b-0"
            >
              <code className="font-mono font-medium">v{v.version}</code>
              <StatusPill status={v.status as never} />
              <span className="ml-auto text-[12px] text-subtle">{formatDate(v.createdAt)}</span>
            </div>
          ))}
        </Card>
      </div>
    </div>
  );
}

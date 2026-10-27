import type { NamespaceDto, Paginated, ReviewDto, SkillSummaryDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRight, Compass, Inbox, Sparkles, Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { RiskBadge, SkillRow, StatusIcon } from '../components/dojo';
import { isAdmin, useMe } from '../components/shell';
import { Button, Card, CardHeader, CopyField, EmptyState, Skeleton } from '../components/ui';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';

export function HomePage() {
  const { t } = useTranslation();
  const me = useMe();
  const firstTeam = me.namespaces.find((n) => n.slug !== 'org');
  const forYou = useQuery({
    queryKey: ['skills', 'for-you', firstTeam?.slug],
    queryFn: () =>
      api.get<Paginated<SkillSummaryDto>>(
        `skills?team=${firstTeam!.slug}&status=approved,deprecated&pageSize=6&sort=installs`,
      ),
    enabled: !!firstTeam,
  });
  const recent = useQuery({
    queryKey: ['skills', 'recent'],
    queryFn: () => api.get<Paginated<SkillSummaryDto>>('skills?pageSize=8&sort=updated'),
  });
  const reviews = useQuery({
    queryKey: ['reviews', 'assigned'],
    queryFn: () => api.get<ReviewDto[]>('reviews?status=pending&assigned=true'),
  });
  const teams = useQuery({ queryKey: ['namespaces'], queryFn: () => api.get<NamespaceDto[]>('namespaces') });
  const firstName = me.name.split(' ')[0];
  const empty = recent.data && recent.data.total === 0;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">
            {t('home.greeting', { name: firstName })}
          </h1>
          <p className="mt-0.5 text-muted">{t('home.subtitle')}</p>
        </div>
        <div className="flex gap-2">
          <Link to="/skills">
            <Button icon={<Compass className="h-3.5 w-3.5" />}>{t('nav.discover')}</Button>
          </Link>
          <Link to="/submit">
            <Button variant="primary">{t('nav.submit')}</Button>
          </Link>
        </div>
      </div>

      {empty && (
        <Card>
          <EmptyState
            icon={<Sparkles className="h-5 w-5" />}
            title={t('home.empty')}
            description={t('home.emptyBody')}
            action={
              <div className="flex gap-2">
                {isAdmin(me) && (
                  <Link to="/onboarding">
                    <Button variant="primary">{t('onboarding.title')}</Button>
                  </Link>
                )}
                <Link to="/submit">
                  <Button>{t('nav.submit')}</Button>
                </Link>
              </div>
            }
          />
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="space-y-6">
          {firstTeam && (
            <Card>
              <CardHeader
                title={t('home.forYou')}
                description={firstTeam.displayName}
                actions={
                  <Link
                    to="/teams/$slug"
                    params={{ slug: firstTeam.slug }}
                    className="text-[12.5px] text-accent"
                  >
                    {t('common.view')} <ArrowRight className="inline h-3 w-3" />
                  </Link>
                }
              />
              {forYou.isLoading && <Skeleton className="m-4 h-24" />}
              {forYou.data?.items.length === 0 && (
                <p className="px-4 py-6 text-[13px] text-muted">{t('teams.catalogEmpty')}</p>
              )}
              {forYou.data?.items.map((s) => (
                <SkillRow key={s.id} skill={s} />
              ))}
            </Card>
          )}
          <Card>
            <CardHeader
              title={t('home.recent')}
              actions={
                <Link to="/skills" className="text-[12.5px] text-accent">
                  {t('common.view')} <ArrowRight className="inline h-3 w-3" />
                </Link>
              }
            />
            {recent.isLoading && <Skeleton className="m-4 h-40" />}
            {recent.data?.items.map((s) => (
              <SkillRow key={s.id} skill={s} />
            ))}
          </Card>
        </div>
        <div className="space-y-6">
          <Card>
            <CardHeader title={t('home.pendingForYou')} actions={<Inbox className="h-4 w-4 text-subtle" />} />
            {reviews.data?.length === 0 && (
              <p className="px-4 py-5 text-[13px] text-muted">{t('home.noPending')}</p>
            )}
            <ul>
              {reviews.data?.slice(0, 6).map((r) => (
                <li key={r.id}>
                  <Link
                    to="/reviews/$id"
                    params={{ id: r.id }}
                    className="flex items-center gap-2.5 border-b border-border px-4 py-2.5 last:border-b-0 hover:bg-panel-hover"
                  >
                    <StatusIcon status="in_review" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[13px] font-medium">
                        {r.subject.displayName}{' '}
                        <span className="font-mono text-[11.5px] text-subtle">v{r.subject.version}</span>
                      </div>
                      <div className="text-[12px] text-subtle">
                        {t(`reviews.kind.${r.kind}`)} · {relativeTime(r.createdAt)}
                      </div>
                    </div>
                    <RiskBadge level={r.subject.riskLevel} />
                  </Link>
                </li>
              ))}
            </ul>
          </Card>
          <Card className="p-4">
            <div className="mb-1 flex items-center gap-2 font-semibold">
              <Terminal className="h-4 w-4 text-accent" />
              {t('home.quickstart')}
            </div>
            <p className="mb-3 text-[12.5px] text-muted">{t('home.quickstartBody')}</p>
            {firstTeam ? (
              <CopyField value={`npx skills add ${window.location.origin}/t/${firstTeam.slug}`} />
            ) : (
              <CopyField value={`npx skills add ${window.location.origin}/t/org`} />
            )}
            <Link to="/connect" className="mt-3 inline-flex items-center gap-1 text-[12.5px] text-accent">
              {t('nav.connect')} <ArrowRight className="h-3 w-3" />
            </Link>
          </Card>
          {!!teams.data?.length && (
            <Card>
              <CardHeader title={t('nav.teams')} />
              <ul className="py-1">
                {teams.data
                  .filter((n) => n.kind === 'team')
                  .slice(0, 8)
                  .map((n) => (
                    <li key={n.id}>
                      <Link
                        to="/teams/$slug"
                        params={{ slug: n.slug }}
                        className="flex items-center gap-2 px-4 py-1.5 text-[13px] hover:bg-panel-hover"
                      >
                        <span
                          className="h-2.5 w-2.5 rounded-sm"
                          style={{ background: n.color ?? 'var(--fg-subtle)' }}
                        />
                        <span className="flex-1 truncate">{n.displayName}</span>
                        <span className="text-[12px] text-subtle">
                          {t('count.skills', { count: n.catalogCount })}
                        </span>
                      </Link>
                    </li>
                  ))}
              </ul>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

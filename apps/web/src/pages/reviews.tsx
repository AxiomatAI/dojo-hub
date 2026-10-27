import type { ReviewDto } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearch } from '@tanstack/react-router';
import { Bot, Check, CircleDot, Clock, Inbox, MessageSquareWarning, X } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { RiskBadge, SkillGlyph, StatusPill } from '../components/dojo';
import { Avatar, Badge, Button, Card, CardHeader, EmptyState, PageHeader, Segmented, Skeleton, Textarea } from '../components/ui';
import { FilesBrowser, SecurityReport, type VersionDetail } from '../components/version';
import { api } from '../lib/api';
import { relativeTime } from '../lib/format';
import { useAction } from '../lib/hooks';
import { cn } from '../lib/utils';
import { DiffSummary } from './skill';

export function ReviewsPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/app/reviews' }) as { status?: string };
  const navigate = useNavigate();
  const view = search.status ?? 'assigned';
  const q = useQuery({
    queryKey: ['reviews', view],
    queryFn: () => api.get<ReviewDto[]>(view === 'assigned' ? 'reviews?status=pending&assigned=true' : view === 'pending' ? 'reviews?status=pending' : 'reviews?status=all'),
  });
  return (
    <div>
      <PageHeader
        icon={<Inbox className="h-4 w-4" />}
        title={t('reviews.title')}
        description={t('reviews.subtitle')}
        actions={
          <Segmented
            value={view}
            onChange={(v) => navigate({ to: '/reviews', search: { status: v }, replace: true })}
            options={[
              { value: 'assigned', label: t('reviews.assigned') },
              { value: 'pending', label: t('reviews.pending') },
              { value: 'all', label: t('reviews.all') },
            ]}
          />
        }
      />
      <Card className="overflow-hidden">
        {q.isLoading && <Skeleton className="m-4 h-32" />}
        {q.data?.length === 0 && <EmptyState icon={<Check className="h-5 w-5" />} title={t('reviews.empty')} />}
        {q.data?.map((r) => {
          const active = r.stages.find((s) => s.status === 'active');
          return (
            <Link key={r.id} to="/reviews/$id" params={{ id: r.id }} className="flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0 hover:bg-panel-hover">
              <SkillGlyph name={r.subject.name} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="truncate font-medium">{r.subject.displayName}</span>
                  <code className="font-mono text-[11.5px] text-subtle">v{r.subject.version}</code>
                  <Badge>{t(`reviews.kind.${r.kind}`)}</Badge>
                  {r.subject.type === 'suite' && <Badge tone="accent">suite</Badge>}
                </div>
                <div className="mt-0.5 flex items-center gap-2 text-[12px] text-subtle">
                  @{r.namespace}
                  {active && (
                    <>
                      <span>·</span>
                      <CircleDot className="h-3 w-3 text-warn" />
                      {active.name}
                    </>
                  )}
                  {r.requestedBy && (
                    <>
                      <span>·</span>
                      {r.requestedBy.name}
                    </>
                  )}
                </div>
              </div>
              <RiskBadge level={r.subject.riskLevel} score={r.subject.riskScore} />
              {r.status !== 'pending' && <Badge tone={r.status === 'approved' ? 'ok' : r.status === 'rejected' ? 'danger' : 'neutral'}>{r.status}</Badge>}
              {r.canDecide && <span className="h-2 w-2 rounded-full bg-accent" />}
              <span className="w-24 text-right text-[12px] text-subtle">{relativeTime(r.createdAt)}</span>
            </Link>
          );
        })}
      </Card>
    </div>
  );
}

function StageTimeline({ review }: { review: ReviewDto }) {
  const { t } = useTranslation();
  return (
    <ol className="relative space-y-4 pl-6">
      <div className="absolute top-1 bottom-1 left-[9px] w-px bg-border" />
      {review.systemDecisions.map((d) => (
        <li key={d.createdAt} className="relative">
          <span className="absolute top-0.5 -left-6 flex h-[18px] w-[18px] items-center justify-center rounded-full border border-border bg-panel">
            <Bot className="h-3 w-3 text-accent" />
          </span>
          <div className="text-[13px] font-medium">{t('reviews.system')}</div>
          <div className="text-[12.5px] text-muted">{d.comment}</div>
        </li>
      ))}
      {review.stages.map((s) => (
        <li key={s.id} className="relative">
          <span
            className={cn(
              'absolute top-0.5 -left-6 flex h-[18px] w-[18px] items-center justify-center rounded-full border',
              s.status === 'approved' && 'border-ok bg-ok text-white',
              s.status === 'rejected' && 'border-danger bg-danger text-white',
              s.status === 'active' && 'border-warn bg-panel text-warn',
              s.status === 'waiting' && 'border-border bg-panel text-subtle',
            )}
          >
            {s.status === 'approved' ? <Check className="h-3 w-3" /> : s.status === 'rejected' ? <X className="h-3 w-3" /> : s.status === 'active' ? <CircleDot className="h-3 w-3" /> : <Clock className="h-3 w-3" />}
          </span>
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-medium">{s.name}</span>
            <span className="text-[11.5px] text-subtle">{t('reviews.needs', { count: s.minApprovals })}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap gap-1">
            {[...(s.approvers.roles ?? []).map((r) => t(`roles.${r}`, { defaultValue: r })), ...(s.approvers.groups ?? []), ...(s.approvers.users?.length ? [`${s.approvers.users.length} users`] : [])].map((a) => (
              <Badge key={a}>{a}</Badge>
            ))}
          </div>
          {s.decisions.map((d) => (
            <div key={d.createdAt} className="mt-2 flex gap-2 rounded-lg border border-border bg-bg-subtle px-3 py-2">
              <Avatar name={d.actor?.name ?? 'DojoHub'} size={20} />
              <div className="min-w-0">
                <div className="text-[12.5px]">
                  <span className="font-medium">{d.actor?.name ?? t('reviews.system')}</span>{' '}
                  <span className={d.decision === 'approve' ? 'text-ok' : 'text-danger'}>
                    {d.decision === 'approve' ? t('reviews.approve') : d.decision === 'reject' ? t('reviews.reject') : t('reviews.requestChanges')}
                  </span>{' '}
                  <span className="text-subtle">· {relativeTime(d.createdAt)}</span>
                </div>
                {d.comment && <p className="text-[12.5px] text-muted">{d.comment}</p>}
              </div>
            </div>
          ))}
        </li>
      ))}
    </ol>
  );
}

function DecisionPanel({ review }: { review: ReviewDto }) {
  const { t } = useTranslation();
  const [comment, setComment] = useState('');
  const decide = useAction((decision: string) => api.post(`reviews/${review.id}/decision`, { decision, comment: comment || undefined }), {
    invalidate: [['review', review.id], ['reviews'], ['skill'], ['version']],
    success: t('reviews.decided'),
    onSuccess: () => setComment(''),
  });
  if (review.status !== 'pending') return null;
  if (!review.canDecide) return <p className="rounded-lg border border-border bg-bg-subtle px-3 py-2 text-[12.5px] text-muted">{t('reviews.cannotDecide')}</p>;
  const needsComment = !comment.trim();
  return (
    <div className="space-y-2">
      <Textarea value={comment} onChange={(e) => setComment(e.target.value)} placeholder={t('reviews.commentPlaceholder')} rows={3} />
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={decide.isPending && decide.variables === 'approve'} onClick={() => decide.mutate('approve')}>
          {t('reviews.approve')}
        </Button>
        <Button icon={<MessageSquareWarning className="h-3.5 w-3.5" />} disabled={needsComment} onClick={() => decide.mutate('request_changes')}>
          {t('reviews.requestChanges')}
        </Button>
        <Button variant="danger" icon={<X className="h-3.5 w-3.5" />} disabled={needsComment} onClick={() => decide.mutate('reject')}>
          {t('reviews.reject')}
        </Button>
      </div>
      {needsComment && <p className="text-[11.5px] text-subtle">{t('reviews.commentRequired')}</p>}
    </div>
  );
}

export function ReviewDetailPage() {
  const { t } = useTranslation();
  const { id } = useParams({ from: '/app/reviews/$id' });
  const [tab, setTab] = useState<'security' | 'changes' | 'files'>('security');
  const review = useQuery({ queryKey: ['review', id], queryFn: () => api.get<ReviewDto>(`reviews/${id}`) });
  const r = review.data;
  const version = useQuery({
    queryKey: ['version', r?.subject.name, r?.subject.version],
    queryFn: () => api.get<VersionDetail>(`skills/${r!.subject.name}/versions/${r!.subject.version}`),
    enabled: r?.subject.type === 'skill',
  });
  const diff = useQuery({
    queryKey: ['diff', r?.subject.name, r?.subject.previousVersion, r?.subject.version],
    queryFn: () => api.get<{ changes: { path: string; change: string; binary: boolean; patch: string | null }[] }>(`skills/${r!.subject.name}/diff?from=${r!.subject.previousVersion}&to=${r!.subject.version}`),
    enabled: !!r?.subject.previousVersion,
  });
  if (review.isLoading) return <Skeleton className="h-64" />;
  if (!r) return <EmptyState title={t('common.notFound')} />;
  const isSkill = r.subject.type === 'skill';
  return (
    <div>
      <div className="mb-1 text-[12.5px] text-subtle">
        <Link to="/reviews" search={{ status: undefined }} className="hover:text-fg">
          {t('reviews.title')}
        </Link>{' '}
        / {t(`reviews.kind.${r.kind}`)}
      </div>
      <div className="mb-6 flex flex-wrap items-start gap-4">
        <SkillGlyph name={r.subject.name} size={44} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-[20px] font-semibold">{r.subject.displayName}</h1>
            <code className="font-mono text-muted">v{r.subject.version}</code>
            {r.status === 'pending' ? <StatusPill status="in_review" /> : <Badge tone={r.status === 'approved' ? 'ok' : 'danger'}>{r.status}</Badge>}
            <RiskBadge level={r.subject.riskLevel} score={r.subject.riskScore} />
          </div>
          <div className="mt-1 text-[12.5px] text-subtle">
            @{r.namespace} · {r.subject.previousVersion ? t('reviews.previous', { version: r.subject.previousVersion }) : t('reviews.firstVersion')} · {r.requestedBy?.name} · {relativeTime(r.createdAt)}
          </div>
        </div>
        {isSkill ? (
          <Link to="/skills/$name/versions/$version" params={{ name: r.subject.name, version: r.subject.version }} search={{ file: undefined }}>
            <Button>{t('common.open')}</Button>
          </Link>
        ) : (
          <Link to="/suites" className="text-accent">
            {t('nav.suites')}
          </Link>
        )}
      </div>
      <div className="grid gap-6 lg:grid-cols-[1fr_340px]">
        <div className="min-w-0">
          {isSkill && (
            <>
              <div className="mb-4">
                <Segmented
                  value={tab}
                  onChange={setTab}
                  options={[
                    { value: 'security', label: t('skills.tabs.security') },
                    ...(r.subject.previousVersion ? [{ value: 'changes' as const, label: t('skills.compare') }] : []),
                    { value: 'files', label: t('skills.tabs.files') },
                  ]}
                />
              </div>
              {tab === 'security' && (version.data ? <SecurityReport detail={version.data} skill={r.subject.name} onFile={() => setTab('files')} /> : <Skeleton className="h-64" />)}
              {tab === 'changes' && <DiffSummary name={r.subject.name} data={diff.data} loading={diff.isLoading} />}
              {tab === 'files' && version.data && <FilesBrowser skill={r.subject.name} version={r.subject.version} files={version.data.files} />}
            </>
          )}
        </div>
        <div className="space-y-4">
          <Card className="lg:sticky lg:top-4">
            <CardHeader title={t('reviews.stages')} />
            <div className="space-y-5 p-4">
              <StageTimeline review={r} />
              <DecisionPanel review={r} />
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}

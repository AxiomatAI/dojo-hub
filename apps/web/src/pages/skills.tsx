import {
  type NamespaceDto,
  type Paginated,
  RISK_LEVELS,
  type SkillSummaryDto,
  VERSION_STATUSES,
} from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Compass, Plus, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SkillRow } from '../components/dojo';
import { useOptionalMe } from '../components/shell';
import { Button, Card, EmptyState, Input, PageHeader, Select, Skeleton } from '../components/ui';
import { api, qs } from '../lib/api';

export function SkillsPage() {
  const { t } = useTranslation();
  const me = useOptionalMe();
  const search = useSearch({ from: '/app/skills' }) as {
    q?: string;
    team?: string;
    status?: string;
    risk?: string;
    sort?: string;
    mine?: boolean;
  };
  const navigate = useNavigate({ from: '/skills' });
  const [q, setQ] = useState(search.q ?? '');
  useEffect(() => {
    const id = setTimeout(() => {
      if (q !== (search.q ?? ''))
        void navigate({ search: (s) => ({ ...s, q: q || undefined }), replace: true });
    }, 250);
    return () => clearTimeout(id);
  }, [q, search.q, navigate]);
  const set = (k: string, v: string | undefined) =>
    navigate({ search: (s) => ({ ...s, [k]: v || undefined }), replace: true });

  const teams = useQuery({ queryKey: ['namespaces'], queryFn: () => api.get<NamespaceDto[]>('namespaces') });
  const list = useQuery({
    queryKey: ['skills', search],
    queryFn: () =>
      api.get<Paginated<SkillSummaryDto>>(
        `skills${qs({ q: search.q, team: search.team, status: search.status, risk: search.risk, sort: search.sort ?? 'updated', mine: search.mine, pageSize: 100 })}`,
      ),
    placeholderData: (prev) => prev,
  });

  return (
    <div>
      <PageHeader
        icon={<Compass className="h-4 w-4" />}
        title={t('skills.title')}
        description={t('skills.subtitle')}
        actions={
          me ? (
            <Link to="/submit">
              <Button variant="primary" icon={<Plus className="h-3.5 w-3.5" />}>
                {t('nav.submit')}
              </Button>
            </Link>
          ) : null
        }
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <Search className="pointer-events-none absolute top-2 left-2.5 h-4 w-4 text-subtle" />
          <Input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('skills.searchPlaceholder')}
            className="pl-8"
          />
        </div>
        <SlidersHorizontal className="h-4 w-4 text-subtle" />
        <Select
          value={search.team ?? ''}
          onChange={(e) => set('team', e.target.value)}
          className="w-40"
          aria-label={t('skills.filters.team')}
        >
          <option value="">
            {t('skills.filters.team')}: {t('common.all')}
          </option>
          {teams.data?.map((n) => (
            <option key={n.id} value={n.slug}>
              {n.displayName}
            </option>
          ))}
        </Select>
        <Select
          value={search.status ?? ''}
          onChange={(e) => set('status', e.target.value)}
          className="w-40"
          aria-label={t('skills.filters.status')}
        >
          <option value="">
            {t('skills.filters.status')}: {t('common.all')}
          </option>
          {VERSION_STATUSES.map((s) => (
            <option key={s} value={s}>
              {t(`status.${s}`)}
            </option>
          ))}
        </Select>
        <Select
          value={search.risk ?? ''}
          onChange={(e) => set('risk', e.target.value)}
          className="w-36"
          aria-label={t('skills.filters.risk')}
        >
          <option value="">
            {t('skills.filters.risk')}: {t('common.all')}
          </option>
          {RISK_LEVELS.map((r) => (
            <option key={r} value={r}>
              {t(`riskLevel.${r}`)}
            </option>
          ))}
        </Select>
        <Select
          value={search.sort ?? 'updated'}
          onChange={(e) => set('sort', e.target.value)}
          className="w-44"
          aria-label={t('skills.filters.sort')}
        >
          <option value="updated">{t('skills.filters.updated')}</option>
          <option value="installs">{t('skills.filters.installs')}</option>
          <option value="name">{t('skills.filters.name')}</option>
        </Select>
      </div>
      <Card className="overflow-hidden">
        {list.isLoading && (
          <div className="space-y-2 p-4">
            {[0, 1, 2, 3].map((i) => (
              <Skeleton key={i} className="h-10" />
            ))}
          </div>
        )}
        {list.data?.items.length === 0 && (
          <EmptyState icon={<Search className="h-5 w-5" />} title={t('skills.empty')} />
        )}
        {list.data?.items.map((s) => (
          <SkillRow key={s.id} skill={s} />
        ))}
      </Card>
      {list.data && list.data.total > 0 && (
        <p className="mt-2 text-right text-[12px] text-subtle">
          {t('count.skills', { count: list.data.total })}
        </p>
      )}
    </div>
  );
}

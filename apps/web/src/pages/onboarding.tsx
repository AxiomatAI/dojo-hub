import type { PresetSource, SetupStatus } from '@dojohub/contract';
import { useQuery } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { Bot, Boxes, Check, FileUp, GitBranch, PenLine, ShieldCheck, Sparkles, Users } from 'lucide-react';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { isAdmin, useMe } from '../components/shell';
import { Button, Card, Field, Input, Textarea } from '../components/ui';
import { api } from '../lib/api';
import { useAction } from '../lib/hooks';
import { cn } from '../lib/utils';
import { LlmForm, SsoProviderForm } from './admin';
import { ConnectPage } from './connect';

const STEPS = ['sso', 'llm', 'team', 'skills'] as const;
type Step = (typeof STEPS)[number];

function TeamStep({ onDone }: { onDone: () => void }) {
  const { t } = useTranslation();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const slug = name
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const create = useAction(
    () => api.post('namespaces', { displayName: name, slug, description, visibility: 'internal' }),
    { invalidate: [['namespaces'], ['me'], ['setup-status']], onSuccess: onDone },
  );
  return (
    <div className="space-y-3">
      <Field label={t('common.name')} hint={slug ? `@${slug}` : undefined}>
        <Input autoFocus value={name} onChange={(e) => setName(e.target.value)} placeholder="Platform" />
      </Field>
      <Field label={t('common.description')}>
        <Textarea rows={2} value={description} onChange={(e) => setDescription(e.target.value)} />
      </Field>
      <div className="flex justify-end">
        <Button
          variant="primary"
          disabled={slug.length < 2}
          loading={create.isPending}
          onClick={() => create.mutate(undefined)}
        >
          {t('common.create')}
        </Button>
      </div>
    </div>
  );
}

function SkillsStep() {
  const { t } = useTranslation();
  const presets = useQuery({
    queryKey: ['presets'],
    queryFn: () => api.get<PresetSource[]>('sources/presets'),
  });
  const cards = [
    {
      to: '/submit',
      search: { mode: 'upload' },
      icon: <FileUp className="h-5 w-5" />,
      title: t('onboarding.upload'),
      body: t('onboarding.uploadBody'),
    },
    {
      to: '/submit',
      search: { mode: 'create' },
      icon: <PenLine className="h-5 w-5" />,
      title: t('submit.create'),
      body: t('onboarding.createBody'),
    },
    {
      to: '/sources/new',
      search: {},
      icon: <GitBranch className="h-5 w-5" />,
      title: t('submit.import'),
      body: t('onboarding.importBody'),
    },
  ];
  return (
    <div className="space-y-5">
      <div className="grid gap-3 sm:grid-cols-3">
        {cards.map((c) => (
          <Link key={c.title} to={c.to} search={c.search as never}>
            <Card className="h-full p-4 transition-colors hover:border-accent">
              <div className="mb-2 flex h-9 w-9 items-center justify-center rounded-lg bg-accent-soft text-accent">
                {c.icon}
              </div>
              <div className="font-medium">{c.title}</div>
              <p className="mt-0.5 text-[12.5px] text-muted">{c.body}</p>
            </Card>
          </Link>
        ))}
      </div>
      <div>
        <div className="mb-2 text-[12px] font-medium text-subtle uppercase">{t('onboarding.popular')}</div>
        <div className="grid gap-2 sm:grid-cols-2">
          {presets.data?.map((p) => (
            <Link
              key={p.id}
              to="/sources/new"
              search={{ preset: p.id, url: undefined }}
              className="flex items-start gap-3 rounded-lg border border-border bg-panel p-3 hover:border-border-strong"
            >
              {p.kindLabel === 'suite' ? (
                <Boxes className="mt-0.5 h-4 w-4 text-accent" />
              ) : (
                <Sparkles className="mt-0.5 h-4 w-4 text-accent" />
              )}
              <div className="min-w-0">
                <div className="text-[13px] font-medium">{p.name}</div>
                <div className="line-clamp-2 text-[12px] text-muted">{p.description}</div>
              </div>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}

export function OnboardingPage() {
  const { t } = useTranslation();
  const me = useMe();
  const navigate = useNavigate();
  const search = useSearch({ from: '/app/onboarding' }) as { step?: string };
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<SetupStatus>('setup/status'),
  });
  if (!isAdmin(me)) return <ConnectPage />;
  const step = (search.step as Step) ?? 'sso';
  const go = (s: Step) => navigate({ to: '/onboarding', search: { step: s }, replace: true });
  const next = () => {
    const i = STEPS.indexOf(step);
    if (i < STEPS.length - 1) void go(STEPS[i + 1]!);
    else void navigate({ to: '/' });
  };
  const done: Record<Step, boolean> = {
    sso: !!status.data?.onboarding.hasSso,
    llm: !!status.data?.onboarding.hasLlm,
    team: !!status.data?.onboarding.hasTeam,
    skills: !!status.data?.onboarding.hasSkills,
  };
  const icons: Record<Step, React.ReactNode> = {
    sso: <ShieldCheck className="h-4 w-4" />,
    llm: <Bot className="h-4 w-4" />,
    team: <Users className="h-4 w-4" />,
    skills: <Sparkles className="h-4 w-4" />,
  };
  return (
    <div className="mx-auto max-w-3xl">
      <div className="mb-6 flex items-end justify-between gap-4">
        <div>
          <h1 className="text-[22px] font-semibold tracking-tight">{t('onboarding.title')}</h1>
          <p className="text-muted">{t('onboarding.subtitle')}</p>
        </div>
        <Link to="/" className="text-[12.5px] text-subtle hover:text-fg">
          {t('onboarding.skipAll')}
        </Link>
      </div>
      <ol className="mb-6 grid grid-cols-4 gap-2">
        {STEPS.map((s, i) => (
          <li key={s}>
            <button
              type="button"
              onClick={() => go(s)}
              className={cn(
                'flex w-full items-center gap-2 rounded-lg border px-3 py-2 text-left text-[12.5px] transition-colors',
                s === step
                  ? 'border-accent bg-accent-soft text-fg'
                  : 'border-border text-muted hover:text-fg',
              )}
            >
              <span
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px]',
                  done[s] ? 'bg-ok text-white' : 'bg-bg-subtle',
                )}
              >
                {done[s] ? <Check className="h-3 w-3" /> : i + 1}
              </span>
              <span className="hidden truncate sm:inline">{t(`onboarding.steps.${s}`)}</span>
            </button>
          </li>
        ))}
      </ol>
      <Card className="animate-in p-6" key={step}>
        <div className="mb-1 flex items-center gap-2 text-accent">{icons[step]}</div>
        <h2 className="text-[17px] font-semibold">{t(`onboarding.${step}.title`)}</h2>
        <p className="mt-1 mb-5 text-[13px] text-muted">{t(`onboarding.${step}.body`)}</p>
        {step === 'sso' && <SsoProviderForm onDone={next} />}
        {step === 'llm' && <LlmForm purpose="judge" onDone={next} />}
        {step === 'team' && <TeamStep onDone={next} />}
        {step === 'skills' && <SkillsStep />}
        <div className="mt-6 flex justify-between border-t border-border pt-4">
          <Button
            variant="ghost"
            disabled={step === 'sso'}
            onClick={() => go(STEPS[Math.max(0, STEPS.indexOf(step) - 1)]!)}
          >
            {t('common.back')}
          </Button>
          <Button onClick={next}>{step === 'skills' ? t('onboarding.finish') : t('common.skip')}</Button>
        </div>
      </Card>
    </div>
  );
}

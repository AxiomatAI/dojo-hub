import type { SetupStatus } from '@dojohub/contract';
import { LOCALE_LABELS, LOCALES, type Locale } from '@dojohub/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { ArrowRight, KeyRound, ShieldCheck } from 'lucide-react';
import { type FormEvent, type ReactNode, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Logo } from '../components/shell';
import { Button, Field, Input, Select, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { authClient } from '../lib/auth';
import { errorMessage } from '../lib/hooks';
import { setLocale } from '../lib/i18n';

function AuthFrame({ children, footer }: { children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="relative flex min-h-full items-center justify-center overflow-hidden px-4 py-12">
      <div
        className="pointer-events-none absolute inset-0 opacity-60"
        style={{
          background: 'radial-gradient(60rem 30rem at 50% -10%, var(--accent-soft), transparent 70%)',
        }}
      />
      <div className="relative w-full max-w-[400px]">
        <div className="mb-8 flex items-center justify-center gap-2.5">
          <Logo className="h-8 w-8" />
          <span className="text-lg font-semibold tracking-tight">DojoHub</span>
          <span className="text-subtle">道場</span>
        </div>
        <div className="animate-in rounded-2xl border border-border bg-panel p-6 shadow-float">
          {children}
        </div>
        {footer && <div className="mt-4 text-center text-[12px] text-subtle">{footer}</div>}
      </div>
    </div>
  );
}

function LanguagePicker() {
  const { i18n } = useTranslation();
  return (
    <select
      value={i18n.language}
      onChange={(e) => setLocale(e.target.value as Locale)}
      className="rounded-md bg-transparent text-[12px] text-subtle hover:text-fg focus:outline-none"
      aria-label="Language"
    >
      {LOCALES.map((l) => (
        <option key={l} value={l}>
          {LOCALE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}

export function LoginPage() {
  const { t } = useTranslation();
  const search = useSearch({ from: '/login' });
  const navigate = useNavigate();
  const qc = useQueryClient();
  const status = useQuery({
    queryKey: ['setup-status'],
    queryFn: () => api.get<SetupStatus>('setup/status'),
  });
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(search.error ?? null);
  const [busy, setBusy] = useState<string | null>(null);
  const callbackURL = search.redirect && search.redirect.startsWith('/') ? search.redirect : '/';

  if (status.data?.needsSetup) {
    void navigate({ to: '/setup', search: { token: undefined } });
  }

  const sso = async (opts: { providerId?: string; email?: string }) => {
    setBusy(opts.providerId ?? 'sso');
    setError(null);
    const res = await authClient.signIn.sso({ ...opts, callbackURL, errorCallbackURL: '/login?error=sso' });
    if (res.error) {
      setError(res.error.message ?? t('auth.noSso'));
      setBusy(null);
    }
  };

  const local = async (e: FormEvent) => {
    e.preventDefault();
    setBusy('local');
    setError(null);
    const res = await authClient.signIn.email({ email, password });
    if (res.error) {
      setError(t('auth.invalid'));
      setBusy(null);
      return;
    }
    await qc.invalidateQueries();
    window.location.href = callbackURL;
  };

  if (status.isLoading) {
    return (
      <AuthFrame>
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      </AuthFrame>
    );
  }
  const providers = status.data?.ssoProviders ?? [];
  return (
    <AuthFrame footer={<LanguagePicker />}>
      <h1 className="text-[17px] font-semibold">
        {t('auth.signInTitle', { org: status.data?.orgName ?? 'DojoHub' })}
      </h1>
      <p className="mt-1 text-[13px] text-muted">{t('auth.signInSubtitle')}</p>
      <div className="mt-5 space-y-2">
        {providers.map((p) => (
          <Button
            key={p.providerId}
            size="lg"
            className="w-full"
            loading={busy === p.providerId}
            icon={<ShieldCheck className="h-4 w-4" />}
            onClick={() => sso({ providerId: p.providerId })}
          >
            {t('auth.withSso', { name: p.name })}
          </Button>
        ))}
      </div>
      {providers.length > 0 && (
        <form
          className="mt-3 flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void sso({ email });
          }}
        >
          <Input
            type="email"
            placeholder={t('auth.workEmail')}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9"
          />
          <Button
            type="submit"
            size="lg"
            variant="outline"
            loading={busy === 'sso'}
            aria-label={t('auth.ssoByEmail')}
          >
            <ArrowRight className="h-4 w-4" />
          </Button>
        </form>
      )}
      {status.data?.localAuth && (
        <>
          {providers.length > 0 && (
            <div className="my-5 flex items-center gap-3 text-[12px] text-subtle">
              <div className="h-px flex-1 bg-border" />
              {t('auth.or')}
              <div className="h-px flex-1 bg-border" />
            </div>
          )}
          <form onSubmit={local} className={providers.length ? 'space-y-3' : 'mt-5 space-y-3'}>
            <Field label={t('common.email')}>
              <Input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="h-9"
              />
            </Field>
            <Field label={t('common.password')}>
              <Input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="h-9"
              />
            </Field>
            <Button
              type="submit"
              variant="primary"
              size="lg"
              className="w-full"
              loading={busy === 'local'}
              icon={<KeyRound className="h-4 w-4" />}
            >
              {busy === 'local' ? t('auth.signingIn') : t('auth.signIn')}
            </Button>
          </form>
        </>
      )}
      {error && (
        <p className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">
          {error === 'sso' ? t('common.error') : error}
        </p>
      )}
    </AuthFrame>
  );
}

export function SetupPage() {
  const { t, i18n } = useTranslation();
  const search = useSearch({ from: '/setup' });
  const [orgName, setOrgName] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api.post('setup', {
        token: search.token,
        orgName,
        admin: { name, email, password },
        locale: i18n.language,
      });
      const res = await authClient.signIn.email({ email, password });
      if (res.error) throw new Error(res.error.message);
      window.location.href = '/onboarding';
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  };

  return (
    <AuthFrame footer={<LanguagePicker />}>
      <h1 className="text-[17px] font-semibold">{t('setup.title')}</h1>
      <p className="mt-1 text-[13px] text-muted">{t('setup.subtitle')}</p>
      <form onSubmit={submit} className="mt-5 space-y-3">
        <Field label={t('setup.orgName')}>
          <Input
            required
            autoFocus
            value={orgName}
            onChange={(e) => setOrgName(e.target.value)}
            placeholder={t('setup.orgNamePlaceholder')}
            className="h-9"
          />
        </Field>
        <Field label={t('common.language')}>
          <Select value={i18n.language} onChange={(e) => setLocale(e.target.value as Locale)} className="h-9">
            {LOCALES.map((l) => (
              <option key={l} value={l}>
                {LOCALE_LABELS[l]}
              </option>
            ))}
          </Select>
        </Field>
        <div className="pt-2">
          <div className="text-[13px] font-medium">{t('setup.adminTitle')}</div>
          <p className="text-[12px] text-subtle">{t('setup.adminHint')}</p>
        </div>
        <Field label={t('setup.fullName')}>
          <Input required value={name} onChange={(e) => setName(e.target.value)} className="h-9" />
        </Field>
        <Field label={t('common.email')}>
          <Input
            type="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            className="h-9"
          />
        </Field>
        <Field label={t('common.password')} hint={t('setup.passwordHint')}>
          <Input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            className="h-9"
          />
        </Field>
        <Button type="submit" variant="primary" size="lg" className="w-full" loading={busy}>
          {t('setup.finish')}
        </Button>
        {!search.token && <p className="text-[12px] text-subtle">{t('setup.tokenMissing')}</p>}
        {error && <p className="rounded-md bg-danger/10 px-3 py-2 text-[12.5px] text-danger">{error}</p>}
      </form>
    </AuthFrame>
  );
}

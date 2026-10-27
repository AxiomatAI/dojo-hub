import type { Me, ReviewDto } from '@dojohub/contract';
import { LOCALE_LABELS, LOCALES, type Locale } from '@dojohub/i18n';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { Command } from 'cmdk';
import {
  BarChart3,
  Bell,
  BookOpen,
  Boxes,
  Compass,
  GitBranch,
  Home,
  Inbox,
  Languages,
  LogOut,
  Menu as MenuIcon,
  Monitor,
  Moon,
  Plus,
  Search,
  Settings,
  Shield,
  Sun,
  Terminal,
  Users,
  X,
} from 'lucide-react';
import { createContext, type ReactNode, useContext, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../lib/api';
import { authClient } from '../lib/auth';
import { relativeTime } from '../lib/format';
import { setLocale } from '../lib/i18n';
import { cn } from '../lib/utils';
import { Avatar, Kbd, Menu, MenuContent, MenuItem, MenuLabel, MenuSeparator, MenuTrigger } from './ui';

export const MeContext = createContext<Me | null>(null);
export function useMe(): Me {
  const me = useContext(MeContext);
  if (!me) throw new Error('useMe outside of app shell');
  return me;
}
export const isAdmin = (me: Me) => me.permissions.includes('org.admin');

export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="var(--accent)" />
      <path d="M9 10h14M11 10v13M21 10v13M8 15h16" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

type Theme = 'system' | 'light' | 'dark';
function applyTheme(t: Theme) {
  try {
    localStorage.setItem('dojo.theme', t);
  } catch {
    /* ignore */
  }
  const dark = t === 'dark' || (t === 'system' && matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.classList.toggle('dark', dark);
}

function NavItem({
  to,
  icon,
  label,
  badge,
  exact,
  onClick,
}: {
  to: string;
  icon: ReactNode;
  label: string;
  badge?: number;
  exact?: boolean;
  onClick?: () => void;
}) {
  const path = useRouterState({ select: (s) => s.location.pathname });
  const active = exact ? path === to : path === to || path.startsWith(`${to}/`);
  return (
    <Link
      to={to}
      onClick={onClick}
      className={cn(
        'flex h-7 items-center gap-2 rounded-md px-2 text-[13px] transition-colors',
        active ? 'bg-panel-hover font-medium text-fg' : 'text-muted hover:bg-panel-hover hover:text-fg',
      )}
    >
      <span className={cn('flex h-4 w-4 items-center justify-center', active ? 'text-fg' : 'text-subtle')}>
        {icon}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {!!badge && (
        <span className="rounded-full bg-accent px-1.5 text-[10.5px] font-semibold text-accent-fg">
          {badge}
        </span>
      )}
    </Link>
  );
}

function Sidebar({ me, onNavigate }: { me: Me; onNavigate?: () => void }) {
  const { t } = useTranslation();
  const reviews = useQuery({
    queryKey: ['reviews', 'assigned'],
    queryFn: () => api.get<ReviewDto[]>('reviews?status=pending&assigned=true'),
    refetchInterval: 60_000,
  });
  return (
    <nav className="flex h-full flex-col gap-4 px-2.5 py-3">
      <Link to="/" className="flex items-center gap-2 px-1.5" onClick={onNavigate}>
        <Logo className="h-6 w-6" />
        <div className="min-w-0">
          <div className="truncate text-[13.5px] font-semibold leading-tight">{me.orgName || 'DojoHub'}</div>
          <div className="text-[11px] leading-tight text-subtle">DojoHub · 道場</div>
        </div>
      </Link>
      <Link
        to="/submit"
        onClick={onNavigate}
        className="flex h-8 items-center gap-2 rounded-md border border-border bg-panel px-2.5 text-[13px] font-medium shadow-sm hover:bg-panel-hover"
      >
        <Plus className="h-4 w-4 text-accent" />
        {t('nav.submit')}
      </Link>
      <div className="space-y-0.5">
        <NavItem
          to="/"
          exact
          icon={<Home className="h-4 w-4" />}
          label={t('nav.home')}
          onClick={onNavigate}
        />
        <NavItem
          to="/skills"
          icon={<Compass className="h-4 w-4" />}
          label={t('nav.discover')}
          onClick={onNavigate}
        />
        <NavItem
          to="/suites"
          icon={<Boxes className="h-4 w-4" />}
          label={t('nav.suites')}
          onClick={onNavigate}
        />
        <NavItem
          to="/teams"
          icon={<Users className="h-4 w-4" />}
          label={t('nav.teams')}
          onClick={onNavigate}
        />
        <NavItem
          to="/reviews"
          icon={<Inbox className="h-4 w-4" />}
          label={t('nav.reviews')}
          badge={reviews.data?.length}
          onClick={onNavigate}
        />
      </div>
      <div>
        <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
          {t('nav.governance')}
        </div>
        <div className="space-y-0.5">
          <NavItem
            to="/sources"
            icon={<GitBranch className="h-4 w-4" />}
            label={t('nav.sources')}
            onClick={onNavigate}
          />
          <NavItem
            to="/dashboard"
            icon={<BarChart3 className="h-4 w-4" />}
            label={t('nav.dashboard')}
            onClick={onNavigate}
          />
          {(isAdmin(me) || me.permissions.includes('audit.read')) && (
            <NavItem
              to="/admin"
              icon={<Shield className="h-4 w-4" />}
              label={t('nav.admin')}
              onClick={onNavigate}
            />
          )}
        </div>
      </div>
      {me.namespaces.length > 0 && (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="px-2 pb-1 text-[11px] font-medium tracking-wide text-subtle uppercase">
            {t('nav.myTeams')}
          </div>
          <div className="space-y-0.5">
            {me.namespaces.map((n) => (
              <NavItem
                key={n.id}
                to={`/teams/${n.slug}`}
                icon={<span className="h-2 w-2 rounded-sm bg-subtle" />}
                label={n.displayName}
                onClick={onNavigate}
              />
            ))}
          </div>
        </div>
      )}
      <div className="mt-auto space-y-0.5">
        <NavItem
          to="/connect"
          icon={<Terminal className="h-4 w-4" />}
          label={t('nav.connect')}
          onClick={onNavigate}
        />
        <a
          href="/api/docs"
          target="_blank"
          rel="noreferrer"
          className="flex h-7 items-center gap-2 rounded-md px-2 text-[13px] text-muted hover:bg-panel-hover hover:text-fg"
        >
          <BookOpen className="h-4 w-4 text-subtle" />
          {t('nav.apiDocs')}
        </a>
      </div>
    </nav>
  );
}

function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (v: boolean) => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['palette', q],
    queryFn: () =>
      api.get<{ items: { name: string; displayName: string; namespace: string; summary: string }[] }>(
        `skills?q=${encodeURIComponent(q)}&pageSize=8`,
      ),
    enabled: open && q.length > 0,
  });
  const go = (to: string) => {
    onOpenChange(false);
    setQ('');
    void navigate({ to });
  };
  if (!open) return null;
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: backdrop click closes the palette; Escape is handled by cmdk
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[14vh] backdrop-blur-[2px]"
      onMouseDown={() => onOpenChange(false)}
    >
      <Command
        className="animate-in w-full max-w-xl overflow-hidden rounded-xl border border-border bg-panel shadow-float"
        onMouseDown={(e) => e.stopPropagation()}
        shouldFilter={false}
        onKeyDown={(e) => e.key === 'Escape' && onOpenChange(false)}
      >
        <div className="flex items-center gap-2 border-b border-border px-3">
          <Search className="h-4 w-4 text-subtle" />
          <Command.Input
            autoFocus
            value={q}
            onValueChange={setQ}
            placeholder={t('skills.searchPlaceholder')}
            className="h-11 flex-1 bg-transparent text-[14px] outline-none placeholder:text-subtle"
          />
          <Kbd>esc</Kbd>
        </div>
        <Command.List className="max-h-[50vh] overflow-y-auto p-1.5">
          {q && results.data?.items.length === 0 && (
            <Command.Empty className="px-3 py-6 text-center text-[13px] text-muted">
              {t('common.noResults')}
            </Command.Empty>
          )}
          {!!results.data?.items.length && (
            <Command.Group
              heading={t('nav.skills')}
              className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-subtle"
            >
              {results.data.items.map((s) => (
                <Command.Item
                  key={s.name}
                  value={s.name}
                  onSelect={() => go(`/skills/${s.name}`)}
                  className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 data-[selected=true]:bg-panel-hover"
                >
                  <span className="font-medium">{s.displayName}</span>
                  <span className="truncate text-[12px] text-subtle">@{s.namespace}</span>
                </Command.Item>
              ))}
            </Command.Group>
          )}
          <Command.Group
            heading={t('common.open')}
            className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1 [&_[cmdk-group-heading]]:text-[11px] [&_[cmdk-group-heading]]:text-subtle"
          >
            {[
              ['/submit', t('nav.submit'), <Plus key="p" className="h-4 w-4" />],
              ['/skills', t('nav.discover'), <Compass key="c" className="h-4 w-4" />],
              ['/reviews', t('nav.reviews'), <Inbox key="i" className="h-4 w-4" />],
              ['/teams', t('nav.teams'), <Users key="u" className="h-4 w-4" />],
              ['/sources/new', t('sources.new'), <GitBranch key="g" className="h-4 w-4" />],
              ['/dashboard', t('nav.dashboard'), <BarChart3 key="b" className="h-4 w-4" />],
              ['/settings', t('nav.settings'), <Settings key="s" className="h-4 w-4" />],
            ].map(([to, label, icon]) => (
              <Command.Item
                key={to as string}
                value={label as string}
                onSelect={() => go(to as string)}
                className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-muted data-[selected=true]:bg-panel-hover data-[selected=true]:text-fg"
              >
                {icon}
                {label}
              </Command.Item>
            ))}
          </Command.Group>
        </Command.List>
      </Command>
    </div>
  );
}

function Notifications() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const q = useQuery({
    queryKey: ['notifications'],
    queryFn: () =>
      api.get<
        {
          id: string;
          title: string;
          body: string | null;
          link: string | null;
          readAt: string | null;
          createdAt: string;
        }[]
      >('notifications'),
    refetchInterval: 60_000,
  });
  const unread = q.data?.filter((n) => !n.readAt).length ?? 0;
  const navigate = useNavigate();
  return (
    <Menu>
      <MenuTrigger
        className="relative flex h-8 w-8 items-center justify-center rounded-md text-muted hover:bg-panel-hover hover:text-fg"
        aria-label={t('settings.notifications')}
      >
        <Bell className="h-4 w-4" />
        {unread > 0 && (
          <span className="absolute top-1.5 right-1.5 h-2 w-2 rounded-full bg-accent ring-2 ring-bg" />
        )}
      </MenuTrigger>
      <MenuContent className="w-[360px] p-0">
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="text-[13px] font-semibold">{t('settings.notifications')}</span>
          {unread > 0 && (
            <button
              type="button"
              className="text-[12px] text-accent"
              onClick={async () => {
                await api.post('notifications/read', {});
                await qc.invalidateQueries({ queryKey: ['notifications'] });
              }}
            >
              {t('settings.markAllRead')}
            </button>
          )}
        </div>
        <div className="max-h-96 overflow-y-auto">
          {!q.data?.length && (
            <p className="px-3 py-6 text-center text-[13px] text-muted">{t('settings.noNotifications')}</p>
          )}
          {q.data?.map((n) => (
            <MenuItem
              key={n.id}
              onSelect={async () => {
                await api.post('notifications/read', { ids: [n.id] });
                void qc.invalidateQueries({ queryKey: ['notifications'] });
                if (n.link) void navigate({ to: n.link });
              }}
            >
              <div className="flex w-full gap-2 py-0.5">
                <span
                  className={cn(
                    'mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full',
                    n.readAt ? 'bg-transparent' : 'bg-accent',
                  )}
                />
                <div className="min-w-0">
                  <div className="truncate text-[13px]">{n.title}</div>
                  {n.body && <div className="truncate text-[12px] text-muted">{n.body}</div>}
                  <div className="text-[11px] text-subtle">{relativeTime(n.createdAt)}</div>
                </div>
              </div>
            </MenuItem>
          ))}
        </div>
      </MenuContent>
    </Menu>
  );
}

function UserMenu({ me }: { me: Me }) {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem('dojo.theme') as Theme) ?? 'system');
  return (
    <Menu>
      <MenuTrigger
        className="flex items-center gap-2 rounded-md p-1 hover:bg-panel-hover"
        aria-label={me.name}
      >
        <Avatar name={me.name} image={me.image} size={24} />
      </MenuTrigger>
      <MenuContent className="w-60">
        <div className="px-2 py-1.5">
          <div className="truncate text-[13px] font-medium">{me.name}</div>
          <div className="truncate text-[12px] text-subtle">{me.email}</div>
          <div className="mt-0.5 text-[11.5px] text-subtle">{t(`roles.${me.role}`)}</div>
        </div>
        <MenuSeparator />
        <MenuItem icon={<Settings className="h-4 w-4" />} onSelect={() => navigate({ to: '/settings' })}>
          {t('nav.settings')}
        </MenuItem>
        <MenuSeparator />
        <MenuLabel>
          <span className="flex items-center gap-1">
            <Languages className="h-3 w-3" /> {t('common.language')}
          </span>
        </MenuLabel>
        {LOCALES.map((l) => (
          <MenuItem
            key={l}
            onSelect={() => {
              setLocale(l as Locale);
              void api.patch('me', { locale: l });
            }}
          >
            <span className={cn('flex-1', i18n.language === l && 'font-medium text-accent')}>
              {LOCALE_LABELS[l]}
            </span>
          </MenuItem>
        ))}
        <MenuSeparator />
        <div className="flex gap-1 px-1 py-1">
          {(
            [
              ['system', <Monitor key="m" className="h-3.5 w-3.5" />],
              ['light', <Sun key="s" className="h-3.5 w-3.5" />],
              ['dark', <Moon key="d" className="h-3.5 w-3.5" />],
            ] as const
          ).map(([v, icon]) => (
            <button
              type="button"
              key={v}
              onClick={() => {
                setTheme(v);
                applyTheme(v);
              }}
              className={cn(
                'flex flex-1 items-center justify-center rounded-md py-1.5 text-muted hover:bg-panel-hover',
                theme === v && 'bg-panel-hover text-fg',
              )}
              aria-label={v}
            >
              {icon}
            </button>
          ))}
        </div>
        <MenuSeparator />
        <MenuItem
          icon={<LogOut className="h-4 w-4" />}
          onSelect={async () => {
            await authClient.signOut();
            window.location.href = '/login';
          }}
        >
          {t('nav.signOut')}
        </MenuItem>
      </MenuContent>
    </Menu>
  );
}

export function AppShell({ me }: { me: Me }) {
  const { t } = useTranslation();
  const [palette, setPalette] = useState(false);
  const [mobileNav, setMobileNav] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPalette((p) => !p);
      }
      if (
        e.key === '/' &&
        !['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName) &&
        !(e.target as HTMLElement).isContentEditable
      ) {
        e.preventDefault();
        setPalette(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  return (
    <MeContext.Provider value={me}>
      <div className="flex h-full">
        <aside className="hidden w-[232px] shrink-0 border-r border-border bg-bg-subtle md:block">
          <Sidebar me={me} />
        </aside>
        {mobileNav && (
          <div className="fixed inset-0 z-40 md:hidden">
            {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop for the mobile drawer */}
            <div
              className="absolute inset-0 bg-black/40"
              onClick={() => setMobileNav(false)}
              onKeyDown={() => {}}
              role="presentation"
            />
            <aside className="animate-in absolute inset-y-0 left-0 w-[260px] border-r border-border bg-bg-subtle">
              <button
                type="button"
                className="absolute top-3 right-3 rounded p-1 text-subtle"
                onClick={() => setMobileNav(false)}
                aria-label={t('common.close')}
              >
                <X className="h-4 w-4" />
              </button>
              <Sidebar me={me} onNavigate={() => setMobileNav(false)} />
            </aside>
          </div>
        )}
        <div className="flex min-w-0 flex-1 flex-col">
          <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3 md:px-5">
            <button
              type="button"
              className="rounded p-1.5 text-muted hover:bg-panel-hover md:hidden"
              onClick={() => setMobileNav(true)}
              aria-label="Menu"
            >
              <MenuIcon className="h-4 w-4" />
            </button>
            <button
              type="button"
              onClick={() => setPalette(true)}
              className="flex h-8 w-full max-w-md items-center gap-2 rounded-md border border-border bg-bg-subtle px-2.5 text-[13px] text-subtle transition-colors hover:border-border-strong"
            >
              <Search className="h-3.5 w-3.5" />
              <span className="flex-1 text-left">{t('nav.search')}</span>
              <Kbd>⌘K</Kbd>
            </button>
            <div className="ml-auto flex items-center gap-1">
              <Notifications />
              <UserMenu me={me} />
            </div>
          </header>
          <main className="min-h-0 flex-1 overflow-y-auto">
            <div className="mx-auto w-full max-w-[1180px] px-4 py-6 md:px-8 md:py-8">
              <Outlet />
            </div>
          </main>
        </div>
      </div>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </MeContext.Provider>
  );
}

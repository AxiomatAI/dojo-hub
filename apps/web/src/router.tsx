import type { Me, SetupStatus } from '@dojohub/contract';
import type { QueryClient } from '@tanstack/react-query';
import {
  createRootRouteWithContext,
  createRoute,
  createRouter,
  Outlet,
  redirect,
} from '@tanstack/react-router';
import { AppShell } from './components/shell';
import { ApiError, api } from './lib/api';
import { AdminPage } from './pages/admin';
import { LoginPage, SetupPage } from './pages/auth';
import { ConnectPage, DevicePage } from './pages/connect';
import { DashboardPage } from './pages/dashboard';
import { HomePage } from './pages/home';
import { OnboardingPage } from './pages/onboarding';
import { ReviewDetailPage, ReviewsPage } from './pages/reviews';
import { SettingsPage } from './pages/settings';
import { SkillDetailPage, SkillDiffPage, VersionPage } from './pages/skill';
import { SkillsPage } from './pages/skills';
import { NewSourcePage, SourceDetailPage, SourcesPage } from './pages/sources';
import { SubmitPage } from './pages/submit';
import { SuiteDetailPage, SuitesPage } from './pages/suites';
import { TeamDetailPage, TeamsPage } from './pages/teams';

const root = createRootRouteWithContext<{ queryClient: QueryClient }>()({ component: () => <Outlet /> });

const login = createRoute({
  getParentRoute: () => root,
  path: '/login',
  component: LoginPage,
  validateSearch: (s: Record<string, unknown>): { redirect?: string; error?: string } => ({
    redirect: (s.redirect as string) ?? undefined,
    error: (s.error as string) ?? undefined,
  }),
});
const setup = createRoute({
  getParentRoute: () => root,
  path: '/setup',
  component: SetupPage,
  validateSearch: (s: Record<string, unknown>): { token?: string } => ({
    token: (s.token as string) ?? undefined,
  }),
});

const app = createRoute({
  getParentRoute: () => root,
  id: 'app',
  beforeLoad: async ({ context, location }) => {
    try {
      const me = await context.queryClient.fetchQuery({
        queryKey: ['me'],
        queryFn: () => api.get<Me>('me'),
        staleTime: 60_000,
      });
      return { me };
    } catch (err) {
      if (err instanceof ApiError && err.status === 401) {
        const status = await api.get<SetupStatus>('setup/status').catch(() => null);
        if (status?.needsSetup) throw redirect({ to: '/setup', search: { token: undefined } });
        throw redirect({ to: '/login', search: { redirect: location.href, error: undefined } });
      }
      throw err;
    }
  },
  component: function AppLayout() {
    const { me } = app.useRouteContext();
    return <AppShell me={me} />;
  },
});

const r = <P extends string>(
  path: P,
  component: () => React.ReactNode,
  search?: (s: Record<string, unknown>) => Record<string, unknown>,
) =>
  createRoute({ getParentRoute: () => app, path, component, ...(search ? { validateSearch: search } : {}) });

const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);

const routeTree = root.addChildren([
  login,
  setup,
  app.addChildren([
    r('/', HomePage),
    r('/skills', SkillsPage, (s) => ({
      q: str(s.q),
      team: str(s.team),
      status: str(s.status),
      risk: str(s.risk),
      sort: str(s.sort),
      mine: s.mine === true || s.mine === 'true' ? true : undefined,
    })),
    r('/skills/$name', SkillDetailPage, (s) => ({ tab: str(s.tab) })),
    r('/skills/$name/versions/$version', VersionPage, (s) => ({ file: str(s.file) })),
    r('/skills/$name/diff', SkillDiffPage, (s) => ({ from: str(s.from), to: str(s.to) })),
    r('/suites', SuitesPage),
    r('/suites/$ns/$name', SuiteDetailPage),
    r('/teams', TeamsPage),
    r('/teams/$slug', TeamDetailPage, (s) => ({ tab: str(s.tab) })),
    r('/submit', SubmitPage, (s) => ({
      mode: str(s.mode),
      skill: str(s.skill),
      namespace: str(s.namespace),
    })),
    r('/reviews', ReviewsPage, (s) => ({ status: str(s.status) })),
    r('/reviews/$id', ReviewDetailPage),
    r('/sources', SourcesPage),
    r('/sources/new', NewSourcePage, (s) => ({ preset: str(s.preset), url: str(s.url) })),
    r('/sources/$id', SourceDetailPage),
    r('/dashboard', DashboardPage),
    r('/settings', SettingsPage, (s) => ({ tab: str(s.tab) })),
    r('/admin', AdminPage, (s) => ({ tab: str(s.tab) })),
    r('/connect', ConnectPage),
    r('/device', DevicePage, (s) => ({ code: str(s.code) })),
    r('/onboarding', OnboardingPage, (s) => ({ step: str(s.step) })),
  ]),
]);

export const router = createRouter({
  routeTree,
  context: { queryClient: undefined! },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}

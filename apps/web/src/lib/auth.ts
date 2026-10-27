import { ssoClient } from '@better-auth/sso/client';
import { createAuthClient } from 'better-auth/react';

export const authClient = createAuthClient({
  baseURL: window.location.origin,
  basePath: '/api/auth',
  plugins: [ssoClient()],
});

import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
  platform: 'node',
  target: 'node20',
  clean: true,
  dts: false,
  // Bundle the shared core (archive/discovery) so the published package has no workspace deps.
  noExternal: [/^@dojohub\//, 'fflate', 'yaml', 'zod', 'semver'],
  banner: { js: '#!/usr/bin/env node' },
});

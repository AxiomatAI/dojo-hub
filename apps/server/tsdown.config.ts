import { defineConfig } from 'tsdown';

export default defineConfig({
  entry: { main: 'src/main.ts' },
  format: 'esm',
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  clean: true,
  // Workspace packages ship TypeScript sources and are bundled; third-party deps stay external.
  noExternal: [/^@dojohub\//],
  dts: false,
  sourcemap: true,
});

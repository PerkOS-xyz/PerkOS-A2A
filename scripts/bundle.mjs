import { build } from 'esbuild';

await build({
  entryPoints: ['src/index.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: 'dist/index.js',
  sourcemap: true,
  external: ['openclaw'],
  banner: {
    js: 'import { createRequire as __createRequire } from "module"; const require = __createRequire(import.meta.url);'
  }
});

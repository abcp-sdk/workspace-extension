import { build } from 'esbuild'

// Bundle the extension + its TS-source dependency (`@abc-protocol/sdk` is a
// git dependency that ships raw `.ts`) into a single ESM file so the runtime
// image needs no transpiler. Node builtins stay external.
await build({
  entryPoints: ['src/main.ts'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node26',
  outfile: 'dist/main.js',
  external: [],
  banner: {
    js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);",
  },
  logLevel: 'info',
})

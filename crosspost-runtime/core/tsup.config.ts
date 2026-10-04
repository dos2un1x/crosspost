import { defineConfig } from 'tsup'

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'adapters/index': 'src/adapters/index.ts',
    'runtime/index': 'src/runtime/index.ts',
    'render/index': 'src/render-entry.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  splitting: false,
})

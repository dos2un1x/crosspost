import { defineConfig } from 'tsup'

// CrossPost · maintained by dos2un1x · https://github.com/dos2un1x/crosspost
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

import { defineConfig } from 'tsdown'
export default defineConfig(({ env }) => env?.DSH_BUILD_FACE === 'host' ? { entry: '' } : {
  entry: ['lib/types/index.js'], outDir: 'lib', format: ['esm'], platform: 'node', target: 'es2024', fixedExtension: false, dts: false, clean: false,
})

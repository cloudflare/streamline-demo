import cloudflare from '@astrojs/cloudflare'
import { defineConfig } from 'astro/config'
import { sourceWranglerConfig } from './scripts/deployment-config.mjs'

const isLocalDevelopment = process.env.STREAMLINE_LOCAL_DEV === '1'

export default defineConfig({
  output: 'server',
  adapter: cloudflare({
    configPath: isLocalDevelopment ? './wrangler.dev.jsonc' : sourceWranglerConfig,
  }),
  vite: {
    cacheDir: isLocalDevelopment ? 'node_modules/.vite-dev' : 'node_modules/.vite',
    build: {
      // Keep processed scripts external so the strict CSP never blocks small inlined bundles.
      assetsInlineLimit: 0,
    },
  },
})

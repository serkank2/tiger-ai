import { fileURLToPath } from 'node:url';
import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

// Mirror the Nuxt 4 source-dir aliases so unit tests can import app code the same
// way the app does (`~/...` and `@/...` -> app/, `~~`/`@@` -> project root).
const app = fileURLToPath(new URL('./app', import.meta.url));
const root = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '~': app,
      '@': app,
      '~~': root,
      '@@': root,
    },
  },
  test: {
    // happy-dom gives focus/scroll/DOM APIs without a full browser, so the suite
    // runs headless and never needs a live Kaplan backend.
    environment: 'happy-dom',
    include: ['test/**/*.test.ts'],
    // Installs a global vue-i18n instance into Vue Test Utils so every mount can
    // resolve useT()/useI18n() (see test/setup.ts).
    setupFiles: ['./test/setup.ts'],
    clearMocks: true,
  },
});

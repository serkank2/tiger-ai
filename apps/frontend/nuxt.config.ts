import { isLimitTopPanelEnabled } from './app/lib/runtimeFlags';

// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  // Local single-user tool: pure SPA. No SSR (xterm.js is client-only).
  ssr: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt'],
  css: ['@xterm/xterm/css/xterm.css', '~/assets/css/main.css'],
  runtimeConfig: {
    public: {
      // Use 127.0.0.1 (not localhost) to match the backend's IPv4 bind — avoids
      // the Windows localhost->::1 (IPv6) mismatch that breaks the connection.
      apiBase: process.env.KAPLAN_API_BASE || 'http://127.0.0.1:4517',
      wsBase: process.env.KAPLAN_WS_BASE || 'ws://127.0.0.1:4517',
      limitTopPanel: isLimitTopPanelEnabled(process.env.KAPLAN_LIMIT_TOP_PANEL)
    }
  },
  app: {
    head: {
      title: 'Kaplan — Terminal Manager',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }]
    }
  }
})

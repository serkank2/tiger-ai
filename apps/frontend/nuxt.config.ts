// https://nuxt.com/docs/api/configuration/nuxt-config
export default defineNuxtConfig({
  compatibilityDate: '2025-01-01',
  // Local single-user tool: pure SPA. No SSR (xterm.js is client-only).
  ssr: false,
  devtools: { enabled: false },
  modules: ['@pinia/nuxt'],
  css: ['@xterm/xterm/css/xterm.css'],
  runtimeConfig: {
    public: {
      apiBase: process.env.KAPLAN_API_BASE || 'http://localhost:4517',
      wsBase: process.env.KAPLAN_WS_BASE || 'ws://localhost:4517'
    }
  },
  app: {
    head: {
      title: 'Kaplan — Terminal Manager',
      meta: [{ name: 'viewport', content: 'width=device-width, initial-scale=1' }]
    }
  }
})

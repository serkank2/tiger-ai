<script setup lang="ts">
// Root host for the SPA. With a pages/ directory present, routing is page-driven:
// every screen renders inside the default navigation shell (layouts/default.vue).
// This component only owns app-global concerns: the live socket, the one-time
// settings/groups/theme bootstrap, and the global toast outlet.
const groups = useGroupsStore();
const settings = useSettingsStore();
const theme = useThemeStore();
const limits = useLimitsStore();
const conn = useConnectionStore();
const socket = useSocket();

let bootstrapped = false;

async function bootstrap() {
  try {
    await Promise.all([settings.load(), groups.load(), limits.load()]);
    bootstrapped = true;
  } catch (err) {
    // Backend may not be listening yet (it connects to MySQL + migrates before binding,
    // which takes a moment on `npm run dev`). Don't treat this as fatal — the watcher
    // below re-runs the bootstrap as soon as the live socket connects, so the shell
    // self-populates without a manual reload. Per-screen surfaces own their own retries.
    console.warn('[kaplan] backend not ready yet — will retry on connect', err);
  } finally {
    theme.init(settings.settings?.theme); // apply persisted theme (default if unavailable)
  }
}

onMounted(() => {
  socket.connect();
  void bootstrap();
});

// Self-heal: when the live socket (re)connects — including the first time the backend
// finishes booting after the SPA loaded — re-run the shell bootstrap so settings/groups/
// limits populate without the user reloading the page.
watch(
  () => conn.status,
  (status, prev) => {
    if (status === 'connected' && prev !== 'connected' && !bootstrapped) void bootstrap();
  },
);
</script>

<template>
  <div class="app-root">
    <NuxtLayout>
      <NuxtPage />
    </NuxtLayout>
    <NoticeToast />
    <ConfirmDialog />
  </div>
</template>

<style scoped>
.app-root {
  height: 100%;
}
</style>

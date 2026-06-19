<script setup lang="ts">
// Root host for the SPA. With a pages/ directory present, routing is page-driven:
// every screen renders inside the default navigation shell (layouts/default.vue).
// This component only owns app-global concerns: the live socket, the one-time
// settings/groups/theme bootstrap, and the global toast outlet.
const groups = useGroupsStore();
const settings = useSettingsStore();
const theme = useThemeStore();
const limits = useLimitsStore();
const socket = useSocket();

async function bootstrap() {
  try {
    await Promise.all([settings.load(), groups.load(), limits.load()]);
  } catch (err) {
    // Per-screen surfaces (e.g. the Terminals view) own their own error states;
    // here we only guard the bootstrap so theme init still runs.
    console.error('[kaplan] initial settings/groups load failed (is the backend running?)', err);
  } finally {
    theme.init(settings.settings?.theme); // apply persisted theme (default if unavailable)
  }
}

onMounted(() => {
  socket.connect();
  void bootstrap();
});
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

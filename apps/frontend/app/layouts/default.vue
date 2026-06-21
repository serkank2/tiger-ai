<script setup lang="ts">
// Application shell: persistent navigation rail + live status header wrapping the
// active page. This is the home every screen plugs into — no feature lives only in
// a floating widget or hidden modal anymore.
import { NAV_ITEMS, activeNavKey } from '~/lib/navigation';
import NavRail from '~/components/shell/NavRail.vue';
import LimitStatusBadge from '~/components/shell/LimitStatusBadge.vue';
import LimitTopPanel from '~/components/shell/LimitTopPanel.vue';
import { useT } from '~/composables/useT';

const route = useRoute();
const conn = useConnectionStore();
const config = useRuntimeConfig();
const { t } = useT();

// Localized nav entries: translate `label` via the item's `labelKey`, keeping the
// English `label` as the fallback for any missing key.
const navItems = computed(() =>
  NAV_ITEMS.map((item) => ({ ...item, label: t(item.labelKey) })),
);

const activeKey = computed(() => activeNavKey(route.path));
const showLimitTopPanel = computed(() => Boolean(config.public.limitTopPanel));
const sectionTitle = computed(() => {
  const item = NAV_ITEMS.find((i) => i.key === activeKey.value);
  return item ? t(item.labelKey) : 'Kaplan';
});

const connLabel = computed(() => {
  switch (conn.status) {
    case 'connected':
      return t('connection.live');
    case 'connecting':
      return t('connection.connecting');
    default:
      return t('connection.offline');
  }
});
</script>

<template>
  <div class="shell">
    <NavRail :items="navItems" :active-path="route.path" />

    <div class="main">
      <header class="topbar" :class="{ 'has-limit-panel': showLimitTopPanel }">
        <h1 class="section">{{ sectionTitle }}</h1>
        <span class="spacer" />
        <LimitTopPanel v-if="showLimitTopPanel" class="limit-panel-slot" />
        <span
          class="conn"
          :class="conn.status"
          :title="t('connection.backendStatus', { status: conn.status })"
          role="status"
          aria-live="polite"
        >
          <span class="dot" aria-hidden="true" />
          <span class="conn-label">{{ connLabel }}</span>
        </span>
        <LimitStatusBadge v-if="!showLimitTopPanel" />
      </header>

      <main class="content">
        <slot />
      </main>
    </div>
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: row;
  height: 100vh;
  min-height: 0;
}
.main {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
.topbar {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.topbar.has-limit-panel {
  height: auto;
  min-height: 44px;
  align-items: stretch;
  padding-block: 6px;
}
.section {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 700;
  letter-spacing: 0.2px;
  flex: none;
  align-self: center;
}
.spacer {
  flex: 1;
}
.topbar.has-limit-panel .spacer {
  display: none;
}
.limit-panel-slot {
  flex: 1;
  min-width: 0;
}
.conn {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  font-size: var(--text-xs);
  color: var(--text-dim);
  padding: 4px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  flex: none;
}
.topbar.has-limit-panel .conn {
  align-self: flex-start;
  margin-top: 2px;
}
.conn .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
}
.conn.connected .dot {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.conn.connecting .dot {
  background: var(--amber);
  animation: blink 1s infinite;
}
.conn.disconnected .dot {
  background: var(--red);
}
.content {
  flex: 1;
  min-height: 0;
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}

@media (max-width: 820px) {
  .shell {
    flex-direction: column;
  }
  .topbar.has-limit-panel {
    min-height: 128px;
    flex-wrap: wrap;
    padding: 8px 12px;
  }
  .topbar.has-limit-panel .section {
    max-width: calc(100% - 84px);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .topbar.has-limit-panel .limit-panel-slot {
    order: 3;
    flex-basis: 100%;
  }
  .conn-label {
    display: none;
  }
}
</style>

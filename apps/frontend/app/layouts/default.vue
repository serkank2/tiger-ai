<script setup lang="ts">
// Application shell: persistent navigation rail + live status header wrapping the
// active page. This is the home every screen plugs into — no feature lives only in
// a floating widget or hidden modal anymore.
import { NAV_ITEMS, activeNavKey } from '~/lib/navigation';
import NavRail from '~/components/shell/NavRail.vue';
import LimitStatusBadge from '~/components/shell/LimitStatusBadge.vue';
import { useT } from '~/composables/useT';

const route = useRoute();
const conn = useConnectionStore();
const { t } = useT();

// Localized nav entries: translate `label` via the item's `labelKey`, keeping the
// English `label` as the fallback for any missing key.
const navItems = computed(() =>
  NAV_ITEMS.map((item) => ({ ...item, label: t(item.labelKey) })),
);

const activeKey = computed(() => activeNavKey(route.path));
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
      <header class="topbar">
        <h1 class="section">{{ sectionTitle }}</h1>
        <span class="spacer" />
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
        <!-- Compact limit-status slot -->
        <LimitStatusBadge />
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
.section {
  margin: 0;
  font-size: var(--text-md);
  font-weight: 700;
  letter-spacing: 0.2px;
}
.spacer {
  flex: 1;
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
  .conn-label {
    display: none;
  }
}
</style>

<script setup lang="ts">
// Primary navigation rail. Pure/presentational: it takes the item list and the
// active path as props so it renders identically in the app and in unit tests
// (no router/composable dependency). The default layout supplies both.
import type { NavItem } from '~/lib/navigation';

defineProps<{ items: NavItem[]; activePath: string }>();

function isActive(item: NavItem, path: string): boolean {
  return path === item.to || path.startsWith(`${item.to}/`);
}

const { t } = useT();
</script>

<template>
  <nav class="rail" aria-label="Primary">
    <NuxtLink to="/terminals" class="brand" :aria-label="t('nav.home')">
      <span class="logo">🐅</span>
      <span class="word">Kaplan</span>
    </NuxtLink>
    <ul class="items">
      <li v-for="item in items" :key="item.key">
        <NuxtLink
          :to="item.to"
          class="item"
          :class="{ active: isActive(item, activePath) }"
          :title="item.hint"
          :aria-current="isActive(item, activePath) ? 'page' : undefined"
        >
          <span class="icon" aria-hidden="true">{{ item.icon }}</span>
          <span class="label">{{ item.label }}</span>
        </NuxtLink>
      </li>
    </ul>
  </nav>
</template>

<style scoped>
.rail {
  width: 212px;
  flex: none;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border-right: 1px solid var(--border);
  padding: 12px 10px;
  gap: 10px;
  min-height: 0;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px 12px;
  border-bottom: 1px solid var(--border);
  text-decoration: none;
  color: var(--text);
}
.logo {
  font-size: 22px;
}
.word {
  font-weight: 700;
  font-size: var(--text-md);
  letter-spacing: 0.2px;
}
.items {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  overflow-y: auto;
  min-height: 0;
}
.item {
  display: flex;
  align-items: center;
  gap: 11px;
  padding: 9px 11px;
  border-radius: var(--radius-sm);
  color: var(--text-dim);
  text-decoration: none;
  font-size: var(--text-sm);
  font-weight: 600;
  border: 1px solid transparent;
  transition:
    background-color var(--dur-fast) var(--ease-standard),
    color var(--dur-fast) var(--ease-standard);
}
.item:hover {
  color: var(--text);
  background: var(--bg-elev-2);
}
.item:focus-visible,
.brand:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
.item.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: var(--accent);
}
.icon {
  font-size: 16px;
  width: 20px;
  text-align: center;
  flex: none;
}
.label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Mobile: collapse to a horizontal scrolling bar, labels hidden to save space. */
@media (max-width: 820px) {
  .rail {
    width: 100%;
    flex-direction: row;
    align-items: center;
    border-right: none;
    border-bottom: 1px solid var(--border);
    padding: 8px 10px;
    gap: 8px;
    overflow-x: auto;
  }
  .brand {
    border-bottom: none;
    border-right: 1px solid var(--border);
    padding: 4px 12px 4px 4px;
    flex: none;
  }
  .word {
    display: none;
  }
  .items {
    flex-direction: row;
    overflow-x: auto;
    overflow-y: visible;
    gap: 6px;
    flex: 1;
  }
  .item {
    padding: 8px 10px;
  }
  .item .label {
    display: none;
  }
}
</style>

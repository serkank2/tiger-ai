<script setup lang="ts">
import { computed, nextTick, watch } from 'vue';

export interface BaseTab {
  id: string;
  label: string;
}

const props = withDefaults(
  defineProps<{
    modelValue?: string | null;
    tabs?: readonly BaseTab[];
    label: string;
    idPrefix?: string;
    panelClass?: string;
  }>(),
  {
    modelValue: null,
    tabs: () => [],
    idPrefix: 'base-tabs',
    panelClass: '',
  },
);

const emit = defineEmits<{ 'update:modelValue': [string] }>();

const tabItems = computed(() => props.tabs.filter((tab) => tab.id));
const activeId = computed(() => {
  if (props.modelValue && tabItems.value.some((tab) => tab.id === props.modelValue)) {
    return props.modelValue;
  }
  return tabItems.value[0]?.id ?? '';
});
const activeTab = computed(() => tabItems.value.find((tab) => tab.id === activeId.value) ?? null);

watch(
  activeId,
  (id) => {
    if (id && id !== props.modelValue) emit('update:modelValue', id);
  },
  { immediate: true },
);

function tabId(tab: BaseTab): string {
  return `${props.idPrefix}-tab-${tab.id}`;
}

function panelId(tab: BaseTab): string {
  return `${props.idPrefix}-panel-${tab.id}`;
}

async function selectTab(tab: BaseTab, focus = false): Promise<void> {
  if (!tabItems.value.some((item) => item.id === tab.id)) return;
  emit('update:modelValue', tab.id);
  if (!focus) return;
  await nextTick();
  document.getElementById(tabId(tab))?.focus();
}

function onTabKeydown(ev: KeyboardEvent, tab: BaseTab): void {
  const idx = tabItems.value.findIndex((item) => item.id === tab.id);
  if (idx < 0) return;

  let next = idx;
  if (ev.key === 'ArrowRight') next = (idx + 1) % tabItems.value.length;
  else if (ev.key === 'ArrowLeft') next = (idx - 1 + tabItems.value.length) % tabItems.value.length;
  else if (ev.key === 'Home') next = 0;
  else if (ev.key === 'End') next = tabItems.value.length - 1;
  else return;

  ev.preventDefault();
  const nextTab = tabItems.value[next];
  if (nextTab) void selectTab(nextTab, true);
}
</script>

<template>
  <div class="base-tabs">
    <div class="base-tabs-list" role="tablist" :aria-label="label">
      <button
        v-for="tab in tabItems"
        :id="tabId(tab)"
        :key="tab.id"
        type="button"
        class="base-tabs-tab"
        :class="{ active: activeId === tab.id }"
        role="tab"
        :aria-selected="activeId === tab.id"
        :aria-controls="panelId(tab)"
        :tabindex="activeId === tab.id ? 0 : -1"
        @click="selectTab(tab)"
        @keydown="onTabKeydown($event, tab)"
      >
        <slot name="tab" :tab="tab" :active="activeId === tab.id">{{ tab.label }}</slot>
      </button>
    </div>

    <section
      v-if="activeTab"
      :id="panelId(activeTab)"
      class="base-tabs-panel"
      :class="panelClass"
      role="tabpanel"
      :aria-labelledby="tabId(activeTab)"
    >
      <slot :name="activeTab.id" :tab="activeTab" />
    </section>
  </div>
</template>

<style scoped>
.base-tabs {
  min-width: 0;
  min-height: 0;
  display: grid;
  grid-template-rows: auto minmax(0, 1fr);
  gap: 10px;
}
.base-tabs-list {
  display: inline-flex;
  justify-self: start;
  max-width: 100%;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.base-tabs-tab {
  border-radius: 0;
  border-right: 1px solid var(--border);
  padding: 7px 14px;
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
}
.base-tabs-tab:last-child {
  border-right: 0;
}
.base-tabs-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
}
.base-tabs-tab:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.base-tabs-panel {
  min-width: 0;
  min-height: 0;
}
</style>

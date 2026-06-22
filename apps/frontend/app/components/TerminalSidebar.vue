<script setup lang="ts">
import type { TerminalDto } from '~/types';
import IconTrash from '~/components/IconTrash.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const emit = defineEmits<{ create: []; edit: [terminal: TerminalDto] }>();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const { t } = useT();

// two-step confirm for bulk delete
const confirmBulk = ref(false);
let bulkTimer: ReturnType<typeof setTimeout> | null = null;
function onBulkDelete() {
  if (bulkTimer) clearTimeout(bulkTimer);
  if (confirmBulk.value) {
    confirmBulk.value = false;
    void terminals.removeSelected();
  } else {
    confirmBulk.value = true;
    bulkTimer = setTimeout(() => (confirmBulk.value = false), 2500);
  }
}
onBeforeUnmount(() => {
  if (bulkTimer) clearTimeout(bulkTimer);
});

// group terminals by groupId, ungrouped last
const sections = computed(() => {
  const map = new Map<string | null, TerminalDto[]>();
  for (const t of terminals.items) {
    const key = t.groupId && groups.byId[t.groupId] ? t.groupId : null;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(t);
  }
  const entries = [...map.entries()];
  entries.sort((a, b) => (a[0] === null ? 1 : b[0] === null ? -1 : 0));
  return entries;
});
function groupName(id: string | null) {
  return id ? groups.byId[id]?.name ?? 'Ungrouped' : 'Ungrouped';
}
function groupColor(id: string | null) {
  return (id && groups.byId[id]?.color) || 'var(--text-faint)';
}
// per-group selection (checkbox on the group header)
function groupIds(list: TerminalDto[]) {
  return list.map((t) => t.id);
}
function groupAllSelected(list: TerminalDto[]) {
  return list.length > 0 && list.every((t) => terminals.selectedIds.includes(t.id));
}
function groupSomeSelected(list: TerminalDto[]) {
  return list.some((t) => terminals.selectedIds.includes(t.id));
}
</script>

<template>
  <aside class="sidebar">
    <div class="head">
      <span class="title">Terminals<span class="count">{{ terminals.items.length }}</span></span>
      <Spinner v-if="terminals.loading && !terminals.loaded" :size="14" label="Loading" />
      <BaseButton v-else size="sm" variant="ghost" class="new" @click="emit('create')">+ New</BaseButton>
    </div>

    <div v-if="terminals.items.length" class="selbar" :class="{ active: terminals.someSelected }">
      <label class="selall">
        <input
          type="checkbox"
          :checked="terminals.allSelected"
          :indeterminate.prop="terminals.someSelected && !terminals.allSelected"
          @change="terminals.toggleSelectAll()"
        />
        <span>{{ terminals.someSelected ? t('terminals.selected', { n: terminals.selectedIds.length }) : t('terminals.selectAll') }}</span>
      </label>
      <span v-if="terminals.someSelected" class="acts">
        <BaseButton class="act" size="sm" variant="ghost" icon-only aria-label="Start selected" title="Start selected" @click="terminals.startSelected()">▶</BaseButton>
        <BaseButton class="act" size="sm" variant="ghost" icon-only aria-label="Stop selected" title="Stop selected" @click="terminals.stopSelected()">■</BaseButton>
        <BaseButton
          class="act danger"
          :class="{ confirm: confirmBulk }"
          size="sm"
          variant="ghost"
          icon-only
          :aria-label="confirmBulk ? 'Confirm delete all selected' : 'Delete selected'"
          :title="confirmBulk ? 'Click again to delete all selected' : 'Delete selected'"
          @click="onBulkDelete"
        >
          <template v-if="confirmBulk">✓?</template>
          <IconTrash v-else />
        </BaseButton>
        <BaseButton class="link" variant="ghost" @click="terminals.clearSelection()">{{ t('terminals.clear') }}</BaseButton>
      </span>
    </div>

    <div class="list">
      <div v-if="terminals.loading && !terminals.loaded" class="loading-list">
        <Skeleton v-for="i in 5" :key="i" :lines="2" class="skel-item" />
      </div>

      <template v-else>
        <template v-for="[gid, list] in sections" :key="gid ?? '__none__'">
        <div class="ghead">
          <input
            class="gchk"
            type="checkbox"
            :checked="groupAllSelected(list)"
            :indeterminate.prop="groupSomeSelected(list) && !groupAllSelected(list)"
            :title="`Select all in ${groupName(gid)}`"
            :aria-label="`Select all in ${groupName(gid)}`"
            @change="terminals.toggleGroup(groupIds(list))"
          />
          <span class="gdot" :style="{ background: groupColor(gid) }" />
          <span class="gname">{{ groupName(gid) }}</span>
          <span class="count">{{ list.length }}</span>
          <span class="gacts">
            <BaseButton class="gact" size="sm" variant="ghost" icon-only :aria-label="`Start all in ${groupName(gid)}`" :title="`Start all in ${groupName(gid)}`" @click="terminals.startMany(groupIds(list))">▶</BaseButton>
            <BaseButton class="gact" size="sm" variant="ghost" icon-only :aria-label="`Stop all in ${groupName(gid)}`" :title="`Stop all in ${groupName(gid)}`" @click="terminals.stopMany(groupIds(list))">■</BaseButton>
          </span>
        </div>
        <TerminalListItem
          v-for="term in list"
          :key="term.id"
          :terminal="term"
          :active="term.id === terminals.activeId"
          :selected="terminals.selectedIds.includes(term.id)"
          @select="terminals.setActive(term.id)"
          @toggle="terminals.toggleSelected(term.id)"
          @start="terminals.start(term.id)"
          @stop="terminals.stop(term.id)"
          @restart="terminals.restart(term.id)"
          @duplicate="terminals.duplicate(term.id)"
          @edit="emit('edit', term)"
          @remove="terminals.remove(term.id)"
        />
        </template>
      </template>

      <EmptyState v-if="!terminals.loading && !terminals.items.length" title="No terminals yet.">
        <template #actions>
          <BaseButton variant="primary" @click="emit('create')">+ Create your first terminal</BaseButton>
        </template>
      </EmptyState>
    </div>
  </aside>
</template>

<style scoped>
.sidebar {
  width: var(--sidebar-w);
  flex: none;
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  border-bottom: 1px solid var(--border);
}
.title {
  font-weight: 700;
  letter-spacing: 0.2px;
}
.count {
  display: inline-block;
  margin-left: 7px;
  padding: 1px 7px;
  font-size: 11px;
  color: var(--text-dim);
  background: var(--bg-elev-2);
  border-radius: 999px;
}
/* Header "+ New" uses BaseButton (ghost) but keeps the accent text identity. */
.new.btn {
  color: var(--accent);
}
.selbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 14px;
  font-size: 12px;
  color: var(--text-dim);
  border-bottom: 1px solid var(--border);
}
.selbar.active {
  color: var(--accent);
  background: var(--accent-soft);
  border-bottom-color: transparent;
}
.selall {
  display: flex;
  align-items: center;
  gap: 8px;
  cursor: pointer;
  user-select: none;
}
.selall input {
  accent-color: var(--accent);
  cursor: pointer;
}
.acts {
  display: flex;
  align-items: center;
  gap: 4px;
}
/* Bulk-select controls: BaseButton (ghost) keeps the accent identity; tighten size. */
.act.btn {
  width: 24px;
  height: 24px;
  font-size: 11px;
  color: var(--accent);
}
.act.danger:hover:not(:disabled),
.act.confirm {
  color: var(--red);
}
.link {
  color: var(--text-dim);
  text-decoration: underline;
  font-size: 12px;
  margin-left: 4px;
}
.list {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 16px;
}
.loading-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 14px;
}
.skel-item {
  padding: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.ghead {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 12px 14px 5px;
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-faint);
}
.gchk {
  accent-color: var(--accent);
  cursor: pointer;
  flex: none;
  margin: 0;
}
.gacts {
  display: none;
  gap: 2px;
  margin-left: 4px;
}
.ghead:hover .gacts,
.ghead:focus-within .gacts {
  display: flex;
}
/* Per-group quick actions: BaseButton (ghost), shrunk to the dense header scale. */
.gact.btn {
  width: 20px;
  height: 20px;
  font-size: 10px;
}
.gdot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex: none;
}
.gname {
  flex: 1;
}
</style>

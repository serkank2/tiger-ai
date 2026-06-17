<script setup lang="ts">
import type { TerminalDto } from '~/types';
import IconTrash from '~/components/IconTrash.vue';

const emit = defineEmits<{ create: []; edit: [terminal: TerminalDto] }>();
const terminals = useTerminalsStore();
const groups = useGroupsStore();

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
      <Spinner v-if="terminals.loading && !terminals.loaded" small label="Loading" />
      <button v-else class="new" @click="emit('create')">+ New</button>
    </div>

    <div v-if="terminals.items.length" class="selbar" :class="{ active: terminals.someSelected }">
      <label class="selall">
        <input
          type="checkbox"
          :checked="terminals.allSelected"
          :indeterminate.prop="terminals.someSelected && !terminals.allSelected"
          @change="terminals.toggleSelectAll()"
        />
        <span>{{ terminals.someSelected ? `${terminals.selectedIds.length} selected` : 'Select all' }}</span>
      </label>
      <span v-if="terminals.someSelected" class="acts">
        <button class="act" title="Start selected" @click="terminals.startSelected()">▶</button>
        <button class="act" title="Stop selected" @click="terminals.stopSelected()">■</button>
        <button
          class="act danger"
          :class="{ confirm: confirmBulk }"
          :title="confirmBulk ? 'Click again to delete all selected' : 'Delete selected'"
          @click="onBulkDelete"
        >
          <template v-if="confirmBulk">✓?</template>
          <IconTrash v-else />
        </button>
        <button class="link" @click="terminals.clearSelection()">clear</button>
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
            <button class="gact" :title="`Start all in ${groupName(gid)}`" @click="terminals.startMany(groupIds(list))">▶</button>
            <button class="gact" :title="`Stop all in ${groupName(gid)}`" @click="terminals.stopMany(groupIds(list))">■</button>
          </span>
        </div>
        <TerminalListItem
          v-for="t in list"
          :key="t.id"
          :terminal="t"
          :active="t.id === terminals.activeId"
          :selected="terminals.selectedIds.includes(t.id)"
          @select="terminals.setActive(t.id)"
          @toggle="terminals.toggleSelected(t.id)"
          @start="terminals.start(t.id)"
          @stop="terminals.stop(t.id)"
          @restart="terminals.restart(t.id)"
          @duplicate="terminals.duplicate(t.id)"
          @edit="emit('edit', t)"
          @remove="terminals.remove(t.id)"
        />
        </template>
      </template>

      <EmptyState v-if="!terminals.loading && !terminals.items.length" title="No terminals yet.">
        <button class="new" @click="emit('create')">+ Create your first terminal</button>
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
.new {
  border: 1px solid var(--border-strong);
  padding: 5px 11px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
}
.new:hover {
  background: var(--accent-soft);
  border-color: var(--accent);
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
.act {
  width: 24px;
  height: 24px;
  font-size: 11px;
  color: var(--accent);
  display: grid;
  place-items: center;
}
.act:hover {
  background: var(--bg);
}
.act.danger:hover,
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
.gact {
  width: 20px;
  height: 20px;
  font-size: 10px;
  color: var(--text-dim);
  display: grid;
  place-items: center;
  border-radius: var(--radius-sm);
}
.gact:hover {
  color: var(--accent);
  background: var(--bg);
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
:deep(.empty-state) .new {
  margin-top: 12px;
}
</style>

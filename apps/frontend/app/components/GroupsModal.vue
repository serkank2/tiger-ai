<script setup lang="ts">
import { errText } from '~/lib/apiError';

const emit = defineEmits<{ close: [] }>();
const groups = useGroupsStore();
const terminals = useTerminalsStore();
const notices = useNoticesStore();

const COLORS = ['#f59e42', '#6cc56c', '#5aa9e6', '#c08cd6', '#e5564b', '#e0b03a', '#5bc2b8', '#7c8390'];

const newName = ref('');
const newColor = ref(COLORS[0]!);
const busy = ref(false);

// two-step delete confirm (consistent with the terminal list)
const confirmingId = ref<string | null>(null);
let resetTimer: ReturnType<typeof setTimeout> | null = null;
function onDelete(id: string) {
  if (resetTimer) clearTimeout(resetTimer);
  if (confirmingId.value === id) {
    confirmingId.value = null;
    void remove(id);
  } else {
    confirmingId.value = id;
    resetTimer = setTimeout(() => (confirmingId.value = null), 2500);
  }
}
onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer);
});

async function create() {
  const name = newName.value.trim();
  if (!name) return;
  busy.value = true;
  try {
    await groups.create({ name, color: newColor.value });
    newName.value = '';
  } catch (e) {
    notices.push(errText(e), 'error');
  } finally {
    busy.value = false;
  }
}

async function rename(id: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  try {
    await groups.update(id, { name: trimmed });
  } catch (e) {
    notices.push(errText(e), 'error');
  }
}

async function remove(id: string) {
  try {
    await groups.remove(id);
    // Backend nulls the groupId of member terminals; resync the terminal list.
    await terminals.fetchAll();
    if (terminals.commandGroupId === id) {
      terminals.commandGroupId = null;
      if (terminals.commandMode === 'group') terminals.commandMode = 'selected';
    }
  } catch (e) {
    notices.push(errText(e), 'error');
  }
}
</script>

<template>
  <div class="backdrop">
    <div class="modal" role="dialog" aria-modal="true">
      <h2>Groups</h2>

      <form class="create" @submit.prevent="create">
        <input v-model="newName" placeholder="New group name" />
        <div class="swatches">
          <button
            v-for="c in COLORS"
            :key="c"
            type="button"
            class="swatch"
            :class="{ on: newColor === c }"
            :style="{ background: c }"
            @click="newColor = c"
          />
        </div>
        <button type="submit" class="primary" :disabled="busy || !newName.trim()">Add</button>
      </form>

      <ul class="list">
        <li v-for="g in groups.groups" :key="g.id">
          <span class="dot" :style="{ background: g.color || 'var(--text-faint)' }" />
          <input class="gname" :value="g.name" @change="rename(g.id, ($event.target as HTMLInputElement).value)" />
          <span class="n">{{ terminals.items.filter((t) => t.groupId === g.id).length }}</span>
          <button
            class="del"
            :class="{ confirm: confirmingId === g.id }"
            :title="confirmingId === g.id ? 'Click again to delete' : 'Delete group'"
            @click="onDelete(g.id)"
          >
            {{ confirmingId === g.id ? '✓?' : '🗑' }}
          </button>
        </li>
        <li v-if="!groups.groups.length" class="empty">No groups yet.</li>
      </ul>

      <div class="foot">
        <button class="ghost" @click="emit('close')">Done</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  z-index: 50;
  backdrop-filter: blur(2px);
}
.modal {
  width: min(480px, 92vw);
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 22px 24px;
}
h2 {
  margin: 0 0 16px;
  font-size: 18px;
}
.create {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.create input {
  flex: 1;
}
.swatches {
  display: flex;
  gap: 4px;
}
.swatch {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 2px solid transparent;
}
.swatch.on {
  border-color: var(--text);
}
.primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 7px 14px;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.list li {
  display: flex;
  align-items: center;
  gap: 9px;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: none;
}
.gname {
  flex: 1;
}
.n {
  font-size: 11px;
  color: var(--text-faint);
  min-width: 18px;
  text-align: center;
}
.del {
  width: 28px;
  height: 28px;
  color: var(--text-dim);
}
.del:hover,
.del.confirm {
  color: var(--red);
}
.empty {
  color: var(--text-faint);
  justify-content: center;
}
.foot {
  display: flex;
  justify-content: flex-end;
  margin-top: 18px;
}
.ghost {
  border: 1px solid var(--border-strong);
  padding: 8px 16px;
  color: var(--text-dim);
}
</style>

<script setup lang="ts">
import type { PromptSummary } from '~/types';

const props = defineProps<{ items: PromptSummary[]; currentPath: string | null; dirty: boolean }>();
const emit = defineEmits<{
  open: [path: string];
  create: [];
  remove: [path: string];
  rename: [from: string, to: string];
  refresh: [];
}>();

const q = ref('');
const filtered = computed(() => {
  const s = q.value.trim().toLowerCase();
  if (!s) return props.items;
  return props.items.filter(
    (p) => p.path.toLowerCase().includes(s) || (p.title ?? '').toLowerCase().includes(s) || (p.tags ?? []).some((t) => t.toLowerCase().includes(s)),
  );
});

// two-step delete confirm
const confirmingPath = ref<string | null>(null);
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
function onDelete(path: string) {
  if (confirmTimer) clearTimeout(confirmTimer);
  if (confirmingPath.value === path) {
    confirmingPath.value = null;
    emit('remove', path);
  } else {
    confirmingPath.value = path;
    confirmTimer = setTimeout(() => (confirmingPath.value = null), 2500);
  }
}

// inline rename
const renamingPath = ref<string | null>(null);
const renameValue = ref('');
function startRename(path: string) {
  renamingPath.value = path;
  renameValue.value = path;
}
function commitRename() {
  const from = renamingPath.value;
  const to = renameValue.value.trim();
  renamingPath.value = null;
  if (from && to && to !== from) emit('rename', from, to);
}
onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer);
});
</script>

<template>
  <div class="lib">
    <div class="top">
      <input v-model="q" class="search" placeholder="🔍 search prompts" spellcheck="false" />
    </div>
    <div class="actions">
      <button class="btn" @click="emit('create')">+ New</button>
      <button class="btn ghost" title="Reload from disk" @click="emit('refresh')">⟳</button>
    </div>
    <div class="list">
      <div
        v-for="p in filtered"
        :key="p.path"
        class="item"
        :class="{ active: p.path === currentPath }"
        tabindex="0"
        @click="emit('open', p.path)"
        @keydown.enter="emit('open', p.path)"
        @keydown.space.prevent="emit('open', p.path)"
      >
        <template v-if="renamingPath === p.path">
          <input
            v-model="renameValue"
            class="renameinput"
            spellcheck="false"
            @click.stop
            @keydown.enter.stop="commitRename"
            @keydown.esc.stop.prevent="renamingPath = null"
            @blur="commitRename"
          />
        </template>
        <template v-else>
          <div class="meta">
            <div class="title">
              {{ p.title || p.path }}
              <span v-if="p.path === currentPath && dirty" class="dirty" title="Unsaved changes">●</span>
            </div>
            <div class="path">{{ p.path }}</div>
            <div v-if="p.tags?.length" class="tags">
              <span v-for="(t, i) in p.tags" :key="`${t}-${i}`" class="tag">{{ t }}</span>
            </div>
          </div>
          <div class="row-actions" @click.stop>
            <button class="ic" title="Rename" @click="startRename(p.path)">✎</button>
            <button class="ic danger" :class="{ confirm: confirmingPath === p.path }" :title="confirmingPath === p.path ? 'Click again to delete' : 'Delete'" @click="onDelete(p.path)">
              {{ confirmingPath === p.path ? '✓?' : '🗑' }}
            </button>
          </div>
        </template>
      </div>
      <div v-if="!filtered.length" class="empty">{{ items.length ? 'No matches.' : 'No prompts yet. Create one →' }}</div>
    </div>
  </div>
</template>

<style scoped>
.lib { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.top { margin-bottom: 8px; }
.search { width: 100%; }
.actions { display: flex; gap: 6px; margin-bottom: 8px; }
.btn { border: 1px solid var(--border-strong); padding: 5px 10px; font-size: 12px; font-weight: 600; color: var(--accent); flex: 1; }
.btn.ghost { flex: none; color: var(--text-dim); width: 34px; }
.btn:hover { background: var(--accent-soft); border-color: var(--accent); }
.list { flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.item { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.item:hover { background: var(--bg-elev-2); }
.item.active { background: var(--accent-soft); border-left: 2px solid var(--accent); }
.meta { flex: 1; min-width: 0; }
.title { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dirty { color: var(--amber); margin-left: 4px; }
.path { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.tag { font-size: 10px; background: var(--bg-elev-2); color: var(--text-dim); border-radius: 999px; padding: 1px 7px; }
.row-actions { display: none; gap: 2px; }
.item:hover .row-actions, .item.active .row-actions, .item:focus-within .row-actions { display: flex; }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ic { width: 26px; height: 26px; font-size: 12px; color: var(--text-dim); display: grid; place-items: center; }
.ic:hover { background: var(--bg); color: var(--text); }
.ic.danger:hover, .ic.confirm { color: var(--red); }
.renameinput { width: 100%; font-family: var(--font-mono); font-size: 12px; }
.empty { padding: 18px; text-align: center; color: var(--text-faint); font-size: 13px; }
</style>

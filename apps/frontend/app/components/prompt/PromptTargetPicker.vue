<script setup lang="ts">
import type { TerminalDto } from '~/types';

const props = defineProps<{ modelValue: string[] }>();
const emit = defineEmits<{ 'update:modelValue': [ids: string[]] }>();

const terminals = useTerminalsStore();
const groups = useGroupsStore();

const dragOver = ref(false);
const status = ref('');
const collapsed = reactive<Record<string, boolean>>({});

// Terminals grouped (ungrouped last) — same shape as the sidebar.
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
const groupKey = (id: string | null) => id ?? '__none__';
const groupName = (id: string | null) => (id ? groups.byId[id]?.name ?? 'Ungrouped' : 'Ungrouped');

const selected = computed(() => new Set(props.modelValue));
const chips = computed(() => props.modelValue.map((id) => terminals.byId[id]).filter(Boolean) as TerminalDto[]);

function commit(ids: string[]) {
  // dedupe + drop unknown ids (e.g. a stray external drop), then announce the real count
  const next = [...new Set(ids)].filter((id) => terminals.byId[id]);
  emit('update:modelValue', next);
  status.value = `${next.length} terminal${next.length === 1 ? '' : 's'} selected`;
}
function addTerm(id: string) {
  if (selected.value.has(id)) return;
  if (terminals.byId[id]?.protected) {
    status.value = `${terminals.byId[id]?.name ?? 'Terminal'} is protected — excluded`;
    return;
  }
  commit([...props.modelValue, id]);
}
function termIdsOfGroup(gid: string | null): string[] {
  return terminals.items
    .filter((t) => (t.groupId && groups.byId[t.groupId] ? t.groupId : null) === gid && !t.protected)
    .map((t) => t.id);
}
function addGroup(gid: string | null) {
  commit([...props.modelValue, ...termIdsOfGroup(gid)]);
}
function remove(id: string) {
  commit(props.modelValue.filter((x) => x !== id));
}
function clearAll() {
  commit([]);
}

function onDragStart(e: DragEvent, payload: string) {
  e.dataTransfer?.setData('text/plain', payload);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = 'copy';
}
function onDrop(e: DragEvent) {
  dragOver.value = false;
  const data = e.dataTransfer?.getData('text/plain') ?? '';
  if (data.startsWith('term:')) addTerm(data.slice(5));
  else if (data.startsWith('group:')) {
    const g = data.slice(6);
    addGroup(g === '__none__' ? null : g);
  }
}
const isRunning = (t: TerminalDto) => t.status.state === 'running' || t.status.state === 'starting';
</script>

<template>
  <div class="picker">
    <div class="col-head">Available</div>
    <div class="available">
      <template v-for="[gid, list] in sections" :key="groupKey(gid)">
        <div class="ghead" draggable="true" @dragstart="onDragStart($event, `group:${groupKey(gid)}`)">
          <button class="chev" :aria-expanded="!collapsed[groupKey(gid)]" :aria-label="`${collapsed[groupKey(gid)] ? 'Expand' : 'Collapse'} ${groupName(gid)}`" @click="collapsed[groupKey(gid)] = !collapsed[groupKey(gid)]">
            {{ collapsed[groupKey(gid)] ? '▸' : '▾' }}
          </button>
          <span class="gdot" :style="{ background: (gid && groups.byId[gid]?.color) || 'var(--text-faint)' }" />
          <span class="gname">{{ groupName(gid) }}</span>
          <span class="gcount">{{ list.length }}</span>
          <button class="add" title="Add all in group" @click="addGroup(gid)" @keydown.enter.prevent="addGroup(gid)">+ all</button>
        </div>
        <template v-if="!collapsed[groupKey(gid)]">
          <div
            v-for="t in list"
            :key="t.id"
            class="trow"
            :class="{ added: selected.has(t.id), prot: t.protected }"
            :draggable="!t.protected"
            @dragstart="onDragStart($event, `term:${t.id}`)"
          >
            <span class="dot" :class="isRunning(t) ? 'on' : 'off'" />
            <span class="tname" :title="t.cwd"><span v-if="t.protected" class="lk">🔒</span>{{ t.name }}</span>
            <span v-if="t.protected" class="addedtag" title="Protected — excluded from sends">protected</span>
            <button v-else-if="!selected.has(t.id)" class="add" title="Add" @click="addTerm(t.id)">+</button>
            <span v-else class="addedtag">added</span>
          </div>
        </template>
      </template>
      <div v-if="!terminals.items.length" class="empty">No terminals yet.</div>
    </div>

    <div class="col-head row">
      <span>Send to <b>{{ chips.length }}</b></span>
      <button v-if="chips.length" class="link" @click="clearAll">clear</button>
    </div>
    <div
      class="dropzone"
      :class="{ over: dragOver }"
      @dragover.prevent="dragOver = true"
      @dragleave="dragOver = false"
      @drop.prevent="onDrop"
    >
      <div v-if="!chips.length" class="dzempty">Drop terminals or groups here, or use <b>+</b></div>
      <div v-for="t in chips" :key="t.id" class="chip">
        <span class="dot" :class="isRunning(t) ? 'on' : 'off'" />
        {{ t.name }}
        <button class="x" title="Remove" @click="remove(t.id)">✕</button>
      </div>
    </div>
    <p class="sr" aria-live="polite">{{ status }}</p>
  </div>
</template>

<style scoped>
.picker { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.col-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-faint); padding: 0 0 6px; font-weight: 700; }
.col-head.row { display: flex; justify-content: space-between; align-items: center; padding-top: 10px; }
.available { flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); min-height: 120px; }
.ghead { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: var(--bg-elev-2); cursor: grab; font-size: 12px; }
.chev { width: 16px; color: var(--text-dim); }
.gdot { width: 8px; height: 8px; border-radius: 2px; flex: none; }
.gname { flex: 1; font-weight: 600; }
.gcount { color: var(--text-faint); font-size: 11px; }
.trow { display: flex; align-items: center; gap: 8px; padding: 6px 8px 6px 22px; cursor: grab; border-top: 1px solid var(--border); font-size: 13px; }
.trow:hover { background: var(--bg-elev-2); }
.trow.added { opacity: 0.5; }
.trow.prot { opacity: 0.55; cursor: not-allowed; }
.lk { margin-right: 4px; font-size: 10px; }
.tname { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dot { width: 8px; height: 8px; border-radius: 50%; flex: none; }
.dot.on { background: var(--green); }
.dot.off { background: var(--slate, var(--text-faint)); }
.add { border: 1px solid var(--border-strong); color: var(--accent); padding: 1px 7px; font-size: 11px; border-radius: var(--radius-sm); }
.add:hover { background: var(--accent-soft); }
.addedtag { font-size: 10px; color: var(--text-faint); }
.dropzone { flex: 1; min-height: 100px; border: 1.5px dashed var(--border-strong); border-radius: var(--radius-sm); padding: 8px; display: flex; flex-wrap: wrap; gap: 6px; align-content: flex-start; overflow-y: auto; }
.dropzone.over { border-color: var(--accent); background: var(--accent-soft); }
.dzempty { color: var(--text-faint); font-size: 12px; margin: auto; text-align: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; background: var(--bg-elev-2); border: 1px solid var(--border); border-radius: 999px; padding: 3px 6px 3px 10px; font-size: 12px; height: fit-content; }
.chip .x { color: var(--text-dim); font-size: 11px; }
.chip .x:hover { color: var(--red); }
.link { color: var(--text-dim); text-decoration: underline; font-size: 12px; }
.empty { padding: 16px; text-align: center; color: var(--text-faint); font-size: 13px; }
.sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
</style>

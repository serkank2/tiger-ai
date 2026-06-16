<script setup lang="ts">
const props = defineProps<{ initial?: string }>();
const emit = defineEmits<{ select: [path: string]; close: [] }>();
const api = useApi();

const path = ref('');
const parent = ref('');
const dirs = ref<{ name: string; path: string }[]>([]);
const loading = ref(false);
const error = ref('');

async function load(p?: string) {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.listDir(p);
    path.value = res.path;
    parent.value = res.parent;
    dirs.value = res.directories;
  } catch (e) {
    const err = e as { data?: { error?: { message?: string } }; message?: string };
    error.value = err?.data?.error?.message ?? err?.message ?? 'Cannot read this folder';
  } finally {
    loading.value = false;
  }
}

onMounted(async () => {
  const start = props.initial?.trim();
  if (start) {
    await load(start);
    if (error.value) await load(); // invalid initial → fall back to home (no arg)
  } else {
    await load();
  }
});
</script>

<template>
  <div class="backdrop">
    <div class="picker" role="dialog" aria-modal="true">
      <h3>Choose a folder</h3>
      <div class="cur"><code>{{ path || '…' }}</code></div>

      <div class="list">
        <button v-if="parent && parent !== path" type="button" class="row up" @click="load(parent)">↑ ..</button>
        <button v-for="d in dirs" :key="d.path" type="button" class="row" @click="load(d.path)">
          <span class="ic">📁</span>{{ d.name }}
        </button>
        <div v-if="!loading && !dirs.length" class="empty">No subfolders here</div>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <p class="hint">Tip: type a path directly in the field to jump to another drive.</p>

      <div class="foot">
        <button type="button" class="ghost" @click="emit('close')">Cancel</button>
        <button type="button" class="primary" :disabled="!path" @click="emit('select', path)">Use this folder</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: grid;
  place-items: center;
  z-index: 60;
  backdrop-filter: blur(2px);
}
.picker {
  width: min(460px, 92vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 20px 22px;
}
h3 {
  margin: 0 0 10px;
  font-size: 16px;
}
.cur {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 7px 10px;
  word-break: break-all;
  margin-bottom: 10px;
}
.list {
  flex: 1;
  overflow-y: auto;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  min-height: 160px;
  max-height: 320px;
}
.row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  text-align: left;
  padding: 7px 11px;
  font-size: 13px;
  color: var(--text);
  border-radius: 0;
  border-bottom: 1px solid var(--border);
}
.row:hover {
  background: var(--accent-soft);
  color: var(--accent);
}
.row.up {
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.ic {
  flex: none;
}
.empty {
  padding: 18px;
  text-align: center;
  color: var(--text-faint);
  font-size: 13px;
}
.err {
  color: var(--red);
  font-size: 13px;
  margin: 8px 0 0;
}
.hint {
  color: var(--text-faint);
  font-size: 11px;
  margin: 8px 0 0;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.ghost {
  border: 1px solid var(--border-strong);
  padding: 8px 16px;
  color: var(--text-dim);
}
.primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 8px 18px;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

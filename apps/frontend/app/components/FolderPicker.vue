<script setup lang="ts">
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const props = defineProps<{ initial?: string }>();
const emit = defineEmits<{ select: [path: string]; close: [] }>();
const api = useApi();

const path = ref('');
const parent = ref('');
const dirs = ref<{ name: string; path: string }[]>([]);
const loading = ref(false);
const error = ref('');
// Editable absolute path the user can type to jump directly to any folder/drive.
const typedPath = ref('');

async function load(p?: string) {
  loading.value = true;
  error.value = '';
  try {
    const res = await api.listDir(p);
    path.value = res.path;
    parent.value = res.parent;
    dirs.value = res.directories;
    typedPath.value = res.path; // keep the editable field in sync with the resolved location
  } catch (e) {
    const err = e as { data?: { error?: { message?: string } }; message?: string };
    error.value = err?.data?.error?.message ?? err?.message ?? 'Cannot read this folder';
  } finally {
    loading.value = false;
  }
}

// Load the path the user typed directly; invalid/inaccessible paths surface the same error.
function loadTyped() {
  const p = typedPath.value.trim();
  if (p && !loading.value) void load(p);
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
  <BaseModal title="Choose a folder" size="md" @close="emit('close')">
    <div class="cur"><code>{{ path || '…' }}</code></div>

    <form class="go-row" @submit.prevent="loadTyped">
      <input
        v-model="typedPath"
        class="go-input"
        spellcheck="false"
        placeholder="Type an absolute path to jump to another drive…"
        aria-label="Absolute folder path"
        :disabled="loading"
      />
      <BaseButton type="submit" variant="secondary" :loading="loading" :disabled="!typedPath.trim()">Go</BaseButton>
    </form>

    <div class="list" :aria-busy="loading || undefined">
      <button v-if="parent && parent !== path" type="button" class="row up" :disabled="loading" @click="load(parent)">↑ ..</button>
      <button v-for="d in dirs" :key="d.path" type="button" class="row" :disabled="loading" @click="load(d.path)">
        <span class="ic">📁</span>{{ d.name }}
      </button>
      <div v-if="loading" class="loading-row"><Spinner :size="16" label="" /> Loading…</div>
      <div v-else-if="!dirs.length" class="empty">No subfolders here</div>
    </div>

    <p v-if="error" class="err">{{ error }}</p>

    <template #footer>
      <BaseButton variant="ghost" :disabled="loading" @click="emit('close')">Cancel</BaseButton>
      <BaseButton variant="primary" :disabled="!path || loading" @click="emit('select', path)">Use this folder</BaseButton>
    </template>
  </BaseModal>
</template>

<style scoped>
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
.go-row {
  display: flex;
  gap: 8px;
  margin-bottom: 10px;
}
.go-input {
  flex: 1;
  min-width: 0;
  font-family: var(--font-mono);
  font-size: 12px;
}
.list {
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
.row:hover:not(:disabled) {
  background: var(--accent-soft);
  color: var(--accent);
}
.row:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
.row.up {
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.ic {
  flex: none;
}
.loading-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px;
  justify-content: center;
  color: var(--text-dim);
  font-size: 13px;
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
</style>

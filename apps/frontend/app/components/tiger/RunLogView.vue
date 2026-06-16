<script setup lang="ts">
import { errText } from '~/lib/apiError';

const tiger = useTigerStore();
const content = ref('');
const error = ref('');
const loading = ref(false);

async function refresh() {
  loading.value = true;
  error.value = '';
  try {
    content.value = await tiger.readFile('run-log.md');
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}

onMounted(refresh);
// Refresh when a stage finishes (busy flips back to false).
watch(
  () => tiger.busy,
  (now, prev) => {
    if (prev && !now) void refresh();
  },
);
</script>

<template>
  <div class="runlog">
    <div class="head">
      <span class="t">Run log</span>
      <span class="spacer" />
      <button class="ghost" :disabled="loading" @click="refresh">{{ loading ? '…' : 'Refresh' }}</button>
    </div>
    <p v-if="error" class="err">{{ error }}</p>
    <pre v-else class="body">{{ content || 'No log entries yet.' }}</pre>
  </div>
</template>

<style scoped>
.runlog {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.head {
  display: flex;
  align-items: center;
  padding: 7px 10px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.t {
  font-size: 12px;
  font-weight: 700;
}
.spacer {
  flex: 1;
}
.ghost {
  border: 1px solid var(--border-strong);
  padding: 4px 12px;
  font-size: 12px;
  color: var(--text-dim);
}
.ghost:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.body {
  margin: 0;
  padding: 10px 12px;
  max-height: 320px;
  overflow: auto;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.err {
  margin: 0;
  padding: 10px 12px;
  color: var(--red);
  font-size: 12px;
}
</style>

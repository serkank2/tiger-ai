<script setup lang="ts">
import { computed, ref } from 'vue';

// Live view of one role agent's CLI terminal. Reuses the shared xterm view, so it
// replays the full scrollback on attach and then streams live output — exactly the
// same terminal the agent is driving, viewable mid-turn or after it finishes.
const props = defineProps<{ termId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();

const host = ref<HTMLElement | null>(null);
const idRef = computed<string | null>(() => props.termId || null);

useTerminalView(host, idRef, { compact: false, focusOnMount: true });
</script>

<template>
  <div class="term-pane">
    <div class="backdrop" @click="emit('close')" />
    <div class="drawer">
      <div class="head">
        <span class="dot" />
        <span class="title">{{ title }}</span>
        <code class="tid" :title="termId">{{ termId }}</code>
        <button class="close" title="Close" @click="emit('close')">✕</button>
      </div>
      <div ref="host" class="host" />
    </div>
  </div>
</template>

<style scoped>
.term-pane {
  position: fixed;
  inset: 0;
  z-index: 60;
}
.backdrop {
  position: absolute;
  inset: 0;
  background: var(--overlay-backdrop);
}
.drawer {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  width: min(72vw, 1000px);
  display: flex;
  flex-direction: column;
  background: var(--bg-term);
  border-left: 1px solid var(--border-strong);
  box-shadow: var(--shadow-lg);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--green);
  flex: none;
}
.title {
  font-weight: 700;
  font-size: var(--text-sm);
}
.tid {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 40ch;
}
.close {
  margin-left: auto;
  width: 26px;
  height: 26px;
  display: grid;
  place-items: center;
  color: var(--text-dim);
  border-radius: var(--radius-sm);
}
.close:hover {
  background: var(--bg-elev-2);
  color: var(--text);
}
.host {
  flex: 1;
  min-height: 0;
  padding: var(--space-2) var(--space-1) var(--space-2) var(--space-3);
}
</style>

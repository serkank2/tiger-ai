<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';

// Live view of one role agent's CLI terminal. Reuses the shared xterm view, so it
// replays the full scrollback on attach and then streams live output — exactly the
// same terminal the agent is driving, viewable mid-turn or after it finishes.
const props = defineProps<{ termId: string; title: string }>();
const emit = defineEmits<{ close: [] }>();
const { t } = useT();

const host = ref<HTMLElement | null>(null);
const idRef = computed<string | null>(() => props.termId || null);

useTerminalView(host, idRef, { compact: false, focusOnMount: true });

// Overlay drawer accessibility: Esc to close and focus-restore on close. The xterm
// view owns initial focus (focusOnMount), so we don't steal it here.
let opener: HTMLElement | null = null;
function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
  }
}
onMounted(() => {
  opener = (document.activeElement as HTMLElement | null) ?? null;
});
onBeforeUnmount(() => {
  if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
});
</script>

<template>
  <div class="term-pane">
    <div class="backdrop" @click="emit('close')" />
    <div
      class="drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="t('team.terminal.ariaLabel', { title })"
      @keydown="onKeydown"
    >
      <div class="head">
        <span class="dot" aria-hidden="true" />
        <span class="title">{{ title }}</span>
        <code class="tid" :title="termId">{{ termId }}</code>
        <BaseButton class="close" size="sm" variant="ghost" @click="emit('close')">{{
          t('team.terminal.close')
        }}</BaseButton>
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
}
.host {
  flex: 1;
  min-height: 0;
  padding: var(--space-2) var(--space-1) var(--space-2) var(--space-3);
}
</style>

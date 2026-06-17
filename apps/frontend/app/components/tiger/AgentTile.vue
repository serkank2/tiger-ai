<script setup lang="ts">
import type { TigerAgentRun } from '~/types';
import AgentIcon from '~/components/tiger/AgentIcon.vue';

const props = defineProps<{ run: TigerAgentRun }>();

const host = ref<HTMLElement | null>(null);
const idRef = computed(() => props.run.terminalId);
useTerminalView(host, idRef, { compact: true });

const STATE_LABEL: Record<string, string> = {
  pending: 'pending',
  starting: 'starting',
  waiting_ready: 'preparing',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  stopped: 'stopped',
};
const stateClass = computed(() => `s-${props.run.state}`);
</script>

<template>
  <div class="atile" :class="stateClass">
    <div class="ahead">
      <span class="dot" :class="stateClass" />
      <AgentIcon :type="run.type" :size="15" />
      <span class="label">{{ run.label }}</span>
      <span class="type" :class="run.type">{{ run.type }}</span>
      <span v-if="run.taskId" class="task">{{ run.taskId }}</span>
      <span class="spacer" />
      <span class="state">{{ STATE_LABEL[run.state] ?? run.state }}</span>
      <span v-if="run.completion" class="via" :title="`completed via ${run.completion}`">· {{ run.completion }}</span>
    </div>
    <div class="abody">
      <div ref="host" class="term" />
    </div>
    <div v-if="run.error" class="aerr" :title="run.error">⚠ {{ run.error }}</div>
    <div class="afoot">
      <code class="cmd" :title="run.command">{{ run.command }}</code>
      <span class="out" :title="run.outputRel">→ {{ run.outputRel }}</span>
    </div>
  </div>
</template>

<style scoped>
.atile {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 220px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-term);
}
.atile.s-running {
  border-color: var(--accent);
}
.atile.s-completed {
  border-color: var(--green);
}
.atile.s-failed {
  border-color: var(--red);
}
.ahead {
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 5px 9px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
  font-size: 12px;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
  flex: none;
}
.dot.s-running {
  background: var(--accent);
  box-shadow: 0 0 8px var(--accent);
}
.dot.s-starting,
.dot.s-waiting_ready {
  background: var(--amber);
  animation: blink 1s infinite;
}
.dot.s-completed {
  background: var(--green);
}
.dot.s-failed {
  background: var(--red);
}
@keyframes blink {
  50% {
    opacity: 0.3;
  }
}
.label {
  font-weight: 700;
}
.type {
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.type.claude {
  color: var(--accent);
  border-color: var(--accent);
}
.type.codex {
  color: var(--blue);
  border-color: var(--blue);
}
.task {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--text-dim);
}
.spacer {
  flex: 1;
}
.state {
  color: var(--text-dim);
}
.via {
  color: var(--text-faint);
  font-size: 11px;
}
.abody {
  flex: 1;
  min-height: 0;
  padding: 4px 2px 4px 6px;
}
.term {
  width: 100%;
  height: 100%;
}
.aerr {
  padding: 4px 9px;
  font-size: 11px;
  color: var(--red);
  background: rgba(229, 86, 75, 0.08);
  border-top: 1px solid var(--border);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.afoot {
  display: flex;
  gap: 10px;
  align-items: center;
  padding: 4px 9px;
  background: var(--bg-elev);
  border-top: 1px solid var(--border);
  font-size: 10px;
  color: var(--text-faint);
}
.cmd {
  font-family: var(--font-mono);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 55%;
}
.out {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>

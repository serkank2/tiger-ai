<script setup lang="ts">
// Per-agent live terminals: one pane per agent stream (builder/planner/reviewer
// and every council candidate), fed by `run.event` agent frames — the headless
// v2 equivalent of watching real PTYs, with steering attached so intervention
// happens right where the user is watching.
import { nextTick, ref, watch } from 'vue';
import type { ComponentPublicInstance } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseInput from '~/components/ui/BaseInput.vue';
import { useT } from '~/composables/useT';
import type { RunTerminal, RunTerminalLine } from '~/stores/runs';

const props = defineProps<{
  terminals: RunTerminal[];
  active: boolean;
  steerBusy?: boolean;
  interactive?: boolean;
  completeBusy?: (agentId: string) => boolean;
}>();
const emit = defineEmits<{
  steer: [body: string, interrupt: boolean];
  input: [agentId: string, data: string];
  complete: [agentId: string];
}>();
const { t } = useT();

const steering = ref('');
// Per-pane input buffers for interactive mode (keyed by agent/pane id).
const paneInput = ref<Record<string, string>>({});

function submit(interrupt: boolean): void {
  const body = steering.value.trim();
  if (!body) return;
  emit('steer', body, interrupt);
  steering.value = '';
}

function setPaneInput(id: string, value: string | number | undefined): void {
  paneInput.value = { ...paneInput.value, [id]: String(value ?? '') };
}

function sendInput(id: string): void {
  const data = paneInput.value[id];
  if (!data) return;
  emit('input', id, data + '\r');
  paneInput.value = { ...paneInput.value, [id]: '' };
}

// Keep every pane pinned to its newest line unless the user scrolled up.
const screens = new Map<string, HTMLElement>();
function setScreen(id: string, el: Element | ComponentPublicInstance | null): void {
  if (el instanceof HTMLElement) screens.set(id, el);
  else screens.delete(id);
}
// Key on lastAt (updates every frame), not lines.length — panes cap at 400
// lines, after which a length-based key stops changing and auto-scroll freezes.
watch(
  () => props.terminals.map((pane) => `${pane.id}:${pane.lines.length}:${pane.lastAt}`).join('|'),
  async () => {
    await nextTick();
    for (const pane of props.terminals) {
      const el = screens.get(pane.id);
      if (!el) continue;
      const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
      if (nearBottom) el.scrollTop = el.scrollHeight;
    }
  },
);

function lineText(line: RunTerminalLine): string {
  switch (line.type) {
    case 'tool-use':
      return `⚙ ${line.tool?.name ?? 'tool'} ${line.tool?.detail ?? ''}`;
    case 'tool-result':
      return `↩ ${line.tool?.name ?? 'tool'} ${line.tool?.detail ?? ''}`;
    case 'turn-started':
      return `▶ ${t('runs.terminals.turnStarted')}`;
    case 'result':
      return `■ ${line.text?.trim() || t('runs.terminals.turnEnded')}`;
    default:
      return line.text ?? '';
  }
}
</script>

<template>
  <div class="card terminals" data-testid="run-terminals">
    <header class="head">
      <h2>{{ t('runs.terminals.title') }}</h2>
      <span class="count">{{ terminals.length }}</span>
    </header>
    <p v-if="!terminals.length" class="note">{{ t('runs.terminals.empty') }}</p>
    <div v-else class="grid">
      <section
        v-for="pane in terminals"
        :key="pane.id"
        class="pane"
        :data-live="pane.live && active"
        :data-testid="`run-terminal-${pane.id}`"
      >
        <header class="pane-head">
          <span class="dot" :data-live="pane.live && active" />
          <strong class="name">{{ pane.id }}</strong>
          <span v-if="pane.provider" class="meta">
            {{ pane.provider }}<template v-if="pane.model"> · {{ pane.model }}</template>
          </span>
          <span v-if="pane.itemId" class="item">{{ pane.itemId }}</span>
          <span class="state">{{ pane.live && active ? t('runs.terminals.live') : t('runs.terminals.idle') }}</span>
        </header>
        <div :ref="(el) => setScreen(pane.id, el)" class="screen">
          <div v-for="line in pane.lines" :key="line.seq" class="line" :data-type="line.type">
            {{ lineText(line) }}
          </div>
        </div>
        <!-- Interactive mode: type into the live CLI + declare the turn done. -->
        <form
          v-if="interactive && pane.live && active"
          class="pane-input"
          :data-testid="`run-terminal-input-${pane.id}`"
          @submit.prevent="sendInput(pane.id)"
        >
          <BaseInput
            :model-value="paneInput[pane.id] ?? ''"
            :placeholder="t('runs.terminals.inputPlaceholder')"
            @update:model-value="(v) => setPaneInput(pane.id, v)"
          />
          <BaseButton type="submit" size="sm" variant="secondary">{{ t('runs.terminals.send') }}</BaseButton>
          <BaseButton
            size="sm"
            :loading="completeBusy?.(pane.id)"
            :data-testid="`run-terminal-complete-${pane.id}`"
            @click="emit('complete', pane.id)"
          >
            {{ t('runs.terminals.completeTurn') }}
          </BaseButton>
        </form>
      </section>
    </div>
    <form class="steer" @submit.prevent="submit(false)">
      <BaseInput v-model="steering" data-testid="run-terminals-steer-input" :placeholder="t('runs.steerPlaceholder')" />
      <BaseButton
        type="submit"
        size="sm"
        data-testid="run-terminals-steer"
        :loading="steerBusy"
        :disabled="!steering.trim()"
      >
        {{ t('runs.steer') }}
      </BaseButton>
      <BaseButton
        size="sm"
        variant="danger"
        data-testid="run-terminals-steer-now"
        :title="t('runs.steerNowHint')"
        :disabled="!steering.trim() || !active"
        @click="submit(true)"
      >
        {{ t('runs.steerNow') }}
      </BaseButton>
    </form>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-elev);
  padding: 14px;
}
.head {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}
.head h2 {
  margin: 0;
  font-size: 15px;
}
.count {
  font-size: 11px;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid var(--border);
  color: var(--text-dim);
}
.note {
  color: var(--text-dim);
  font-size: 12px;
  margin: 0;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 10px;
}
.pane {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.pane[data-live='true'] {
  border-color: var(--accent, #60a5fa);
}
.pane-head {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  font-size: 12px;
  flex-wrap: wrap;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 999px;
  background: var(--text-dim);
  flex: none;
}
.dot[data-live='true'] {
  background: var(--ok, #4ade80);
  animation: pulse 1.6s ease-in-out infinite;
}
@keyframes pulse {
  50% {
    opacity: 0.35;
  }
}
.name {
  font-family: var(--mono, ui-monospace, monospace);
}
.meta,
.item {
  color: var(--text-dim);
}
.state {
  margin-left: auto;
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 10px;
}
.screen {
  height: 240px;
  overflow: auto;
  padding: 8px 10px;
  background: var(--bg);
  font-family: var(--mono, ui-monospace, monospace);
  font-size: 12px;
  line-height: 1.45;
}
.line {
  white-space: pre-wrap;
  word-break: break-word;
}
.line[data-type='thinking'] {
  color: var(--text-dim);
  font-style: italic;
}
.line[data-type='raw'] {
  color: var(--text-dim);
}
.line[data-type='stderr'] {
  color: var(--danger, #f87171);
}
.line[data-type='tool-use'] {
  color: var(--accent, #60a5fa);
}
.line[data-type='tool-result'] {
  color: var(--text-dim);
}
.line[data-type='result'] {
  color: var(--ok, #4ade80);
}
.line[data-type='turn-started'] {
  color: var(--text-dim);
}
.pane-input {
  display: flex;
  gap: 6px;
  padding: 6px 8px;
  border-top: 1px solid var(--border);
  align-items: center;
}
.pane-input :deep(input) {
  flex: 1;
}
.steer {
  display: flex;
  gap: 8px;
  margin-top: 10px;
}
.steer :deep(input) {
  flex: 1;
}
</style>

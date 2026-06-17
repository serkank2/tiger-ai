<script setup lang="ts">
import type { TigerStageId, TigerStageRunConfig } from '~/types';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';

const emit = defineEmits<{ close: [] }>();
const tiger = useTigerStore();

const STAGES: { id: TigerStageId; num: string; title: string }[] = [
  { id: 'brainstorming', num: '1', title: 'Brainstorming' },
  { id: 'writing-plan', num: '2', title: 'Writing Plan' },
  { id: 'writing-tasks', num: '3', title: 'Writing Tasks' },
  { id: 'merge-tasks', num: '4', title: 'Merge Tasks' },
  { id: 'executing-plan', num: '5', title: 'Executing Plan' },
  { id: 'task-review', num: '6A', title: 'Task Review' },
  { id: 'requesting-code-review', num: '6B', title: 'Requesting Code Review' },
];

function freshCfg(): TigerStageRunConfig {
  const d = tiger.config?.defaults;
  return {
    claudeAgents: d?.claudeAgents ?? 1,
    codexAgents: d?.codexAgents ?? 1,
    claudeModel: d?.claudeModel ?? 'opus',
    codexModel: d?.codexModel ?? 'gpt-5.5',
    claudeEffort: d?.claudeEffort ?? 'xhigh',
    codexEffort: d?.codexEffort ?? 'high',
    claudePermission: d?.claudePermission ?? 'dangerous',
    codexPermission: d?.codexPermission ?? 'yolo',
    parallel: d?.parallel ?? true,
    mergeAgent: 'claude',
  };
}

const stageConfigs = reactive<Record<string, TigerStageRunConfig>>(
  Object.fromEntries(STAGES.map((s) => [s.id, freshCfg()])),
);

function firstIncomplete(): TigerStageId {
  const stages = tiger.state?.stages;
  if (stages) for (const s of STAGES) if (stages[s.id]?.status !== 'completed') return s.id;
  return 'brainstorming';
}
const fromStage = ref<TigerStageId>(firstIncomplete());
const fromIdx = computed(() => STAGES.findIndex((s) => s.id === fromStage.value));
const willRun = (id: TigerStageId) => STAGES.findIndex((s) => s.id === id) >= fromIdx.value;

function stageSummary(id: TigerStageId): string {
  const c = stageConfigs[id]!;
  if (id === 'merge-tasks') return `merge: ${c.mergeAgent ?? 'claude'}`;
  return `${c.claudeAgents}× claude, ${c.codexAgents}× codex`;
}

const starting = ref(false);
async function start() {
  if (starting.value) return;
  starting.value = true;
  const configs: Partial<Record<TigerStageId, TigerStageRunConfig>> = {};
  for (const s of STAGES) if (willRun(s.id)) configs[s.id] = { ...stageConfigs[s.id]! };
  await tiger.runAll(configs, fromStage.value);
  starting.value = false;
  emit('close');
}
</script>

<template>
  <div class="backdrop" @click.self="emit('close')">
    <div class="modal" role="dialog" aria-modal="true">
      <header class="mhead">
        <b>Configure &amp; Run All</b>
        <span class="spacer" />
        <button class="ic" title="Close" @click="emit('close')">✕</button>
      </header>
      <p class="lead">Set each stage's agents, then start — the system runs every stage automatically with these settings.</p>

      <label class="from">
        <span>Start from</span>
        <select v-model="fromStage">
          <option v-for="s in STAGES" :key="s.id" :value="s.id">{{ s.num }} · {{ s.title }}</option>
        </select>
        <small>Stages before this are skipped.</small>
      </label>

      <div class="stages">
        <details v-for="s in STAGES" :key="s.id" :open="s.id === fromStage" :class="{ skipped: !willRun(s.id) }">
          <summary>
            <span class="snum">{{ s.num }}</span>
            <span class="stitle">{{ s.title }}</span>
            <span class="sskip" v-if="!willRun(s.id)">skipped</span>
            <span class="ssum" v-else>{{ stageSummary(s.id) }}</span>
          </summary>
          <div class="sbody">
            <StageConfigPanel
              v-if="tiger.config"
              :config="tiger.config"
              :stage="s.id"
              :cfg="stageConfigs[s.id]!"
              :disabled="!willRun(s.id)"
            />
          </div>
        </details>
      </div>

      <footer class="mfoot">
        <button class="ghost" @click="emit('close')">Cancel</button>
        <button class="start" :disabled="starting || tiger.busy" @click="start">
          {{ starting ? 'Starting…' : '▶▶ Start auto run' }}
        </button>
      </footer>
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
  z-index: 60;
  backdrop-filter: blur(2px);
}
.modal {
  width: min(760px, 94vw);
  max-height: 88vh;
  display: flex;
  flex-direction: column;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 18px 20px;
}
.mhead {
  display: flex;
  align-items: center;
  font-size: 15px;
}
.spacer {
  flex: 1;
}
.ic {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.ic:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.lead {
  color: var(--text-dim);
  font-size: 13px;
  margin: 8px 0 12px;
}
.from {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.from > span {
  font-size: 13px;
  font-weight: 600;
}
.from small {
  color: var(--text-faint);
  font-size: 11px;
}
.stages {
  flex: 1;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding-right: 4px;
}
details {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
details.skipped {
  opacity: 0.55;
}
summary {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 10px 12px;
  font-size: 13px;
}
.snum {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--text-faint);
}
.stitle {
  font-weight: 600;
}
.ssum {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.sskip {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-faint);
}
.sbody {
  padding: 4px 12px 12px;
  border-top: 1px solid var(--border);
}
.mfoot {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
.ghost {
  border: 1px solid var(--border-strong);
  padding: 9px 16px;
  color: var(--text-dim);
}
.ghost:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.start {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 9px 18px;
}
.start:hover:not(:disabled) {
  background: var(--accent-strong);
}
.start:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

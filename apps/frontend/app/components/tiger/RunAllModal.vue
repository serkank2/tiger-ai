<script setup lang="ts">
import type { TigerRunTemplate, TigerStageId, TigerStageRunConfig } from '~/types';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';

const emit = defineEmits<{ close: [] }>();
const tiger = useTigerStore();
const api = useApi();

const STAGES: { id: TigerStageId; num: string; title: string; opt?: boolean }[] = [
  { id: 'brainstorming', num: '1', title: 'Brainstorming', opt: true },
  { id: 'writing-plan', num: '2', title: 'Writing Plan' },
  { id: 'writing-tasks', num: '3', title: 'Writing Tasks' },
  { id: 'merge-tasks', num: '4', title: 'Merge Tasks' },
  { id: 'executing-plan', num: '5', title: 'Executing Tasks' },
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

// --- templates ---
const templates = ref<TigerRunTemplate[]>([]);
const appliedName = ref<string | null>(null);
const showSave = ref(false);
const newName = ref('');
const newDesc = ref('');

onMounted(async () => {
  try {
    templates.value = await api.listTigerTemplates();
  } catch {
    /* leave empty */
  }
});

function applyTemplate(t: TigerRunTemplate) {
  for (const s of STAGES) {
    const c = t.configs?.[s.id];
    if (c) stageConfigs[s.id] = { ...freshCfg(), ...c };
  }
  if (t.fromStage) fromStage.value = t.fromStage;
  appliedName.value = t.name;
}

async function doSave() {
  const name = newName.value.trim();
  if (!name) return;
  const configs: Partial<Record<TigerStageId, TigerStageRunConfig>> = {};
  for (const s of STAGES) configs[s.id] = { ...stageConfigs[s.id]! };
  try {
    templates.value = await api.saveTigerTemplate({
      name,
      description: newDesc.value.trim() || undefined,
      fromStage: fromStage.value,
      configs,
    });
    appliedName.value = name;
    showSave.value = false;
    newName.value = '';
    newDesc.value = '';
  } catch {
    /* ignore */
  }
}

async function removeTemplate(t: TigerRunTemplate) {
  try {
    templates.value = await api.deleteTigerTemplate(t.name);
    if (appliedName.value === t.name) appliedName.value = null;
  } catch {
    /* ignore */
  }
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
      <p class="lead">Pick a template or tune each stage, then start — the system runs every stage automatically with these settings.</p>

      <div class="tpl-bar">
        <span class="tpl-label">Templates</span>
        <button
          v-for="t in templates"
          :key="t.name"
          type="button"
          class="tpl"
          :class="{ on: appliedName === t.name }"
          :title="t.description || t.name"
          @click="applyTemplate(t)"
        >
          {{ t.name }}
          <span v-if="t.builtin" class="tag">built-in</span>
          <span v-else class="del" title="Delete template" @click.stop="removeTemplate(t)">✕</span>
        </button>
        <button type="button" class="tpl add" @click="showSave = !showSave">＋ Save current…</button>
      </div>
      <div v-if="showSave" class="save-row">
        <input v-model="newName" placeholder="Template name" />
        <input v-model="newDesc" placeholder="Description (optional)" />
        <button type="button" class="mini" :disabled="!newName.trim()" @click="doSave">Save</button>
        <button type="button" class="mini ghost" @click="showSave = false">Cancel</button>
      </div>

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
            <span v-if="s.opt" class="sopt" title="Optional stage">optional</span>
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
.tpl-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}
.tpl-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-dim);
  margin-right: 2px;
}
.tpl {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  font-size: 12px;
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  color: var(--text-dim);
}
.tpl:hover {
  border-color: var(--accent);
  color: var(--text);
}
.tpl.on {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
}
.tpl.add {
  border-style: dashed;
}
.tpl .tag {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.tpl .del {
  color: var(--text-faint);
  font-size: 11px;
}
.tpl .del:hover {
  color: var(--red);
}
.save-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 12px;
}
.save-row input {
  flex: 1;
  min-width: 140px;
  padding: 6px 9px;
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
}
.mini {
  padding: 6px 12px;
  font-size: 12px;
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 600;
  border-radius: var(--radius-sm);
}
.mini.ghost {
  background: transparent;
  color: var(--text-dim);
  border-color: var(--border-strong);
}
.mini:disabled {
  opacity: 0.5;
  cursor: not-allowed;
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
.sopt {
  font-size: 9px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
  border: 1px solid var(--border);
  border-radius: 999px;
  padding: 0 5px;
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

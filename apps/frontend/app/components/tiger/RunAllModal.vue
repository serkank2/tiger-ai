<script setup lang="ts">
import type { TigerRunTemplate, TigerStageId, TigerStageRunConfig } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';
import { errText } from '~/lib/apiError';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';

const emit = defineEmits<{ close: [] }>();
const tiger = useTigerStore();
const api = useApi();
const notices = useNoticesStore();

const AGENT_COUNT_MIN = 1;
const AGENT_COUNT_MAX = 8;
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];

function freshCfg(): TigerStageRunConfig {
  const d = tiger.config?.defaults;
  return {
    claudeAgents: d?.claudeAgents ?? 1,
    codexAgents: d?.codexAgents ?? 1,
    claudeModel: d?.claudeModel ?? 'sonnet',
    codexModel: d?.codexModel ?? 'gpt-5',
    claudeEffort: d?.claudeEffort ?? 'medium',
    codexEffort: d?.codexEffort ?? 'medium',
    claudePermission: d?.claudePermission ?? 'dangerous',
    codexPermission: d?.codexPermission ?? 'yolo',
    parallel: d?.parallel ?? true,
    mergeAgent: 'claude',
  };
}

function clampAgentCount(value: unknown): number {
  return Math.min(AGENT_COUNT_MAX, Math.max(AGENT_COUNT_MIN, Number.isInteger(value) ? Number(value) : AGENT_COUNT_MIN));
}

function sanitizeCfg(input?: Partial<TigerStageRunConfig>): TigerStageRunConfig {
  const cfg = { ...freshCfg(), ...(input ?? {}) };
  const claudeModels = ['', ...(tiger.config?.cli.claude.models ?? [])];
  const codexModels = ['', ...(tiger.config?.cli.codex.models ?? [])];
  const claudePerms = Object.keys(tiger.config?.cli.claude.permissionModes ?? {});
  const codexPerms = Object.keys(tiger.config?.cli.codex.permissionModes ?? {});

  cfg.claudeAgents = clampAgentCount(cfg.claudeAgents);
  cfg.codexAgents = clampAgentCount(cfg.codexAgents);
  if (!claudeModels.includes(cfg.claudeModel)) cfg.claudeModel = '';
  if (!codexModels.includes(cfg.codexModel)) cfg.codexModel = '';
  if (!CLAUDE_EFFORTS.includes(cfg.claudeEffort)) cfg.claudeEffort = '';
  if (!CODEX_EFFORTS.includes(cfg.codexEffort)) cfg.codexEffort = '';
  if (!claudePerms.includes(cfg.claudePermission)) cfg.claudePermission = freshCfg().claudePermission;
  if (!codexPerms.includes(cfg.codexPermission)) cfg.codexPermission = freshCfg().codexPermission;
  if (cfg.mergeAgent !== 'claude' && cfg.mergeAgent !== 'codex') cfg.mergeAgent = 'claude';
  return cfg;
}

const stageConfigs = reactive<Record<string, TigerStageRunConfig>>(
  Object.fromEntries(TIGER_STAGES.map((s) => [s.id, sanitizeCfg()])),
);

function firstIncomplete(): TigerStageId {
  const stages = tiger.state?.stages;
  if (stages) for (const s of TIGER_STAGES) if (stages[s.id]?.status !== 'completed') return s.id;
  return 'brainstorming';
}
const fromStage = ref<TigerStageId>(firstIncomplete());
const fromIdx = computed(() => TIGER_STAGES.findIndex((s) => s.id === fromStage.value));
const willRun = (id: TigerStageId) => TIGER_STAGES.findIndex((s) => s.id === id) >= fromIdx.value;

function stageSummary(id: TigerStageId): string {
  const c = stageConfigs[id]!;
  if (id === 'merge-tasks') return `merge: ${c.mergeAgent ?? 'claude'}`;
  return `${c.claudeAgents}× claude, ${c.codexAgents}× codex`;
}

const starting = ref(false);
async function start() {
  if (starting.value) return;
  starting.value = true;
  try {
    const configs: Partial<Record<TigerStageId, TigerStageRunConfig>> = {};
    for (const s of TIGER_STAGES) {
      stageConfigs[s.id] = sanitizeCfg(stageConfigs[s.id]);
      if (willRun(s.id)) configs[s.id] = { ...stageConfigs[s.id]! };
    }
    await tiger.runAll(configs, fromStage.value);
    emit('close');
  } finally {
    starting.value = false;
  }
}

// --- templates ---
const templates = ref<TigerRunTemplate[]>([]);
const templatesLoading = ref(false);
const savingTemplate = ref(false);
const deletingTemplate = ref<string | null>(null);
const appliedName = ref<string | null>(null);
const showSave = ref(false);
const newName = ref('');
const newDesc = ref('');

onMounted(async () => {
  templatesLoading.value = true;
  try {
    templates.value = await api.listTigerTemplates();
  } catch (e) {
    notices.push(`Load templates failed: ${errText(e)}`, 'error');
  } finally {
    templatesLoading.value = false;
  }
});

function applyTemplate(t: TigerRunTemplate) {
  for (const s of TIGER_STAGES) {
    const c = t.configs?.[s.id];
    if (c) stageConfigs[s.id] = sanitizeCfg(c);
  }
  if (t.fromStage) fromStage.value = t.fromStage;
  appliedName.value = t.name;
}

async function doSave() {
  if (savingTemplate.value) return;
  const name = newName.value.trim();
  if (!name) return;
  const configs: Partial<Record<TigerStageId, TigerStageRunConfig>> = {};
  for (const s of TIGER_STAGES) {
    stageConfigs[s.id] = sanitizeCfg(stageConfigs[s.id]);
    configs[s.id] = { ...stageConfigs[s.id]! };
  }
  savingTemplate.value = true;
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
  } catch (e) {
    notices.push(`Save template failed: ${errText(e)}`, 'error');
  } finally {
    savingTemplate.value = false;
  }
}

async function removeTemplate(t: TigerRunTemplate) {
  if (deletingTemplate.value) return;
  deletingTemplate.value = t.name;
  try {
    templates.value = await api.deleteTigerTemplate(t.name);
    if (appliedName.value === t.name) appliedName.value = null;
  } catch (e) {
    notices.push(`Delete template failed: ${errText(e)}`, 'error');
  } finally {
    deletingTemplate.value = null;
  }
}
</script>

<template>
  <BaseModal title="Configure &amp; Run All" size="lg" @close="emit('close')">
      <template #header-actions>
        <BaseButton icon-only variant="ghost" aria-label="Close" @click="emit('close')">✕</BaseButton>
      </template>
      <p class="lead">Pick a template or tune each stage, then start — the system runs every stage automatically with these settings.</p>

      <div class="tpl-bar">
        <span class="tpl-label">Templates</span>
        <Spinner v-if="templatesLoading && !templates.length" small label="Loading templates" />
        <button
          v-for="t in templates"
          :key="t.name"
          type="button"
          class="tpl"
          :class="{ on: appliedName === t.name }"
          :disabled="!!deletingTemplate"
          :title="t.description || t.name"
          @click="applyTemplate(t)"
        >
          {{ t.name }}
          <span v-if="t.builtin" class="tag">built-in</span>
          <span
            v-else
            class="del"
            :class="{ busy: deletingTemplate === t.name }"
            :title="deletingTemplate === t.name ? 'Deleting template' : 'Delete template'"
            @click.stop="removeTemplate(t)"
          >
            {{ deletingTemplate === t.name ? '...' : '✕' }}
          </span>
        </button>
        <button type="button" class="tpl add" @click="showSave = !showSave">＋ Save current…</button>
      </div>
      <div v-if="showSave" class="save-row">
        <input v-model="newName" :disabled="savingTemplate" placeholder="Template name" />
        <input v-model="newDesc" :disabled="savingTemplate" placeholder="Description (optional)" />
        <button type="button" class="mini" :disabled="savingTemplate || !newName.trim()" @click="doSave">
          {{ savingTemplate ? 'Saving...' : 'Save' }}
        </button>
        <button type="button" class="mini ghost" :disabled="savingTemplate" @click="showSave = false">Cancel</button>
      </div>

      <label class="from">
        <span>Start from</span>
        <select v-model="fromStage">
          <option v-for="s in TIGER_STAGES" :key="s.id" :value="s.id">{{ s.number }} · {{ s.title }}</option>
        </select>
        <small>Stages before this are skipped.</small>
      </label>

      <div class="stages">
        <details v-for="s in TIGER_STAGES" :key="s.id" :open="s.id === fromStage" :class="{ skipped: !willRun(s.id) }">
          <summary>
            <span class="snum">{{ s.number }}</span>
            <span class="stitle">{{ s.title }}</span>
            <span v-if="s.optional" class="sopt" title="Optional stage">optional</span>
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

      <template #footer>
        <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
        <BaseButton variant="primary" :loading="starting" :disabled="tiger.busy" @click="start">▶▶ Start auto run</BaseButton>
      </template>
  </BaseModal>
</template>

<style scoped>
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
.tpl:disabled {
  opacity: 0.65;
  cursor: not-allowed;
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
.tpl .del.busy {
  color: var(--amber);
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
</style>

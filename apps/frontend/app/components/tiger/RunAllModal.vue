<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { TigerRunTemplate, TigerStageId, TigerStageRunConfig } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';
import { cloneStageConfigs, fullStageConfigs } from '~/lib/tigerTemplateConfig';
import { templateRef, useTemplatesStore } from '~/stores/templates';
import { useTigerStore } from '~/stores/tiger';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';

const emit = defineEmits<{ close: []; openTemplates: [] }>();

const tiger = useTigerStore();
const templates = useTemplatesStore();

const selectedKey = ref('');
const appliedTemplate = ref<TigerRunTemplate | null>(null);
const localError = ref<string | null>(null);
const starting = ref(false);
const initialized = ref(false);
const stageConfigs = reactive<Record<TigerStageId, TigerStageRunConfig>>(fullStageConfigs(null));
const fromStage = ref<TigerStageId>('brainstorming');

const selectedTemplate = computed(
  () => templates.items.find((template) => templateRef(template) === selectedKey.value) ?? null,
);
const activeError = computed(() => localError.value || templates.operationError || templates.loadError);
const fromIdx = computed(() => TIGER_STAGES.findIndex((stage) => stage.id === fromStage.value));
const willRun = (id: TigerStageId) => TIGER_STAGES.findIndex((stage) => stage.id === id) >= fromIdx.value;
const canStart = computed(() => !!appliedTemplate.value && !tiger.busy && !starting.value);

function replaceStageConfigs(next: Partial<Record<TigerStageId, TigerStageRunConfig>>) {
  const full = fullStageConfigs(tiger.config, { configs: next });
  for (const stage of TIGER_STAGES) stageConfigs[stage.id] = full[stage.id];
}

function stageSummary(id: TigerStageId): string {
  const cfg = stageConfigs[id];
  if (id === 'merge-tasks') return `merge: ${cfg.mergeAgent ?? 'claude'}`;
  const parts = [`${cfg.claudeAgents} Claude`, `${cfg.codexAgents} Codex`];
  if (cfg.antigravityAgents > 0) parts.push(`${cfg.antigravityAgents} Antigravity`);
  return parts.join(', ');
}

function ensureSelection() {
  if (selectedKey.value && templates.items.some((template) => templateRef(template) === selectedKey.value)) return;
  selectedKey.value = templates.items[0] ? templateRef(templates.items[0]) : '';
}

async function applySelected() {
  const template = selectedTemplate.value;
  if (!template) {
    appliedTemplate.value = null;
    return;
  }
  localError.value = null;
  try {
    const applied = await templates.apply(template);
    appliedTemplate.value = applied;
    fromStage.value = applied.fromStage ?? 'brainstorming';
    replaceStageConfigs(applied.configs);
  } catch {
    appliedTemplate.value = null;
  }
}

async function loadTemplates() {
  await Promise.all([templates.load(), tiger.config ? Promise.resolve() : tiger.load()]);
  ensureSelection();
  initialized.value = true;
  if (selectedTemplate.value) await applySelected();
}

async function start() {
  if (starting.value || !selectedTemplate.value) return;
  if (!appliedTemplate.value || templateRef(appliedTemplate.value) !== templateRef(selectedTemplate.value)) {
    await applySelected();
  }
  if (!appliedTemplate.value) return;

  starting.value = true;
  try {
    const configs: Partial<Record<TigerStageId, TigerStageRunConfig>> = {};
    const sanitized = cloneStageConfigs(tiger.config, stageConfigs);
    for (const stage of TIGER_STAGES) {
      if (willRun(stage.id)) configs[stage.id] = sanitized[stage.id];
    }
    await tiger.runAll(configs, fromStage.value);
    emit('close');
  } finally {
    starting.value = false;
  }
}

function openManager() {
  emit('close');
  emit('openTemplates');
}

onMounted(() => {
  void loadTemplates();
});

watch(selectedKey, () => {
  if (initialized.value) void applySelected();
});
</script>

<template>
  <BaseModal title="Run All From Template" size="lg" @close="emit('close')">
    <template #header-actions>
      <BaseButton icon-only variant="ghost" aria-label="Close" @click="emit('close')">x</BaseButton>
    </template>

    <p class="lead">Select a saved DB template, review its stage settings, then start the automatic run.</p>

    <div class="picker">
      <label>
        <span>Template</span>
        <select v-model="selectedKey" :disabled="templates.loading || !templates.items.length">
          <option v-for="template in templates.items" :key="templateRef(template)" :value="templateRef(template)">
            {{ template.name }} ({{ template.builtin ? 'built-in' : 'custom' }})
          </option>
        </select>
      </label>
      <BaseButton
        variant="secondary"
        :loading="!!selectedTemplate && templates.applyingId === templateRef(selectedTemplate)"
        :disabled="!selectedTemplate"
        @click="applySelected"
      >
        Apply
      </BaseButton>
      <BaseButton variant="ghost" @click="openManager">Manage templates</BaseButton>
    </div>

    <div v-if="templates.loading && !templates.loaded" class="state">Loading templates...</div>
    <div v-else-if="activeError" class="state error" role="alert">{{ activeError }}</div>
    <div v-else-if="!templates.items.length" class="state empty">No templates are available. Create one in Templates.</div>

    <div v-if="appliedTemplate" class="template-note">
      <b>{{ appliedTemplate.name }}</b>
      <span>{{ appliedTemplate.description || 'No description' }}</span>
      <small>{{ appliedTemplate.builtin ? 'Built-in template' : 'Custom template' }}</small>
    </div>

    <label class="from">
      <span>Start from</span>
      <select v-model="fromStage">
        <option v-for="stage in TIGER_STAGES" :key="stage.id" :value="stage.id">
          {{ stage.number }} - {{ stage.title }}
        </option>
      </select>
      <small>Stages before this are skipped.</small>
    </label>

    <div class="stages">
      <details v-for="stage in TIGER_STAGES" :key="stage.id" :open="stage.id === fromStage" :class="{ skipped: !willRun(stage.id) }">
        <summary>
          <span class="snum">{{ stage.number }}</span>
          <span class="stitle">{{ stage.title }}</span>
          <span v-if="stage.optional" class="sopt" title="Optional stage">optional</span>
          <span class="sskip" v-if="!willRun(stage.id)">skipped</span>
          <span class="ssum" v-else>{{ stageSummary(stage.id) }}</span>
        </summary>
        <div class="sbody">
          <StageConfigPanel
            v-if="tiger.config"
            :config="tiger.config"
            :stage="stage.id"
            :cfg="stageConfigs[stage.id]"
            disabled
          />
          <p v-else class="state">Loading configuration...</p>
        </div>
      </details>
    </div>

    <template #footer>
      <BaseButton variant="ghost" @click="emit('close')">Cancel</BaseButton>
      <BaseButton variant="primary" :loading="starting" :disabled="!canStart" @click="start">Start auto run</BaseButton>
    </template>
  </BaseModal>
</template>

<style scoped>
.lead {
  color: var(--text-dim);
  font-size: 13px;
  margin: 8px 0 12px;
}
.picker {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto;
  gap: 8px;
  align-items: end;
  margin-bottom: 12px;
}
.picker label {
  display: grid;
  gap: 6px;
}
.picker label span {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
}
.state {
  margin-bottom: 12px;
  color: var(--text-dim);
  font-size: 13px;
}
.state.error {
  color: var(--red);
}
.state.empty {
  color: var(--text-faint);
}
.template-note {
  display: grid;
  gap: 3px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.template-note span,
.template-note small {
  color: var(--text-dim);
  font-size: 12px;
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
@media (max-width: 760px) {
  .picker {
    grid-template-columns: 1fr;
  }
  .from {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>

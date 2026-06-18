<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type { TigerRunTemplate, TigerRunTemplatePayload, TigerStageId, TigerStageRunConfig } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';
import { cloneStageConfigs, fullStageConfigs } from '~/lib/tigerTemplateConfig';
import { templateRef, useTemplatesStore } from '~/stores/templates';
import { useTigerStore } from '~/stores/tiger';
import BaseButton from '~/components/ui/BaseButton.vue';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';

const emit = defineEmits<{ back: []; openTiger: [] }>();

const templates = useTemplatesStore();
const tiger = useTigerStore();

type EditorMode = 'view' | 'new' | 'edit';

const selectedKey = ref<string | null>(null);
const mode = ref<EditorMode>('view');
const localError = ref<string | null>(null);
const confirmingArchive = ref<string | null>(null);
const form = reactive<{
  name: string;
  description: string;
  fromStage: TigerStageId;
  configs: Record<TigerStageId, TigerStageRunConfig>;
}>({
  name: '',
  description: '',
  fromStage: 'brainstorming',
  configs: fullStageConfigs(null),
});

const selectedTemplate = computed(
  () => templates.items.find((template) => templateRef(template) === selectedKey.value) ?? null,
);
const selectedIsReadonly = computed(() => mode.value === 'view' || !!selectedTemplate.value?.builtin);
const canEditSelected = computed(() => !!selectedTemplate.value && !selectedTemplate.value.builtin && mode.value === 'view');
const canArchiveSelected = computed(() => canEditSelected.value);
const canSave = computed(() => (mode.value === 'new' || mode.value === 'edit') && !!form.name.trim() && !templates.saving);
const activeError = computed(() => localError.value || templates.operationError);
const selectedTemplateActionKey = computed(() => (selectedTemplate.value ? templateRef(selectedTemplate.value) : ''));

function templateLabel(template: TigerRunTemplate): string {
  return template.builtin ? 'Built-in' : 'Custom';
}

function stageSummary(stage: TigerStageId): string {
  const cfg = form.configs[stage];
  if (stage === 'merge-tasks') return `merge: ${cfg.mergeAgent ?? 'claude'}`;
  return `${cfg.claudeAgents} Claude, ${cfg.codexAgents} Codex`;
}

function replaceFormConfigs(next: Partial<Record<TigerStageId, TigerStageRunConfig>>) {
  form.configs = fullStageConfigs(tiger.config, { configs: next });
}

function fillForm(template?: TigerRunTemplate | null) {
  form.name = template?.name ?? '';
  form.description = template?.description ?? '';
  form.fromStage = template?.fromStage ?? 'brainstorming';
  replaceFormConfigs(template?.configs ?? {});
}

function selectTemplate(template: TigerRunTemplate) {
  selectedKey.value = templateRef(template);
  mode.value = 'view';
  confirmingArchive.value = null;
  localError.value = null;
  templates.clearFeedback();
  fillForm(template);
}

function ensureSelection() {
  if (selectedKey.value && templates.items.some((template) => templateRef(template) === selectedKey.value)) return;
  const first = templates.items[0];
  if (first) selectTemplate(first);
  else {
    selectedKey.value = null;
    fillForm(null);
  }
}

function startNew() {
  selectedKey.value = null;
  mode.value = 'new';
  confirmingArchive.value = null;
  localError.value = null;
  templates.clearFeedback();
  fillForm(null);
}

function startEdit() {
  if (!selectedTemplate.value || selectedTemplate.value.builtin) return;
  mode.value = 'edit';
  confirmingArchive.value = null;
  localError.value = null;
  templates.clearFeedback();
  fillForm(selectedTemplate.value);
}

function cancelEdit() {
  mode.value = 'view';
  localError.value = null;
  if (selectedTemplate.value) fillForm(selectedTemplate.value);
  else ensureSelection();
}

function buildPayload(): TigerRunTemplatePayload | null {
  const name = form.name.trim();
  if (!name) {
    localError.value = 'Template name is required.';
    return null;
  }
  return {
    name,
    description: form.description.trim() || undefined,
    fromStage: form.fromStage,
    configs: cloneStageConfigs(tiger.config, form.configs),
  };
}

async function saveTemplate() {
  const payload = buildPayload();
  if (!payload) return;
  localError.value = null;
  try {
    const saved =
      mode.value === 'new'
        ? await templates.create(payload)
        : selectedTemplate.value
          ? await templates.update(templateRef(selectedTemplate.value), payload)
          : null;
    if (saved) selectTemplate(saved);
    mode.value = 'view';
  } catch {
    /* store feedback is shown inline */
  }
}

async function duplicateSelected() {
  if (!selectedTemplate.value) return;
  try {
    const copy = await templates.duplicate(selectedTemplate.value);
    selectTemplate(copy);
  } catch {
    /* store feedback is shown inline */
  }
}

async function applySelected() {
  if (!selectedTemplate.value) return;
  try {
    const applied = await templates.apply(selectedTemplate.value);
    fillForm(applied);
  } catch {
    /* store feedback is shown inline */
  }
}

async function archiveSelected() {
  const template = selectedTemplate.value;
  if (!template || template.builtin) return;
  const key = templateRef(template);
  if (confirmingArchive.value !== key) {
    confirmingArchive.value = key;
    return;
  }
  try {
    await templates.archive(template);
    confirmingArchive.value = null;
    ensureSelection();
  } catch {
    /* store feedback is shown inline */
  }
}

async function retryLoad() {
  await templates.load(true);
  ensureSelection();
}

onMounted(async () => {
  await Promise.all([templates.load(), tiger.config ? Promise.resolve() : tiger.load()]);
  ensureSelection();
});

watch(
  () => templates.items.map((template) => templateRef(template)).join('\0'),
  ensureSelection,
);

watch(
  () => tiger.config,
  () => {
    if (mode.value === 'new') replaceFormConfigs(form.configs);
    else fillForm(selectedTemplate.value);
  },
);
</script>

<template>
  <div class="templates-page">
    <header class="topbar">
      <div class="title">
        <b>Templates</b>
        <span>Global Run All template manager</span>
      </div>
      <span class="spacer" />
      <BaseButton variant="secondary" @click="emit('openTiger')">Tiger</BaseButton>
      <BaseButton variant="ghost" @click="emit('back')">Back</BaseButton>
    </header>

    <main class="layout">
      <aside class="sidebar">
        <div class="side-head">
          <span>Templates</span>
          <BaseButton size="sm" variant="primary" @click="startNew">New</BaseButton>
        </div>

        <div v-if="templates.loading && !templates.loaded" class="state">Loading templates...</div>
        <div v-else-if="templates.loadError" class="state error">
          <b>Could not load templates.</b>
          <span>{{ templates.loadError }}</span>
          <BaseButton size="sm" @click="retryLoad">Retry</BaseButton>
        </div>
        <div v-else-if="!templates.items.length" class="state empty">
          <b>No templates yet.</b>
          <span>Create a custom Run All template.</span>
        </div>

        <div v-else class="template-list">
          <button
            v-for="template in templates.items"
            :key="templateRef(template)"
            type="button"
            class="template-row"
            :class="{ selected: selectedKey === templateRef(template) }"
            @click="selectTemplate(template)"
          >
            <span class="row-main">
              <b>{{ template.name }}</b>
              <small>{{ template.description || 'No description' }}</small>
            </span>
            <span class="badge" :class="{ builtin: template.builtin }">{{ templateLabel(template) }}</span>
          </button>
        </div>
      </aside>

      <section class="editor">
        <div class="editor-head">
          <div>
            <p class="eyebrow">{{ mode === 'new' ? 'New custom template' : selectedTemplate ? templateLabel(selectedTemplate) : 'Template' }}</p>
            <h2>{{ mode === 'new' ? 'Create template' : form.name || 'Select a template' }}</h2>
          </div>
          <span v-if="selectedTemplate?.builtin" class="readonly">Built-ins are read-only</span>
          <span v-else-if="mode === 'edit'" class="editing">Editing custom template</span>
        </div>

        <div v-if="activeError" class="feedback error" role="alert">
          {{ activeError }}
        </div>
        <div v-else-if="templates.savedMessage" class="feedback saved">
          {{ templates.savedMessage }}
        </div>

        <div class="actions">
          <BaseButton v-if="canEditSelected" variant="secondary" @click="startEdit">Edit</BaseButton>
          <BaseButton
            v-if="selectedTemplate"
            variant="secondary"
            :loading="templates.duplicatingId === selectedTemplateActionKey"
            @click="duplicateSelected"
          >
            Duplicate
          </BaseButton>
          <BaseButton
            v-if="selectedTemplate"
            variant="secondary"
            :loading="templates.applyingId === selectedTemplateActionKey"
            @click="applySelected"
          >
            Apply
          </BaseButton>
          <BaseButton
            v-if="canArchiveSelected"
            variant="danger"
            :loading="templates.archivingId === selectedTemplateActionKey"
            @click="archiveSelected"
          >
            {{ confirmingArchive === selectedTemplateActionKey ? 'Confirm archive' : 'Archive' }}
          </BaseButton>
          <span class="spacer" />
          <BaseButton v-if="mode !== 'view'" variant="ghost" :disabled="templates.saving" @click="cancelEdit">Cancel</BaseButton>
          <BaseButton v-if="mode !== 'view'" variant="primary" :loading="templates.saving" :disabled="!canSave" @click="saveTemplate">
            Save
          </BaseButton>
        </div>

        <div class="form-grid">
          <label class="field">
            <span>Name</span>
            <input v-model="form.name" :disabled="selectedIsReadonly" maxlength="160" placeholder="Template name" />
          </label>
          <label class="field">
            <span>Start stage</span>
            <select v-model="form.fromStage" :disabled="selectedIsReadonly">
              <option v-for="stage in TIGER_STAGES" :key="stage.id" :value="stage.id">
                {{ stage.number }} - {{ stage.title }}
              </option>
            </select>
          </label>
          <label class="field wide">
            <span>Description</span>
            <input v-model="form.description" :disabled="selectedIsReadonly" placeholder="Optional description" />
          </label>
        </div>

        <div class="stage-list">
          <details v-for="stage in TIGER_STAGES" :key="stage.id" :open="stage.id === form.fromStage">
            <summary>
              <span class="stage-number">{{ stage.number }}</span>
              <b>{{ stage.title }}</b>
              <small>{{ stageSummary(stage.id) }}</small>
            </summary>
            <div class="stage-body">
              <StageConfigPanel
                v-if="tiger.config"
                :config="tiger.config"
                :stage="stage.id"
                :cfg="form.configs[stage.id]"
                :disabled="selectedIsReadonly"
              />
              <p v-else class="state">Loading configuration...</p>
            </div>
          </details>
        </div>
      </section>
    </main>
  </div>
</template>

<style scoped>
.templates-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.topbar {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.title {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.title b {
  font-size: 15px;
}
.title span {
  color: var(--text-dim);
  font-size: 12px;
}
.spacer {
  flex: 1;
}
.layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
}
.sidebar {
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 14px;
}
.side-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.side-head span {
  font-weight: 700;
}
.template-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.template-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  border: 1px solid var(--border);
  background: var(--bg);
  padding: 10px;
}
.template-row:hover,
.template-row.selected {
  border-color: var(--accent);
}
.template-row.selected {
  background: var(--accent-soft);
}
.row-main {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.row-main b,
.row-main small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.row-main small {
  color: var(--text-dim);
  font-size: 11px;
}
.badge,
.readonly,
.editing {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  text-transform: uppercase;
}
.badge.builtin,
.readonly {
  color: var(--accent);
  border-color: var(--accent);
}
.editing {
  color: var(--green);
  border-color: var(--green);
}
.state {
  display: grid;
  gap: 8px;
  color: var(--text-dim);
  font-size: 13px;
  line-height: 1.4;
}
.state.error {
  color: var(--red);
}
.state.empty {
  color: var(--text-faint);
}
.editor {
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
}
.editor-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}
.editor-head h2 {
  margin: 2px 0 0;
  font-size: 20px;
}
.eyebrow {
  margin: 0;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 700;
  text-transform: uppercase;
}
.feedback {
  margin-bottom: 12px;
  padding: 9px 11px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  font-size: 13px;
}
.feedback.error {
  color: var(--red);
  border-color: var(--red);
  background: rgba(229, 86, 75, 0.08);
}
.feedback.saved {
  color: var(--green);
  border-color: var(--green);
  background: rgba(108, 197, 108, 0.08);
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 14px;
}
.form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) 220px;
  gap: 12px;
  margin-bottom: 14px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.field.wide {
  grid-column: 1 / -1;
}
.field span {
  color: var(--text-dim);
  font-size: 12px;
  font-weight: 600;
}
.stage-list {
  display: grid;
  gap: 8px;
}
details {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
summary {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  cursor: pointer;
}
summary small {
  margin-left: auto;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
}
.stage-number {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-weight: 700;
}
.stage-body {
  padding: 4px 12px 12px;
  border-top: 1px solid var(--border);
}
@media (max-width: 900px) {
  .layout {
    grid-template-columns: 1fr;
  }
  .sidebar {
    max-height: 260px;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .form-grid {
    grid-template-columns: 1fr;
  }
}
</style>

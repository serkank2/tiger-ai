<script setup lang="ts">
import { computed, onMounted, reactive, ref, watch } from 'vue';
import type {
  PromptFile,
  TeamTemplate,
  TigerRunTemplate,
  TigerRunTemplatePayload,
  TigerStageId,
  TigerStageRunConfig,
} from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';
import { cloneStageConfigs, fullStageConfigs } from '~/lib/tigerTemplateConfig';
import { useTeamStore } from '~/stores/team';
import { usePromptsStore } from '~/stores/prompts';
import { useT } from '~/composables/useT';
import { useCueStore } from '~/stores/cue';
import { templateRef, useTemplatesStore } from '~/stores/templates';
import { useTigerStore } from '~/stores/tiger';
import BaseButton from '~/components/ui/BaseButton.vue';
import PromptLibrary from '~/components/prompt/PromptLibrary.vue';
import TeamTemplateEditor from '~/components/team/TeamTemplateEditor.vue';
import CueSubscriptionCard from '~/components/cue/CueSubscriptionCard.vue';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';

const emit = defineEmits<{ back: []; openTiger: [] }>();
const { t } = useT();

type TemplateCategory = 'team-structure' | 'prompt-library' | 'cue-config' | 'tiger-run-templates';
type RunTemplateEditorMode = 'new' | 'edit';

const categories = computed<Array<{ key: TemplateCategory; title: string; description: string; ready: boolean }>>(
  () => [
    {
      key: 'team-structure',
      title: t('templates.categories.teamStructure.title'),
      description: t('templates.categories.teamStructure.description'),
      ready: true,
    },
    {
      key: 'prompt-library',
      title: t('templates.categories.promptLibrary.title'),
      description: t('templates.categories.promptLibrary.description'),
      ready: true,
    },
    {
      key: 'cue-config',
      title: t('templates.categories.cueConfig.title'),
      description: t('templates.categories.cueConfig.description'),
      ready: true,
    },
    {
      key: 'tiger-run-templates',
      title: t('templates.categories.tigerRunTemplates.title'),
      description: t('templates.categories.tigerRunTemplates.description'),
      ready: true,
    },
  ],
);

const team = useTeamStore();
const prompts = usePromptsStore();
const cue = useCueStore();
const runTemplates = useTemplatesStore();
const tiger = useTigerStore();
const activeCategory = ref<TemplateCategory>('team-structure');
const selectedTemplateId = ref<string | null>(null);
const editorOpen = ref(false);
const editorTemplate = ref<TeamTemplate | null>(null);
const deletingTemplateId = ref<string | null>(null);
const selectedPromptPath = ref<string | null>(null);
const selectedPrompt = ref<PromptFile | null>(null);
const promptOpenError = ref('');
const selectedRunTemplateRef = ref<string | null>(null);
const runTemplateEditorMode = ref<RunTemplateEditorMode | null>(null);
const runTemplateEditorTemplate = ref<TigerRunTemplate | null>(null);
const runTemplateForm = reactive<{
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

const activeCategoryMeta = computed(
  () => categories.value.find((category) => category.key === activeCategory.value) ?? categories.value[0]!,
);
const selectedTemplate = computed(
  () => team.templates.find((template) => template.id === selectedTemplateId.value) ?? team.templates[0] ?? null,
);
const selectedRunTemplate = computed(
  () =>
    runTemplates.items.find((template) => templateRef(template) === selectedRunTemplateRef.value) ??
    runTemplates.items[0] ??
    null,
);
const selectedRunTemplateConfigs = computed(() => fullStageConfigs(tiger.config, selectedRunTemplate.value));
const runTemplateGroups = computed(() =>
  [
    { key: 'builtins', title: t('templates.runGroups.builtins'), items: runTemplates.builtins },
    { key: 'custom', title: t('templates.runGroups.custom'), items: runTemplates.custom },
  ].filter((group) => group.items.length),
);
const canSaveRunTemplate = computed(
  () =>
    !!runTemplateEditorMode.value &&
    !!tiger.config &&
    !!runTemplateForm.name.trim() &&
    !runTemplates.saving &&
    (runTemplateEditorMode.value !== 'edit' || !!runTemplateEditorTemplate.value?.id),
);
const teamTemplateError = computed(() => team.actionError || team.loadError);
const promptLibraryError = computed(() => promptOpenError.value || prompts.loadError);

function selectCategory(category: TemplateCategory): void {
  activeCategory.value = category;
  if (category === 'team-structure') void loadTeamTemplates();
  if (category === 'prompt-library') void loadPromptLibrary();
  if (category === 'cue-config') void loadCueConfig();
  if (category === 'tiger-run-templates') void loadTigerTemplates();
}

async function loadTeamTemplates(force = false): Promise<void> {
  try {
    await team.loadTemplates(force);
  } catch {
    /* the team store exposes loadError and actionError inline */
  }
}

async function loadPromptLibrary(): Promise<void> {
  promptOpenError.value = '';
  try {
    await prompts.fetchAll();
    ensureSelectedPrompt();
  } catch {
    /* the prompts store exposes loadError inline */
  }
}

async function loadCueConfig(): Promise<void> {
  try {
    await cue.load();
  } catch {
    /* the cue store exposes loadError and disabled inline */
  }
}

async function reloadCueConfig(): Promise<void> {
  try {
    await cue.reload();
  } catch {
    /* the cue store exposes loadError and disabled inline */
  }
}

async function triggerCue(id: string): Promise<void> {
  try {
    await cue.trigger(id);
  } catch {
    /* the cue store exposes loadError inline */
  }
}

async function loadTigerTemplates(force = false): Promise<void> {
  try {
    await Promise.all([runTemplates.load(force), tiger.config ? Promise.resolve() : tiger.load()]);
    ensureSelectedRunTemplate();
  } catch {
    /* the templates and tiger stores expose load errors inline */
  }
}

function ensureSelectedTemplate(): void {
  if (selectedTemplateId.value && team.templates.some((template) => template.id === selectedTemplateId.value)) return;
  selectedTemplateId.value = team.templates[0]?.id ?? null;
}

function ensureSelectedPrompt(): void {
  if (selectedPromptPath.value && prompts.items.some((prompt) => prompt.path === selectedPromptPath.value)) return;
  selectedPromptPath.value = prompts.items[0]?.path ?? null;
  if (!selectedPromptPath.value) selectedPrompt.value = null;
}

function ensureSelectedRunTemplate(): void {
  if (
    selectedRunTemplateRef.value &&
    runTemplates.items.some((template) => templateRef(template) === selectedRunTemplateRef.value)
  ) {
    return;
  }
  selectedRunTemplateRef.value = runTemplates.items[0] ? templateRef(runTemplates.items[0]) : null;
}

function selectTemplate(template: TeamTemplate): void {
  selectedTemplateId.value = template.id;
  deletingTemplateId.value = null;
}

function selectRunTemplate(template: TigerRunTemplate): void {
  selectedRunTemplateRef.value = templateRef(template);
}

function replaceRunTemplateFormConfigs(template: Pick<TigerRunTemplate, 'configs'> | null = null): void {
  runTemplateForm.configs = fullStageConfigs(tiger.config, template);
}

function openNewRunTemplate(): void {
  runTemplates.clearFeedback();
  runTemplateEditorMode.value = 'new';
  runTemplateEditorTemplate.value = null;
  runTemplateForm.name = '';
  runTemplateForm.description = '';
  runTemplateForm.fromStage = 'brainstorming';
  replaceRunTemplateFormConfigs(null);
}

function openEditRunTemplate(template: TigerRunTemplate): void {
  if (template.builtin) return;
  runTemplates.clearFeedback();
  runTemplateEditorMode.value = 'edit';
  runTemplateEditorTemplate.value = template;
  runTemplateForm.name = template.name;
  runTemplateForm.description = template.description ?? '';
  runTemplateForm.fromStage = template.fromStage ?? 'brainstorming';
  replaceRunTemplateFormConfigs(template);
}

function closeRunTemplateEditor(): void {
  runTemplateEditorMode.value = null;
  runTemplateEditorTemplate.value = null;
  runTemplates.clearFeedback();
}

function openCreate(template: TeamTemplate | null = null): void {
  editorTemplate.value = template;
  editorOpen.value = true;
}

function openEdit(template: TeamTemplate): void {
  editorTemplate.value = template;
  editorOpen.value = true;
}

function closeEditor(): void {
  editorOpen.value = false;
  editorTemplate.value = null;
}

function onTemplateSaved(template: TeamTemplate): void {
  selectedTemplateId.value = template.id;
  closeEditor();
}

async function duplicateTemplate(template: TeamTemplate): Promise<void> {
  try {
    const copy = await team.duplicateTemplate(template.id);
    selectedTemplateId.value = copy.id;
  } catch {
    /* the team store exposes actionError inline */
  }
}

async function deleteTemplate(template: TeamTemplate): Promise<void> {
  if (template.builtin) return;
  if (deletingTemplateId.value !== template.id) {
    deletingTemplateId.value = template.id;
    return;
  }
  try {
    await team.deleteTemplate(template.id);
    deletingTemplateId.value = null;
    ensureSelectedTemplate();
  } catch {
    /* the team store exposes actionError inline */
  }
}

async function openPrompt(path: string): Promise<void> {
  promptOpenError.value = '';
  selectedPromptPath.value = path;
  const prompt = await prompts.open(path);
  if (prompt) {
    selectedPrompt.value = prompt;
    return;
  }
  promptOpenError.value = `Could not open ${path}.`;
}

async function removePrompt(path: string): Promise<void> {
  if (!(await prompts.remove(path))) return;
  if (selectedPromptPath.value === path) {
    selectedPromptPath.value = null;
    selectedPrompt.value = null;
  }
  ensureSelectedPrompt();
}

async function renamePrompt(from: string, to: string): Promise<void> {
  const dest = to.toLowerCase().endsWith('.md') ? to : `${to}.md`;
  const prompt = await prompts.rename(from, dest);
  if (prompt && selectedPromptPath.value === from) {
    selectedPromptPath.value = prompt.path;
    selectedPrompt.value = prompt;
  }
}

async function duplicateRunTemplate(template: TigerRunTemplate): Promise<void> {
  try {
    const copy = await runTemplates.duplicate(template);
    selectedRunTemplateRef.value = templateRef(copy);
  } catch {
    /* the templates store exposes operationError inline */
  }
}

async function archiveRunTemplate(template: TigerRunTemplate): Promise<void> {
  if (template.builtin) return;
  try {
    await runTemplates.archive(template);
    ensureSelectedRunTemplate();
  } catch {
    /* the templates store exposes operationError inline */
  }
}

async function saveRunTemplate(): Promise<void> {
  if (!canSaveRunTemplate.value || !tiger.config) return;
  const payload: TigerRunTemplatePayload = {
    name: runTemplateForm.name.trim(),
    description: runTemplateForm.description.trim() || undefined,
    fromStage: runTemplateForm.fromStage,
    configs: cloneStageConfigs(tiger.config, runTemplateForm.configs),
  };

  try {
    const saved =
      runTemplateEditorMode.value === 'new'
        ? await runTemplates.create(payload)
        : runTemplateEditorTemplate.value?.id
          ? await runTemplates.update(runTemplateEditorTemplate.value.id, payload)
          : null;
    if (saved) selectedRunTemplateRef.value = templateRef(saved);
    closeRunTemplateEditor();
  } catch {
    /* the templates store exposes operationError inline and the editor stays open */
  }
}

function runStageTitle(stageId?: TigerStageId): string {
  return TIGER_STAGES.find((stage) => stage.id === stageId)?.title ?? 'Brainstorming';
}

function runStageSummary(stageId: TigerStageId): string {
  const cfg = selectedRunTemplateConfigs.value[stageId];
  if (stageId === 'merge-tasks') return `merge: ${cfg.mergeAgent ?? 'claude'}`;
  const parts = [`${cfg.claudeAgents} Claude`, `${cfg.codexAgents} Codex`];
  if (cfg.antigravityAgents > 0) parts.push(`${cfg.antigravityAgents} Antigravity`);
  return parts.join(', ');
}

onMounted(() => {
  void loadTeamTemplates();
});

watch(() => team.templates.map((template) => template.id).join('\0'), ensureSelectedTemplate);

watch(() => prompts.items.map((prompt) => prompt.path).join('\0'), ensureSelectedPrompt);

watch(() => runTemplates.items.map((template) => templateRef(template)).join('\0'), ensureSelectedRunTemplate);
</script>

<template>
  <div class="templates-page">
    <header class="topbar">
      <div class="title">
        <b>{{ t('templates.title') }}</b>
        <span>{{ t('templates.subtitle') }}</span>
      </div>
      <span class="spacer" />
      <BaseButton variant="secondary" @click="emit('openTiger')">{{ t('templates.tigerButton') }}</BaseButton>
      <BaseButton variant="ghost" @click="emit('back')">{{ t('common.back') }}</BaseButton>
    </header>

    <main class="template-shell">
      <aside class="category-sidebar" :aria-label="t('templates.categoriesLabel')">
        <button
          v-for="category in categories"
          :key="category.key"
          type="button"
          class="category-row"
          :class="{ active: activeCategory === category.key, pending: !category.ready }"
          :aria-pressed="activeCategory === category.key"
          @click="selectCategory(category.key)"
        >
          <span>
            <b>{{ category.title }}</b>
            <small>{{ category.description }}</small>
          </span>
          <em>{{ category.ready ? t('templates.ready') : t('templates.comingNext') }}</em>
        </button>
      </aside>

      <section class="content-pane" :aria-labelledby="`${activeCategory}-heading`">
        <template v-if="activeCategory === 'team-structure'">
          <header class="pane-head">
            <div>
              <p class="eyebrow">{{ t('templates.team.eyebrow') }}</p>
              <h2 :id="`${activeCategory}-heading`">{{ t('templates.categories.teamStructure.title') }}</h2>
              <span>{{ t('templates.team.intro') }}</span>
            </div>
            <div class="pane-actions">
              <BaseButton variant="secondary" :loading="team.templatesLoading" @click="loadTeamTemplates(true)">{{
                t('common.refresh')
              }}</BaseButton>
              <BaseButton variant="primary" @click="openCreate()">{{ t('templates.team.new') }}</BaseButton>
            </div>
          </header>

          <div v-if="teamTemplateError" class="feedback error" role="alert">
            {{ teamTemplateError }}
          </div>

          <div v-if="team.templatesLoading && !team.templatesLoaded" class="state">
            {{ t('templates.team.loading') }}
          </div>

          <div v-else-if="!team.templates.length" class="empty-state">
            <b>{{ t('templates.team.emptyTitle') }}</b>
            <span>{{ t('templates.team.emptyDesc') }}</span>
            <BaseButton variant="primary" @click="openCreate()">{{ t('templates.team.create') }}</BaseButton>
          </div>

          <div v-else class="team-template-layout">
            <div class="template-list" :aria-label="t('templates.team.listLabel')">
              <button
                v-for="template in team.templates"
                :key="template.id"
                type="button"
                class="template-row"
                :class="{ selected: selectedTemplate?.id === template.id }"
                @click="selectTemplate(template)"
              >
                <span>
                  <b>{{ template.name }}</b>
                  <small>{{
                    template.description || t('templates.team.roleCount', { n: template.roles.length })
                  }}</small>
                </span>
                <em>{{ template.builtin ? t('templates.builtin') : t('templates.custom') }}</em>
              </button>
            </div>

            <article v-if="selectedTemplate" class="template-detail">
              <header>
                <p class="eyebrow">{{ selectedTemplate.builtin ? t('templates.builtin') : t('templates.custom') }}</p>
                <h3>{{ selectedTemplate.name }}</h3>
                <span>{{ selectedTemplate.description || t('templates.noDescription') }}</span>
              </header>

              <div class="role-list">
                <div v-for="role in selectedTemplate.roles" :key="role.id" class="role-row">
                  <span>
                    <b>{{ role.name }}</b>
                    <small>{{ role.agent.tool }}{{ role.agent.model ? ` / ${role.agent.model}` : '' }}</small>
                  </span>
                  <em v-if="role.requiredForSignoff">{{ t('templates.team.signoff') }}</em>
                  <em v-if="role.canWriteCode">{{ t('templates.team.writer') }}</em>
                </div>
              </div>

              <div class="detail-actions">
                <BaseButton v-if="selectedTemplate.builtin" variant="secondary" @click="openCreate(selectedTemplate)">{{
                  t('templates.team.newFromBuiltin')
                }}</BaseButton>
                <BaseButton v-else variant="secondary" @click="openEdit(selectedTemplate)">{{
                  t('common.edit')
                }}</BaseButton>
                <BaseButton
                  variant="secondary"
                  :loading="team.isBusy('template')"
                  @click="duplicateTemplate(selectedTemplate)"
                >
                  {{ t('templates.duplicate') }}
                </BaseButton>
                <BaseButton
                  v-if="!selectedTemplate.builtin"
                  variant="danger"
                  :loading="team.isBusy('template')"
                  @click="deleteTemplate(selectedTemplate)"
                >
                  {{ deletingTemplateId === selectedTemplate.id ? t('templates.confirmDelete') : t('common.delete') }}
                </BaseButton>
              </div>
            </article>
          </div>

          <TeamTemplateEditor
            v-if="editorOpen"
            :template="editorTemplate"
            @saved="onTemplateSaved"
            @close="closeEditor"
          />
        </template>

        <template v-else-if="activeCategory === 'prompt-library'">
          <header class="pane-head">
            <div>
              <p class="eyebrow">{{ t('templates.categories.promptLibrary.title') }}</p>
              <h2 :id="`${activeCategory}-heading`">{{ t('templates.categories.promptLibrary.title') }}</h2>
              <span>{{ t('templates.prompt.intro') }}</span>
            </div>
            <div class="pane-actions">
              <BaseButton variant="secondary" :loading="prompts.loading" @click="loadPromptLibrary">{{
                t('common.refresh')
              }}</BaseButton>
            </div>
          </header>

          <div v-if="promptLibraryError" class="feedback error" role="alert">
            {{ promptLibraryError }}
          </div>

          <div v-if="prompts.loading && !prompts.loaded" class="state">
            {{ t('templates.prompt.loading') }}
          </div>

          <div v-else-if="prompts.loaded && !prompts.items.length" class="empty-state">
            <b>{{ t('templates.prompt.emptyTitle') }}</b>
            <span>{{ t('templates.prompt.emptyDesc') }}</span>
            <BaseButton variant="secondary" :loading="prompts.loading" @click="loadPromptLibrary">{{
              t('templates.prompt.refreshLibrary')
            }}</BaseButton>
          </div>

          <div v-else class="prompt-library-layout">
            <section class="prompt-library-list" :aria-label="t('templates.prompt.listLabel')">
              <PromptLibrary
                :items="prompts.items"
                :current-path="selectedPromptPath"
                :dirty="false"
                :loading="prompts.loading && !prompts.loaded"
                :error="prompts.loadError"
                @open="openPrompt"
                @remove="removePrompt"
                @rename="renamePrompt"
                @refresh="loadPromptLibrary"
              />
            </section>

            <article class="prompt-detail">
              <template v-if="selectedPrompt">
                <header>
                  <p class="eyebrow">{{ t('templates.prompt.selected') }}</p>
                  <h3>{{ selectedPrompt.title || selectedPrompt.path }}</h3>
                  <span>{{ selectedPrompt.path }}</span>
                </header>
                <p v-if="selectedPrompt.description" class="prompt-description">{{ selectedPrompt.description }}</p>
                <div
                  v-if="selectedPrompt.tags?.length"
                  class="prompt-tags"
                  :aria-label="t('templates.prompt.tagsLabel')"
                >
                  <span v-for="tag in selectedPrompt.tags" :key="tag">{{ tag }}</span>
                </div>
                <pre>{{ selectedPrompt.body }}</pre>
              </template>
              <template v-else>
                <p class="eyebrow">{{ t('templates.prompt.selected') }}</p>
                <h3>{{ t('templates.prompt.selectTitle') }}</h3>
                <span>{{ t('templates.prompt.selectDesc') }}</span>
              </template>
            </article>
          </div>
        </template>

        <template v-else-if="activeCategory === 'cue-config'">
          <header class="pane-head">
            <div>
              <p class="eyebrow">{{ t('templates.categories.cueConfig.title') }}</p>
              <h2 :id="`${activeCategory}-heading`">{{ t('templates.categories.cueConfig.title') }}</h2>
              <span>{{ t('templates.cue.intro') }}</span>
            </div>
            <div class="pane-actions">
              <span v-if="cue.running" class="cue-status running">{{ t('templates.cue.running') }}</span>
              <span v-else-if="cue.loaded && !cue.disabled" class="cue-status stopped">{{
                t('templates.cue.stopped')
              }}</span>
              <BaseButton variant="secondary" :loading="cue.loading" @click="loadCueConfig">{{
                t('templates.cue.refreshStatus')
              }}</BaseButton>
              <BaseButton
                variant="secondary"
                :loading="cue.isBusy('reload')"
                :disabled="cue.disabled"
                @click="reloadCueConfig"
              >
                {{ t('cue.actions.reloadConfig') }}
              </BaseButton>
            </div>
          </header>

          <div v-if="cue.loading && !cue.loaded" class="state">
            {{ t('templates.cue.loading') }}
          </div>

          <div v-else-if="cue.disabled" class="empty-state cue-disabled">
            <b>{{ t('templates.cue.disabledTitle') }}</b>
            <span>{{ t('templates.cue.disabledDesc') }}</span>
            <BaseButton variant="secondary" :loading="cue.loading" @click="loadCueConfig">{{
              t('templates.cue.refreshCueStatus')
            }}</BaseButton>
          </div>

          <div v-else-if="cue.loadError" class="feedback error" role="alert">
            {{ cue.loadError }}
          </div>

          <div v-else-if="cue.loaded && !cue.subscriptions.length" class="empty-state">
            <b>{{ t('templates.cue.emptyTitle') }}</b>
            <span>{{ t('templates.cue.emptyDesc') }}</span>
            <BaseButton variant="secondary" :loading="cue.isBusy('reload')" @click="reloadCueConfig">{{
              t('cue.actions.reloadConfig')
            }}</BaseButton>
          </div>

          <div v-else class="cue-config-layout">
            <p class="cue-context">
              <span v-if="cue.workspace"
                >{{ t('cue.context.workspace') }}: <code>{{ cue.workspace }}</code></span
              >
              <span v-else>{{ t('cue.context.noWorkspace') }}</span>
              <span v-if="cue.configPath">
                / {{ t('cue.context.config') }}: <code>{{ cue.configPath }}</code></span
              >
            </p>
            <div class="cue-card-grid" :aria-label="t('templates.cue.subscriptionsLabel')">
              <CueSubscriptionCard
                v-for="sub in cue.subscriptions"
                :key="sub.id"
                :sub="sub"
                :busy="cue.isBusy(`trigger:${sub.id}`)"
                @trigger="triggerCue"
              />
            </div>
          </div>
        </template>

        <template v-else-if="activeCategory === 'tiger-run-templates'">
          <header class="pane-head">
            <div>
              <p class="eyebrow">{{ t('templates.categories.tigerRunTemplates.title') }}</p>
              <h2 :id="`${activeCategory}-heading`">{{ t('templates.categories.tigerRunTemplates.title') }}</h2>
              <span>{{ t('templates.runTemplates.intro') }}</span>
            </div>
            <div class="pane-actions">
              <BaseButton
                variant="secondary"
                :loading="runTemplates.loading || tiger.loading"
                @click="loadTigerTemplates(true)"
                >{{ t('common.refresh') }}</BaseButton
              >
              <BaseButton variant="primary" @click="openNewRunTemplate">{{
                t('templates.runTemplates.new')
              }}</BaseButton>
            </div>
          </header>

          <div v-if="runTemplates.loadError" class="feedback error" role="alert">
            {{ runTemplates.loadError }}
          </div>
          <div v-if="runTemplates.operationError" class="feedback error" role="alert">
            {{ runTemplates.operationError }}
          </div>

          <section
            v-if="runTemplateEditorMode"
            class="run-template-editor"
            :aria-label="t('templates.runTemplates.editorLabel')"
          >
            <header>
              <p class="eyebrow">
                {{
                  runTemplateEditorMode === 'new'
                    ? t('templates.runTemplates.newTemplate')
                    : t('templates.runTemplates.editTemplate')
                }}
              </p>
              <h3>
                {{
                  runTemplateEditorMode === 'new'
                    ? t('templates.runTemplates.createTitle')
                    : t('templates.runTemplates.editTitle', {
                        name: runTemplateEditorTemplate?.name ?? t('templates.runTemplates.fallbackName'),
                      })
                }}
              </h3>
            </header>

            <div class="run-template-form-grid">
              <label class="form-field">
                <span>{{ t('templates.runTemplates.name') }}</span>
                <input
                  v-model="runTemplateForm.name"
                  data-testid="run-template-name"
                  maxlength="160"
                  :placeholder="t('templates.placeholders.name')"
                />
              </label>
              <label class="form-field">
                <span>{{ t('templates.runTemplates.startFrom') }}</span>
                <select v-model="runTemplateForm.fromStage" data-testid="run-template-from-stage">
                  <option v-for="stage in TIGER_STAGES" :key="stage.id" :value="stage.id">
                    {{ stage.number }} - {{ stage.title }}
                  </option>
                </select>
              </label>
              <label class="form-field wide">
                <span>{{ t('templates.runTemplates.description') }}</span>
                <textarea
                  v-model="runTemplateForm.description"
                  data-testid="run-template-description"
                  rows="2"
                  :placeholder="t('templates.placeholders.description')"
                />
              </label>
            </div>

            <div v-if="!tiger.config" class="empty-state run-template-config-missing">
              <b>{{ t('templates.runTemplates.loadingConfig') }}</b>
              <span>{{ t('templates.runTemplates.configMissingDesc') }}</span>
              <BaseButton
                variant="secondary"
                :loading="runTemplates.loading || tiger.loading"
                @click="loadTigerTemplates(true)"
                >{{ t('templates.runTemplates.refreshConfig') }}</BaseButton
              >
            </div>

            <div
              v-else
              class="run-stage-list editor-run-stage-list"
              :aria-label="t('templates.runTemplates.editableStagesLabel')"
            >
              <details v-for="stage in TIGER_STAGES" :key="stage.id" :open="stage.id === runTemplateForm.fromStage">
                <summary>
                  <span class="stage-number">{{ stage.number }}</span>
                  <span class="stage-title">{{ stage.title }}</span>
                  <span v-if="stage.optional" class="stage-badge">{{ t('templates.runTemplates.optional') }}</span>
                </summary>
                <div class="run-stage-body">
                  <StageConfigPanel
                    :config="tiger.config"
                    :stage="stage.id"
                    :cfg="runTemplateForm.configs[stage.id]"
                    @update:cfg="(next) => (runTemplateForm.configs[stage.id] = next)"
                  />
                </div>
              </details>
            </div>

            <div class="detail-actions">
              <BaseButton variant="ghost" :disabled="runTemplates.saving" @click="closeRunTemplateEditor">{{
                t('common.cancel')
              }}</BaseButton>
              <BaseButton
                variant="primary"
                :loading="runTemplates.saving"
                :disabled="!canSaveRunTemplate"
                @click="saveRunTemplate"
              >
                {{ t('templates.runTemplates.saveTemplate') }}
              </BaseButton>
            </div>
          </section>

          <div v-if="runTemplates.loading && !runTemplates.loaded" class="state">
            {{ t('templates.runTemplates.loading') }}
          </div>

          <div v-else-if="runTemplates.loadError && !runTemplates.loaded" class="state">
            {{ t('templates.runTemplates.loadFailed') }}
          </div>

          <div v-else-if="runTemplates.loaded && !runTemplates.items.length" class="empty-state">
            <b>{{ t('templates.runTemplates.emptyTitle') }}</b>
            <span>{{ t('templates.runTemplates.emptyDesc') }}</span>
            <BaseButton
              variant="secondary"
              :loading="runTemplates.loading || tiger.loading"
              @click="loadTigerTemplates(true)"
              >{{ t('templates.runTemplates.refreshTemplates') }}</BaseButton
            >
          </div>

          <div v-else class="run-template-layout">
            <section class="run-template-list" :aria-label="t('templates.runTemplates.listLabel')">
              <div v-for="group in runTemplateGroups" :key="group.key" class="run-template-group">
                <p class="eyebrow">{{ group.title }}</p>
                <button
                  v-for="template in group.items"
                  :key="templateRef(template)"
                  type="button"
                  class="template-row run-template-row"
                  :class="{
                    selected: selectedRunTemplate && templateRef(selectedRunTemplate) === templateRef(template),
                  }"
                  @click="selectRunTemplate(template)"
                >
                  <span>
                    <b>{{ template.name }}</b>
                    <small>{{
                      template.description ||
                      t('templates.runTemplates.startsFrom', { stage: runStageTitle(template.fromStage) })
                    }}</small>
                  </span>
                  <em>{{ template.builtin ? t('templates.builtin') : t('templates.custom') }}</em>
                </button>
              </div>
            </section>

            <article v-if="selectedRunTemplate" class="template-detail run-template-detail">
              <header>
                <p class="eyebrow">
                  {{ selectedRunTemplate.builtin ? t('templates.builtin') : t('templates.custom') }}
                </p>
                <h3>{{ selectedRunTemplate.name }}</h3>
                <span>{{ selectedRunTemplate.description || t('templates.noDescription') }}</span>
              </header>

              <div class="run-template-meta">
                <span
                  >{{ t('templates.runTemplates.startsFromLabel') }}
                  <b>{{ runStageTitle(selectedRunTemplate.fromStage) }}</b></span
                >
                <span>{{
                  selectedRunTemplate.builtin
                    ? t('templates.runTemplates.builtinTemplate')
                    : t('templates.runTemplates.customTemplate')
                }}</span>
              </div>

              <div class="detail-actions">
                <BaseButton
                  variant="secondary"
                  :loading="runTemplates.duplicatingId === templateRef(selectedRunTemplate)"
                  @click="duplicateRunTemplate(selectedRunTemplate)"
                >
                  {{ t('templates.duplicate') }}
                </BaseButton>
                <BaseButton
                  v-if="!selectedRunTemplate.builtin"
                  variant="secondary"
                  @click="openEditRunTemplate(selectedRunTemplate)"
                >
                  {{ t('common.edit') }}
                </BaseButton>
                <BaseButton
                  v-if="!selectedRunTemplate.builtin"
                  variant="danger"
                  :loading="runTemplates.archivingId === templateRef(selectedRunTemplate)"
                  @click="archiveRunTemplate(selectedRunTemplate)"
                >
                  {{ t('templates.runTemplates.archive') }}
                </BaseButton>
              </div>

              <div class="run-stage-list" :aria-label="t('templates.runTemplates.stagesLabel')">
                <details
                  v-for="stage in TIGER_STAGES"
                  :key="stage.id"
                  :open="
                    selectedRunTemplate.fromStage
                      ? stage.id === selectedRunTemplate.fromStage
                      : stage.id === 'brainstorming'
                  "
                >
                  <summary>
                    <span class="stage-number">{{ stage.number }}</span>
                    <span class="stage-title">{{ stage.title }}</span>
                    <span v-if="stage.optional" class="stage-badge">{{ t('templates.runTemplates.optional') }}</span>
                    <span class="stage-summary">{{ runStageSummary(stage.id) }}</span>
                  </summary>
                  <div class="run-stage-body">
                    <StageConfigPanel
                      v-if="tiger.config"
                      :config="tiger.config"
                      :stage="stage.id"
                      :cfg="selectedRunTemplateConfigs[stage.id]"
                      disabled
                    />
                    <p v-else class="state">{{ t('templates.runTemplates.loadingConfig') }}</p>
                  </div>
                </details>
              </div>
            </article>
          </div>
        </template>

        <div v-else class="coming-next">
          <p class="eyebrow">{{ t('templates.comingNext') }}</p>
          <h2 :id="`${activeCategory}-heading`">{{ activeCategoryMeta.title }}</h2>
          <span>{{ activeCategoryMeta.description }}</span>
          <p>{{ t('templates.comingSoon') }}</p>
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
  font-size: var(--text-md);
}
.title span,
.pane-head span,
.template-detail header span,
.coming-next span {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.spacer {
  flex: 1;
}
.template-shell {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 300px minmax(0, 1fr);
}
.category-sidebar {
  min-height: 0;
  overflow-y: auto;
  border-right: 1px solid var(--border);
  background: var(--bg-elev);
  padding: 14px;
}
.category-row {
  width: 100%;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 10px;
  text-align: left;
  align-items: center;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  border-radius: var(--radius-sm);
  padding: 11px;
  margin-bottom: 8px;
}
.category-row:hover,
.category-row.active {
  border-color: var(--accent);
}
.category-row.active {
  background: var(--accent-soft);
}
.category-row.pending {
  opacity: 0.75;
}
.category-row span,
.template-row span,
.role-row span {
  min-width: 0;
  display: grid;
  gap: 4px;
}
.category-row small,
.template-row small,
.role-row small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.category-row em,
.template-row em,
.role-row em {
  font-style: normal;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 2px 7px;
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.content-pane {
  min-height: 0;
  overflow-y: auto;
  padding: 18px;
}
.pane-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}
.pane-head h2,
.coming-next h2 {
  margin: 2px 0 4px;
  font-size: 22px;
}
.pane-actions,
.detail-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.cue-status {
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
}
.cue-status.running {
  color: var(--green);
  border-color: var(--green);
}
.cue-status.stopped {
  color: var(--text-faint);
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
  font-size: var(--text-sm);
}
.feedback.error {
  color: var(--red);
  border-color: var(--red);
  background: var(--red-soft);
}
.state,
.empty-state,
.coming-next {
  display: grid;
  gap: 10px;
  align-content: start;
  color: var(--text-dim);
  font-size: var(--text-sm);
}
.empty-state,
.coming-next {
  max-width: 560px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 16px;
}
.empty-state b {
  color: var(--text);
}
.team-template-layout {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
}
.run-template-layout {
  display: grid;
  grid-template-columns: minmax(260px, 340px) minmax(0, 1fr);
  gap: 14px;
  min-height: 0;
}
.prompt-library-layout {
  display: grid;
  grid-template-columns: minmax(260px, 360px) minmax(0, 1fr);
  gap: 14px;
  min-height: 480px;
}
.prompt-library-list {
  min-height: 0;
}
.prompt-detail {
  min-width: 0;
  min-height: 0;
  display: grid;
  align-content: start;
  gap: 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 14px;
}
.prompt-detail h3 {
  margin: 2px 0 4px;
  font-size: 18px;
}
.prompt-description {
  margin: 0;
  color: var(--text-dim);
  font-size: var(--text-sm);
  line-height: var(--leading-normal);
}
.prompt-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.prompt-tags span {
  border-radius: var(--radius-pill);
  background: var(--bg-elev-2);
  color: var(--text-dim);
  font-size: 10px;
  font-weight: 700;
  padding: 2px 8px;
  text-transform: uppercase;
}
.prompt-detail pre {
  max-height: 420px;
  margin: 0;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  padding: 12px;
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  line-height: var(--leading-normal);
}
.cue-config-layout {
  display: grid;
  gap: 12px;
}
.cue-context {
  margin: 0;
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.cue-context code {
  color: var(--text);
}
.cue-card-grid {
  display: grid;
  gap: 10px;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 320px), 1fr));
}
.cue-card-grid > * {
  min-width: 0;
}
.cue-disabled {
  border-color: var(--border-strong);
}
.template-list,
.role-list,
.run-template-list,
.run-template-group,
.run-stage-list {
  display: grid;
  gap: 8px;
}
.template-row,
.role-row,
.template-detail {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.template-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: center;
  gap: 10px;
  width: 100%;
  text-align: left;
  color: var(--text);
  padding: 10px;
}
.template-row:hover,
.template-row.selected {
  border-color: var(--accent);
}
.template-row.selected {
  background: var(--accent-soft);
}
.template-detail {
  display: grid;
  gap: 14px;
  align-content: start;
  padding: 14px;
}
.template-detail h3 {
  margin: 2px 0 4px;
  font-size: 18px;
}
.role-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px;
}
.role-row span {
  flex: 1;
}
.run-template-detail {
  gap: 12px;
}
.run-template-editor {
  display: grid;
  gap: 12px;
  margin-bottom: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 14px;
}
.run-template-editor h3 {
  margin: 2px 0 0;
  font-size: 18px;
}
.run-template-form-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(180px, 240px);
  gap: 10px;
}
.form-field {
  display: grid;
  gap: 5px;
}
.form-field span {
  color: var(--text-dim);
  font-size: var(--text-xs);
  font-weight: 700;
}
.form-field.wide {
  grid-column: 1 / -1;
}
.form-field input,
.form-field select,
.form-field textarea {
  width: 100%;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
  color: var(--text);
  padding: 8px 9px;
  font: inherit;
}
.form-field textarea {
  resize: vertical;
}
.editor-run-stage-list {
  max-height: 520px;
  overflow-y: auto;
  padding-right: 4px;
}
.run-template-config-missing {
  max-width: none;
}
.run-template-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.run-template-meta span {
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 3px 8px;
}
.run-template-meta b {
  color: var(--text);
}
.run-stage-list details {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg);
}
.run-stage-list summary {
  display: flex;
  align-items: center;
  gap: 10px;
  cursor: pointer;
  padding: 10px 12px;
  font-size: var(--text-sm);
}
.stage-number {
  color: var(--text-faint);
  font-family: var(--font-mono);
  font-weight: 700;
}
.stage-title {
  font-weight: 700;
}
.stage-badge {
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  color: var(--text-faint);
  font-size: 9px;
  font-weight: 700;
  padding: 1px 6px;
  text-transform: uppercase;
}
.stage-summary {
  margin-left: auto;
  color: var(--text-dim);
  font-family: var(--font-mono);
  font-size: 11px;
}
.run-stage-body {
  padding: 4px 12px 12px;
  border-top: 1px solid var(--border);
}
@media (max-width: 900px) {
  .template-shell,
  .team-template-layout,
  .run-template-layout,
  .prompt-library-layout {
    grid-template-columns: 1fr;
  }
  .category-sidebar {
    max-height: 260px;
    border-right: none;
    border-bottom: 1px solid var(--border);
  }
  .pane-head {
    flex-direction: column;
  }
  .run-template-form-grid {
    grid-template-columns: 1fr;
  }
}
</style>

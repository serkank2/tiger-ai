<script setup lang="ts">
import { computed, ref, watchEffect } from 'vue';
import { useDialog } from '~/composables/useDialog';
import { useT } from '~/composables/useT';
import { useTeamStore } from '~/stores/team';
import type { TeamOrchestrationMode, TeamRunStartInput, TeamTemplate } from '~/types';
import BaseButton from '../ui/BaseButton.vue';
import FolderPicker from '../FolderPicker.vue';
import TeamAgentBadge from './TeamAgentBadge.vue';
import TeamTemplateEditor from './TeamTemplateEditor.vue';

const team = useTeamStore();
const { t } = useT();

const goal = ref('');
const selectedId = ref<string | null>(null);
const workspace = ref('');
const orchestrationMode = ref<TeamOrchestrationMode | ''>('');
const showPicker = ref(false);
const editorOpen = ref(false);
const editorTemplate = ref<TeamTemplate | null>(null);

const templates = computed(() => team.templates);
const selected = computed(() => templates.value.find((t) => t.id === selectedId.value) ?? null);
// Always include the currently-selected folder so a browsed path that isn't in the
// recent list still shows as selected in the dropdown (instead of looking blank).
const projectOptions = computed(() => {
  const set = new Set<string>();
  if (workspace.value) set.add(workspace.value);
  for (const p of team.projects) set.add(p);
  return [...set];
});
const canStart = computed(
  () => goal.value.trim().length > 0 && !!selected.value && workspace.value.trim().length > 0 && !team.isBusy('start'),
);

// Default the selected template and workspace once data loads.
watchEffect(() => {
  if (!selectedId.value && templates.value.length) selectedId.value = templates.value[0]!.id ?? null;
});
watchEffect(() => {
  if (!workspace.value && team.lastWorkspace) workspace.value = team.lastWorkspace;
});

function pickProject(path: string) {
  workspace.value = path;
  showPicker.value = false;
}

async function start() {
  if (!canStart.value || !selected.value) return;
  const input: TeamRunStartInput = { goal: goal.value.trim(), templateId: selected.value.id, path: workspace.value.trim() };
  if (orchestrationMode.value) input.orchestrationMode = orchestrationMode.value;
  try {
    await team.start(input);
  } catch {
    /* store surfaces the error via notices */
  }
}

function openNew() {
  editorTemplate.value = null;
  editorOpen.value = true;
}
function openEdit(tpl: TeamTemplate) {
  editorTemplate.value = tpl;
  editorOpen.value = true;
}
async function duplicate(tpl: TeamTemplate) {
  if (!tpl.id) return;
  const created = await team.duplicateTemplate(tpl.id).catch(() => null);
  if (created?.id) selectedId.value = created.id;
}
async function remove(tpl: TeamTemplate) {
  if (!tpl.id || tpl.builtin) return;
  const ok = await useDialog().confirm({
    title: t('team.launcher.deleteTemplateTitle'),
    message: t('team.launcher.deleteTemplateMessage', { name: tpl.name }),
    confirmText: t('common.delete'),
    danger: true,
  });
  if (!ok) return;
  await team.deleteTemplate(tpl.id).catch(() => {});
  if (selectedId.value === tpl.id) selectedId.value = team.templates[0]?.id ?? null;
}
function onSaved(tpl: TeamTemplate) {
  editorOpen.value = false;
  if (tpl.id) selectedId.value = tpl.id;
}
</script>

<template>
  <section class="launcher">
    <div class="intro">
      <div class="intro-copy">
        <h1>{{ t('team.launcher.title') }}</h1>
        <p>{{ t('team.launcher.description') }}</p>
      </div>
      <div class="assembly-viz" aria-hidden="true">
        <span class="assembly-ring ring-a"></span>
        <span class="assembly-ring ring-b"></span>
        <span class="link link-lead"></span>
        <span class="link link-build"></span>
        <span class="link link-review"></span>
        <span class="link link-qa"></span>
        <span class="goal-node">
          <span class="goal-label">{{ t('team.launcher.goal') }}</span>
          <span class="goal-mark"></span>
        </span>
        <span class="agent-node lead">{{ t('team.launcher.lead') }}</span>
        <span class="agent-node build">{{ t('team.launcher.build') }}</span>
        <span class="agent-node review">{{ t('team.launcher.review') }}</span>
        <span class="agent-node qa">{{ t('team.launcher.qa') }}</span>
      </div>
    </div>

    <div class="grid">
      <div class="templates">
        <div class="col-head">
          <h3>{{ t('team.launcher.teamTemplate') }}</h3>
          <BaseButton size="sm" variant="ghost" @click="openNew">{{ t('common.new') }}</BaseButton>
        </div>
        <div
          v-for="tpl in templates"
          :key="tpl.id"
          class="tpl"
          :class="{ active: tpl.id === selectedId }"
        >
          <button
            type="button"
            class="tpl-select"
            :aria-pressed="tpl.id === selectedId"
            :aria-label="t('team.launcher.selectTemplate', { name: tpl.name })"
            @click="selectedId = tpl.id ?? null"
          >
            <div class="tpl-head">
              <span class="tpl-name">{{ tpl.name }}</span>
              <span v-if="tpl.builtin" class="tpl-tag">{{ t('team.launcher.builtIn') }}</span>
            </div>
            <p class="tpl-desc">{{ tpl.description }}</p>
            <div class="tpl-roles">
              <span v-for="r in tpl.roles" :key="r.id" class="role-pill">
                <TeamAgentBadge :tool="r.agent.tool" />
                {{ r.name }}
              </span>
            </div>
          </button>
          <div class="tpl-actions">
            <BaseButton size="sm" variant="ghost" @click="openEdit(tpl)">{{ tpl.builtin ? t('team.launcher.customize') : t('common.edit') }}</BaseButton>
            <BaseButton size="sm" variant="ghost" @click="duplicate(tpl)">{{ t('team.launcher.duplicate') }}</BaseButton>
            <BaseButton v-if="!tpl.builtin" size="sm" variant="ghost" class="danger" @click="remove(tpl)">{{ t('common.delete') }}</BaseButton>
          </div>
        </div>
        <p v-if="!templates.length" class="empty">{{ t('team.launcher.noTemplates') }}</p>
      </div>

      <div class="compose">
        <h3>{{ t('team.launcher.projectFolder') }}</h3>
        <div class="ws-row">
          <select v-model="workspace" class="ws-select" :aria-label="t('team.launcher.projectFolder')">
            <option value="" disabled>{{ t('team.launcher.selectProject') }}</option>
            <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
          </select>
          <BaseButton size="md" variant="secondary" @click="showPicker = true">{{ t('team.launcher.browse') }}</BaseButton>
        </div>
        <code v-if="workspace" class="ws-path">📁 {{ workspace }}</code>
        <code v-else class="ws-path empty-path">{{ t('team.launcher.noFolder') }}</code>

        <h3 class="mt">{{ t('team.launcher.projectGoal') }}</h3>
        <textarea
          v-model="goal"
          class="goal"
          data-testid="team-goal"
          rows="6"
          :placeholder="t('team.launcher.goalPlaceholder')"
        />

        <h3 class="mt">{{ t('team.launcher.orchestrationMode') }}</h3>
        <select v-model="orchestrationMode" class="mode-select" data-testid="team-orchestration-mode" :aria-label="t('team.launcher.orchestrationMode')">
          <option value="">{{ t('team.launcher.serverDefault') }}</option>
          <option value="legacy">{{ t('team.launcher.legacy') }}</option>
          <option value="company">{{ t('team.launcher.company') }}</option>
        </select>

        <div v-if="selected" class="selected-roles">
          <span class="label">{{ t('team.launcher.selectedRoles', { name: selected.name, n: selected.roles.length }) }}</span>
          <ul>
            <li v-for="r in selected.roles" :key="r.id">
              <TeamAgentBadge :tool="r.agent.tool" />
              <strong>{{ r.name }}</strong>
              <span class="tags">
                <span v-if="r.canWriteCode" class="tag write">{{ t('team.launcher.writesCode') }}</span>
                <span v-if="r.requiredForSignoff" class="tag sign">{{ t('team.launcher.signoff') }}</span>
              </span>
            </li>
          </ul>
        </div>
        <BaseButton
          variant="primary"
          size="lg"
          block
          data-testid="team-start"
          :loading="team.isBusy('start')"
          :disabled="!canStart"
          @click="start"
        >
          {{ t('team.launcher.startRun') }}
        </BaseButton>
      </div>
    </div>

    <FolderPicker v-if="showPicker" :initial="workspace" @select="pickProject" @close="showPicker = false" />
    <TeamTemplateEditor v-if="editorOpen" :template="editorTemplate" @saved="onSaved" @close="editorOpen = false" />
  </section>
</template>

<style scoped>
.launcher {
  position: relative;
  isolation: isolate;
  flex: 1;
  overflow-y: auto;
  padding: var(--space-6);
  max-width: 1180px;
  margin: 0 auto;
  width: 100%;
}
.launcher::before {
  content: '';
  position: fixed;
  inset: var(--bar-h) 0 0;
  z-index: -1;
  pointer-events: none;
  background:
    radial-gradient(circle at 12% 8%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 34%),
    radial-gradient(circle at 84% 4%, color-mix(in srgb, var(--blue) 7%, transparent), transparent 30%);
  opacity: 0.78;
}
.intro {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(250px, 340px);
  gap: var(--space-6);
  align-items: center;
  padding-bottom: var(--space-5);
  border-bottom: 1px solid var(--border);
}
.intro-copy {
  min-width: 0;
}
.intro h1 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-2xl);
  line-height: var(--leading-tight);
}
.intro p {
  margin: 0;
  color: var(--text-dim);
  max-width: 72ch;
  line-height: var(--leading-normal);
}
.assembly-viz {
  position: relative;
  min-height: 218px;
  overflow: hidden;
}
.assembly-viz::before {
  content: '';
  position: absolute;
  inset: 26px 28px;
  border: 1px solid color-mix(in srgb, var(--border-strong) 62%, transparent);
  border-radius: 50%;
  background:
    radial-gradient(circle, color-mix(in srgb, var(--accent) 12%, transparent), transparent 38%),
    radial-gradient(circle at 78% 24%, color-mix(in srgb, var(--blue) 12%, transparent), transparent 24%);
  opacity: 0.78;
}
.assembly-ring {
  position: absolute;
  left: 50%;
  top: 50%;
  border: 1px dashed color-mix(in srgb, var(--border-strong) 70%, transparent);
  border-radius: 50%;
  transform: translate(-50%, -50%);
  opacity: 0.72;
}
.ring-a {
  width: 182px;
  height: 128px;
}
.ring-b {
  width: 260px;
  height: 174px;
  opacity: 0.38;
}
.goal-node {
  position: absolute;
  left: 50%;
  top: 50%;
  display: grid;
  place-items: center;
  gap: 7px;
  width: 92px;
  height: 76px;
  border: 1px solid color-mix(in srgb, var(--accent) 54%, var(--border));
  border-radius: var(--radius);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--accent) 14%, transparent), transparent),
    var(--bg-elev);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 8%, transparent),
    0 14px 34px color-mix(in srgb, var(--bg) 42%, transparent);
  transform: translate(-50%, -50%);
}
.goal-label {
  color: var(--text);
  font-size: var(--text-sm);
  font-weight: 800;
  line-height: 1;
  text-transform: uppercase;
}
.goal-mark {
  width: 52px;
  height: 4px;
  border-radius: var(--radius-pill);
  background: linear-gradient(90deg, var(--accent), var(--green), var(--blue));
}
.agent-node {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 70px;
  justify-content: center;
  padding: 6px 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg-elev-2) 86%, transparent);
  color: var(--text-dim);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent),
    0 8px 22px color-mix(in srgb, var(--bg) 32%, transparent);
  font-size: var(--text-xs);
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  animation: assemble-float 5.4s var(--ease-in-out) infinite;
}
.agent-node::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--accent) 12%, transparent);
}
.agent-node.lead {
  top: 14px;
  left: calc(50% - 35px);
  color: var(--accent);
}
.agent-node.build {
  right: 8px;
  top: 94px;
  color: var(--green);
  animation-delay: -1.2s;
}
.agent-node.build::before {
  background: var(--green);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 12%, transparent);
}
.agent-node.review {
  left: 4px;
  top: 96px;
  color: var(--blue);
  animation-delay: -2.4s;
}
.agent-node.review::before {
  background: var(--blue);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--blue) 12%, transparent);
}
.agent-node.qa {
  left: calc(50% - 35px);
  bottom: 10px;
  color: var(--amber);
  animation-delay: -3.3s;
}
.agent-node.qa::before {
  background: var(--amber);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--amber) 12%, transparent);
}
.link {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 92px;
  height: 1px;
  transform-origin: left center;
  background: linear-gradient(90deg, color-mix(in srgb, var(--accent) 68%, transparent), transparent);
  opacity: 0.5;
  animation: link-breathe 3.8s var(--ease-in-out) infinite;
}
.link-lead {
  width: 74px;
  transform: rotate(-90deg);
}
.link-build {
  transform: rotate(8deg);
  background: linear-gradient(90deg, color-mix(in srgb, var(--green) 68%, transparent), transparent);
  animation-delay: -1s;
}
.link-review {
  transform: rotate(173deg);
  background: linear-gradient(90deg, color-mix(in srgb, var(--blue) 68%, transparent), transparent);
  animation-delay: -2s;
}
.link-qa {
  width: 78px;
  transform: rotate(90deg);
  background: linear-gradient(90deg, color-mix(in srgb, var(--amber) 68%, transparent), transparent);
  animation-delay: -3s;
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-5);
  margin-top: var(--space-5);
  align-items: start;
}
h3 {
  margin: 0 0 var(--space-3);
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
h3.mt {
  margin-top: var(--space-4);
}
.col-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: var(--space-2);
}
.col-head h3 {
  margin: 0;
}
.templates {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.tpl {
  position: relative;
  overflow: hidden;
  text-align: left;
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 5%, transparent), transparent 46%),
    var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent);
  transition:
    border-color var(--dur-base) var(--ease-standard),
    background-color var(--dur-base) var(--ease-standard);
}
.tpl::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent);
  opacity: 0;
  transition: opacity var(--dur-base) var(--ease-standard);
}
.tpl:hover {
  border-color: var(--border-strong);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 6%, transparent),
    0 8px 20px color-mix(in srgb, var(--bg) 28%, transparent);
}
.tpl.active {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.tpl.active::before {
  opacity: 1;
}
.tpl-select {
  display: block;
  width: 100%;
  padding: 0;
  border: 0;
  border-radius: var(--radius-sm);
  color: inherit;
  text-align: left;
}
.tpl-select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 3px;
}
.tpl-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  justify-content: space-between;
}
.tpl-name {
  font-weight: 700;
  color: var(--text);
}
.tpl-tag {
  font-size: var(--text-xs);
  color: var(--text-faint);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  padding: 1px 7px;
}
.tpl-desc {
  margin: var(--space-2) 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
  line-height: var(--leading-snug);
}
.tpl-roles {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1);
}
.role-pill {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-dim);
  background: var(--bg-elev-2);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 2px 8px;
}
.tpl-actions {
  display: flex;
  gap: var(--space-2);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}
.tpl-actions .danger:hover {
  color: var(--red);
}
.compose {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding-left: var(--space-4);
  border-left: 1px solid var(--border);
}
.ws-row {
  display: flex;
  gap: var(--space-2);
}
.ws-select {
  flex: 1;
  min-width: 0;
}
.ws-select,
.mode-select,
.goal {
  box-shadow: inset 0 1px 0 color-mix(in srgb, var(--text) 4%, transparent);
  transition:
    border-color var(--dur-fast) var(--ease-standard),
    background-color var(--dur-fast) var(--ease-standard);
}
.ws-select:focus,
.mode-select:focus,
.goal:focus {
  border-color: var(--accent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 5%, transparent),
    0 0 0 3px var(--accent-soft);
}
.ws-path {
  display: block;
  margin-top: var(--space-2);
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--accent);
  word-break: break-all;
}
.ws-path.empty-path {
  color: var(--text-faint);
}
.goal {
  width: 100%;
  resize: vertical;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  line-height: var(--leading-normal);
}
.goal::placeholder {
  color: var(--text-faint);
}
.mode-select {
  width: 100%;
}
.selected-roles {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
  margin: var(--space-3) 0;
}
.selected-roles .label {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-faint);
}
.selected-roles ul {
  list-style: none;
  margin: var(--space-2) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}
.selected-roles li {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.tags {
  display: inline-flex;
  gap: 4px;
  margin-left: auto;
}
.tag {
  font-size: var(--text-xs);
  border-radius: var(--radius-pill);
  padding: 1px 7px;
  border: 1px solid var(--border-strong);
}
.tag.write { color: var(--accent); border-color: var(--accent); }
.tag.sign { color: var(--green); border-color: var(--green); }
.empty {
  color: var(--text-faint);
  font-size: var(--text-sm);
}
@keyframes assemble-float {
  0%,
  100% {
    opacity: 0.86;
    transform: translate3d(0, 0, 0);
  }
  50% {
    opacity: 1;
    transform: translate3d(0, -5px, 0);
  }
}
@keyframes link-breathe {
  0%,
  100% {
    opacity: 0.32;
  }
  50% {
    opacity: 0.76;
  }
}
@media (prefers-reduced-motion: reduce) {
  .agent-node,
  .link {
    animation: none;
  }
}
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
  .compose {
    padding-left: 0;
    border-left: 0;
  }
}
@media (max-width: 760px) {
  .launcher {
    padding: var(--space-4);
  }
  .intro {
    grid-template-columns: 1fr;
    gap: var(--space-3);
  }
  .assembly-viz {
    min-height: 124px;
    max-width: 390px;
    width: 100%;
    justify-self: center;
  }
  .assembly-viz::before {
    inset: 14px 26px;
  }
  .ring-a {
    width: 134px;
    height: 94px;
  }
  .ring-b {
    width: 196px;
    height: 126px;
  }
  .goal-node {
    width: 74px;
    height: 52px;
    gap: 5px;
  }
  .goal-mark {
    width: 42px;
  }
  .agent-node.build {
    right: 24px;
    top: 50px;
  }
  .agent-node.review {
    left: 24px;
    top: 52px;
  }
  .agent-node.lead {
    top: 4px;
  }
  .agent-node.qa {
    bottom: 2px;
  }
  .link {
    width: 58px;
  }
  .link-lead {
    width: 48px;
  }
  .link-qa {
    width: 48px;
  }
}
@media (max-width: 520px) {
  .ws-row {
    flex-direction: column;
  }
  .assembly-viz {
    min-height: 92px;
  }
  .assembly-viz::before {
    inset: 10px 46px;
  }
  .ring-a {
    width: 104px;
    height: 70px;
  }
  .ring-b {
    width: 154px;
    height: 92px;
  }
  .goal-node {
    width: 62px;
    height: 42px;
  }
  .goal-label {
    font-size: var(--text-xs);
  }
  .goal-mark {
    width: 34px;
  }
  .agent-node {
    min-width: 54px;
    padding: 4px 6px;
    font-size: var(--text-xs);
  }
  .agent-node::before {
    width: 6px;
    height: 6px;
    box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent);
  }
  .agent-node.lead {
    top: 2px;
    left: calc(50% - 27px);
  }
  .agent-node.build {
    right: 28px;
    top: 36px;
  }
  .agent-node.review {
    left: 28px;
    top: 36px;
  }
  .agent-node.qa {
    left: calc(50% - 27px);
    bottom: 0;
  }
  .link {
    width: 44px;
  }
  .link-lead,
  .link-qa {
    width: 36px;
  }
}
</style>

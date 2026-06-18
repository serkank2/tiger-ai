<script setup lang="ts">
import { computed, ref } from 'vue';
import { useTeamStore } from '~/stores/team';
import type { TeamTemplate } from '~/types';
import BaseButton from '../ui/BaseButton.vue';
import FolderPicker from '../FolderPicker.vue';
import TeamAgentBadge from './TeamAgentBadge.vue';
import TeamTemplateEditor from './TeamTemplateEditor.vue';

const team = useTeamStore();

const goal = ref('');
const selectedId = ref<string | null>(null);
const workspace = ref('');
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
  try {
    await team.start({ goal: goal.value.trim(), templateId: selected.value.id, path: workspace.value.trim() });
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
  // eslint-disable-next-line no-alert
  if (!confirm(`Delete team template "${tpl.name}"? This cannot be undone.`)) return;
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
      <h1>Assemble an AI Team</h1>
      <p>
        Pick the project folder, choose a team template, describe the goal, and the role agents will
        plan, build, review, and only stop once every required role signs off. Steer them anytime.
      </p>
    </div>

    <div class="grid">
      <div class="templates">
        <div class="col-head">
          <h3>Team template</h3>
          <BaseButton size="sm" variant="ghost" @click="openNew">+ New</BaseButton>
        </div>
        <div
          v-for="tpl in templates"
          :key="tpl.id"
          class="tpl"
          :class="{ active: tpl.id === selectedId }"
          role="button"
          tabindex="0"
          @click="selectedId = tpl.id ?? null"
          @keydown.enter="selectedId = tpl.id ?? null"
        >
          <div class="tpl-head">
            <span class="tpl-name">{{ tpl.name }}</span>
            <span v-if="tpl.builtin" class="tpl-tag">built-in</span>
          </div>
          <p class="tpl-desc">{{ tpl.description }}</p>
          <div class="tpl-roles">
            <span v-for="r in tpl.roles" :key="r.id" class="role-pill">
              <TeamAgentBadge :tool="r.agent.tool" />
              {{ r.name }}
            </span>
          </div>
          <div class="tpl-actions" @click.stop>
            <button type="button" @click="openEdit(tpl)">{{ tpl.builtin ? 'Customize' : 'Edit' }}</button>
            <button type="button" @click="duplicate(tpl)">Duplicate</button>
            <button v-if="!tpl.builtin" type="button" class="danger" @click="remove(tpl)">Delete</button>
          </div>
        </div>
        <p v-if="!templates.length" class="empty">No team templates available.</p>
      </div>

      <div class="compose">
        <h3>Project folder</h3>
        <div class="ws-row">
          <select v-model="workspace" class="ws-select" aria-label="Project folder">
            <option value="" disabled>Select or browse a project folder…</option>
            <option v-for="p in projectOptions" :key="p" :value="p">{{ p }}</option>
          </select>
          <BaseButton size="md" variant="secondary" @click="showPicker = true">Browse…</BaseButton>
        </div>
        <code v-if="workspace" class="ws-path">📁 {{ workspace }}</code>
        <code v-else class="ws-path empty-path">No folder selected</code>

        <h3 class="mt">Project goal</h3>
        <textarea
          v-model="goal"
          class="goal"
          rows="6"
          placeholder="Describe what the team should accomplish. Be specific about the outcome and any constraints…"
        />

        <div v-if="selected" class="selected-roles">
          <span class="label">{{ selected.name }} · {{ selected.roles.length }} roles</span>
          <ul>
            <li v-for="r in selected.roles" :key="r.id">
              <TeamAgentBadge :tool="r.agent.tool" />
              <strong>{{ r.name }}</strong>
              <span class="tags">
                <span v-if="r.canWriteCode" class="tag write">writes code</span>
                <span v-if="r.requiredForSignoff" class="tag sign">sign-off</span>
              </span>
            </li>
          </ul>
        </div>
        <BaseButton variant="primary" size="lg" block :loading="team.isBusy('start')" :disabled="!canStart" @click="start">
          Start team run
        </BaseButton>
      </div>
    </div>

    <FolderPicker v-if="showPicker" :initial="workspace" @select="pickProject" @close="showPicker = false" />
    <TeamTemplateEditor v-if="editorOpen" :template="editorTemplate" @saved="onSaved" @close="editorOpen = false" />
  </section>
</template>

<style scoped>
.launcher {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-6);
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}
.intro h1 {
  margin: 0 0 var(--space-2);
  font-size: var(--text-2xl);
}
.intro p {
  margin: 0;
  color: var(--text-dim);
  max-width: 72ch;
  line-height: var(--leading-normal);
}
.grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-5);
  margin-top: var(--space-5);
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
  text-align: left;
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
  cursor: pointer;
  transition: border-color var(--dur-base) var(--ease-standard), background var(--dur-base) var(--ease-standard);
}
.tpl:hover {
  border-color: var(--border-strong);
}
.tpl.active {
  border-color: var(--accent);
  background: var(--accent-soft);
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
  gap: var(--space-3);
  margin-top: var(--space-2);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border);
}
.tpl-actions button {
  font-size: var(--text-xs);
  color: var(--text-dim);
  background: transparent;
  border: none;
  padding: 0;
}
.tpl-actions button:hover {
  color: var(--accent);
}
.tpl-actions button.danger:hover {
  color: var(--red);
}
.compose {
  display: flex;
  flex-direction: column;
}
.ws-row {
  display: flex;
  gap: var(--space-2);
}
.ws-select {
  flex: 1;
  min-width: 0;
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
@media (max-width: 900px) {
  .grid {
    grid-template-columns: 1fr;
  }
}
</style>

<script setup lang="ts">
import type { TigerStageId, TigerStageRunConfig } from '~/types';
import { TIGER_STAGES } from '~/lib/tigerStages';
import FolderPicker from '~/components/FolderPicker.vue';
import StageStepper from '~/components/tiger/StageStepper.vue';
import StageConfigPanel from '~/components/tiger/StageConfigPanel.vue';
import AgentTile from '~/components/tiger/AgentTile.vue';
import TaskBoard from '~/components/tiger/TaskBoard.vue';
import RunLogView from '~/components/tiger/RunLogView.vue';
import ProjectLauncher from '~/components/tiger/ProjectLauncher.vue';
import RunAllModal from '~/components/tiger/RunAllModal.vue';

const emit = defineEmits<{ back: [] }>();
const tiger = useTigerStore();
const conn = useConnectionStore();

// --- setup (uninitialized) ---
const showPicker = ref(false);
const showRunAll = ref(false);
const workspacePath = ref('');
const projectPrompt = ref('');
const initializing = ref(false);

async function initialize() {
  if (!workspacePath.value || !projectPrompt.value.trim()) return;
  initializing.value = true;
  try {
    await tiger.initWorkspace(workspacePath.value, projectPrompt.value);
  } catch {
    /* notice already shown */
  } finally {
    initializing.value = false;
  }
}

// --- launcher / setup / workflow mode (when no project is open) ---
const mode = ref<'launcher' | 'setup'>('launcher');
function startNew() {
  workspacePath.value = '';
  projectPrompt.value = '';
  mode.value = 'setup';
}
async function backToProjects() {
  await tiger.closeProject();
  mode.value = 'launcher';
}

// --- selected stage + run config ---
const selectedStage = ref<TigerStageId>('brainstorming');

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
const runCfg = reactive<TigerStageRunConfig>(freshCfg());
function reseed() {
  Object.assign(runCfg, freshCfg());
}
// Reseed defaults when config arrives or the selected stage changes.
watch([() => tiger.config, selectedStage], reseed);

// When a project opens (workspace changes), jump to its current / first-incomplete stage.
watch(
  () => tiger.state?.workspace,
  (ws) => {
    if (ws) selectedStage.value = tiger.state?.currentStage ?? firstIncompleteStage() ?? 'brainstorming';
  },
  { immediate: true },
);

// While auto-advancing, follow the stage the orchestrator is currently processing so the live
// tiles/config track the active stage without the user having to click each tab.
watch(
  () => tiger.state?.currentStage,
  (cur) => {
    if (cur && tiger.state?.autoAdvance) selectedStage.value = cur;
  },
);

function firstIncompleteStage(): TigerStageId | null {
  const stages = tiger.state?.stages;
  if (!stages) return null;
  for (const s of TIGER_STAGES) if (stages[s.id]?.status !== 'completed') return s.id;
  return null;
}

const stageMeta = computed(() => TIGER_STAGES.find((s) => s.id === selectedStage.value)!);
const stageState = computed(() => tiger.state?.stages?.[selectedStage.value] ?? null);
const runs = computed(() => stageState.value?.runs ?? []);
const hasFailed = computed(() => runs.value.some((r) => r.state === 'failed' || r.state === 'stopped'));

// Once a stage has run (e.g. during a Run All), show the exact config it used (read-only);
// otherwise show the editable local config for a manual single-stage run.
const ranWithConfig = computed(
  () => !!stageState.value?.config && stageState.value?.status !== 'not_started',
);
const shownCfg = computed(() => (ranWithConfig.value ? stageState.value!.config! : runCfg));
const cfgDisabled = computed(() => tiger.busy || ranWithConfig.value);

const atCycleLimit = computed(
  () => (tiger.state?.correctionCycles ?? 0) >= (tiger.state?.maxCorrectionCycles ?? 0),
);

const prevIncomplete = computed(() => {
  const idx = TIGER_STAGES.findIndex((s) => s.id === selectedStage.value);
  const stages = tiger.state?.stages;
  if (idx <= 0 || !stages) return null;
  for (let i = 0; i < idx; i++) {
    const s = TIGER_STAGES[i]!;
    if (stages[s.id]?.status !== 'completed') return s.title;
  }
  return null;
});

async function runStage(auto = false) {
  if (tiger.busy) return;
  if (prevIncomplete.value) {
    const ok = window.confirm(
      `Stage "${prevIncomplete.value}" is not completed yet. Run "${stageMeta.value.title}" anyway?`,
    );
    if (!ok) return;
  }
  await tiger.runStage(selectedStage.value, { ...runCfg }, auto);
}

onMounted(() => {
  void tiger.load();
});
</script>

<template>
  <div class="tiger">
    <header class="thead">
      <div class="brand">
        <span class="logo">🐅</span>
        <b>Tiger</b>
        <span class="sub">AI Software Team Orchestrator</span>
        <span class="conn" :class="conn.status" :title="`backend ${conn.status}`" />
      </div>
      <span class="spacer" />
      <code v-if="tiger.workspace" class="ws" :title="tiger.state?.tigerRoot ?? ''">{{ tiger.state?.tigerRoot }}</code>
      <button v-if="tiger.initialized" class="back" @click="backToProjects">← Projects</button>
      <button class="back" @click="emit('back')">← Terminals</button>
    </header>

    <!-- Launcher: pick an existing project or start a new one -->
    <ProjectLauncher v-if="!tiger.initialized && mode === 'launcher'" @new="startNew" />

    <!-- New-project setup -->
    <section v-else-if="!tiger.initialized" class="setup">
      <div class="setup-head">
        <button class="back" @click="mode = 'launcher'">← Projects</button>
        <h2>New project</h2>
      </div>
      <p class="lead">
        Pick a workspace folder and provide your project prompt. Tiger creates a <code>.tiger/</code> workspace
        there (system prompts, config, logs) and drives Claude &amp; Codex CLI agents through the full workflow.
      </p>
      <div class="field">
        <span>Workspace folder</span>
        <div class="wsrow">
          <input v-model="workspacePath" placeholder="Choose or type an absolute folder path…" spellcheck="false" />
          <button class="ghost" @click="showPicker = true">Browse…</button>
        </div>
        <small>A <code>.tiger/</code> directory will be created inside this folder.</small>
      </div>
      <div class="field">
        <span>Project prompt</span>
        <textarea v-model="projectPrompt" rows="10" placeholder="Describe the project you want the AI team to build…" />
        <small>Stored verbatim in <code>.tiger/project-prompt.md</code> and used as context in every stage.</small>
      </div>
      <button class="primary" :disabled="!workspacePath || !projectPrompt.trim() || initializing" @click="initialize">
        {{ initializing ? 'Creating…' : 'Create project' }}
      </button>
    </section>

    <!-- Workflow -->
    <section v-else class="work">
      <StageStepper v-model="selectedStage" :stages="tiger.state?.stages ?? null" />

      <div class="stage-card">
        <div class="stage-head">
          <span class="stage-num">{{ stageMeta.number }}</span>
          <h3>{{ stageMeta.title }}</h3>
          <span class="status" :class="`st-${stageState?.status ?? 'not_started'}`">
            {{ (stageState?.status ?? 'not_started').replace('_', ' ') }}
          </span>
          <span v-if="stageState?.continued" class="continued-badge">continued ✓</span>
          <span v-if="tiger.state?.autoAdvance" class="auto-badge">auto-advancing ▸</span>
          <span class="spacer" />
          <button v-if="tiger.busy" class="stop" @click="tiger.stop()">■ Stop</button>
          <button v-if="hasFailed && !tiger.busy" class="retry" @click="tiger.retryStage(selectedStage)">⟳ Retry failed</button>
          <button
            v-if="stageState?.status === 'failed' && !stageState?.continued && !tiger.busy"
            class="continue"
            @click="tiger.continueStage(selectedStage)"
          >
            → Continue despite failures
          </button>
          <button class="run" :disabled="tiger.busy" @click="runStage(false)">▶ Run stage</button>
          <button
            class="run-all"
            :disabled="tiger.busy"
            title="Configure every stage, then run them all automatically"
            @click="showRunAll = true"
          >
            ▶▶ Run all…
          </button>
        </div>

        <p v-if="stageMeta.optional" class="opt-note">
          ℹ Optional stage — for a clear prompt you can skip it and start from Writing Plan (or set 0 agents).
        </p>
        <p v-if="prevIncomplete" class="warn">⚠ Earlier stage “{{ prevIncomplete }}” is not completed yet.</p>
        <p v-if="stageState?.message" class="msg">{{ stageState.message }}</p>
        <p v-if="selectedStage === 'task-review' && tiger.state?.findings" class="findings-line">
          Findings: {{ tiger.state.findings.fixed }} fixed · {{ tiger.state.findings.wontfix }} won't fix ·
          {{ tiger.state.findings.open + tiger.state.findings.fixing }} open · {{ tiger.state.findings.total }} total
        </p>
        <p
          v-else-if="selectedStage === 'task-review' && stageState?.status === 'completed'"
          class="findings-line ok"
        >
          ✓ Review found no problems — reviewed tasks approved.
        </p>

        <p v-if="ranWithConfig" class="cfg-note">Showing the configuration this stage ran with.</p>
        <StageConfigPanel
          v-if="tiger.config"
          :config="tiger.config"
          :stage="selectedStage"
          :cfg="shownCfg"
          :disabled="cfgDisabled"
        />

        <div v-if="selectedStage === 'requesting-code-review'" class="route">
          <span class="rl">Correction routing</span>
          <span class="cycles">cycles {{ tiger.state?.correctionCycles ?? 0 }}/{{ tiger.state?.maxCorrectionCycles ?? 0 }}</span>
          <span class="spacer" />
          <button :disabled="tiger.busy || atCycleLimit" @click="tiger.routeCorrection('executing-plan')">↩ Back to Execution</button>
          <button :disabled="tiger.busy || atCycleLimit" @click="tiger.routeCorrection('task-review')">↩ Back to Task Review</button>
        </div>
      </div>

      <div v-if="runs.length" class="tiles">
        <AgentTile v-for="r in runs" :key="r.id" :run="r" />
      </div>
      <p v-else class="hint">
        Configure the agents above and press “Run stage” to start. On the first run in a new workspace, an
        agent tile may show a one-time “trust this folder” prompt — click into that tile and approve it once
        (or pick a Full-access permission mode); afterwards runs are fully autonomous.
      </p>

      <details v-if="selectedStage === 'executing-plan' || selectedStage === 'task-review' || (tiger.state?.tasks?.total ?? 0) > 0" class="panel" open>
        <summary>Tasks</summary>
        <TaskBoard :tasks="tiger.state?.tasks ?? null" />
      </details>

      <details class="panel">
        <summary>Run log</summary>
        <RunLogView />
      </details>
    </section>

    <FolderPicker
      v-if="showPicker"
      :initial="workspacePath || undefined"
      @select="(p) => { workspacePath = p; showPicker = false; }"
      @close="showPicker = false"
    />
    <RunAllModal v-if="showRunAll" @close="showRunAll = false" />
  </div>
</template>

<style scoped>
.tiger {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.thead {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.logo {
  font-size: 18px;
}
.sub {
  color: var(--text-dim);
  font-size: 12px;
}
.conn {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
  margin-left: 4px;
}
.conn.connected {
  background: var(--green);
  box-shadow: 0 0 8px var(--green);
}
.conn.connecting {
  background: var(--amber);
}
.conn.disconnected {
  background: var(--red);
}
.spacer {
  flex: 1;
}
.ws {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  max-width: 46ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.back {
  border: 1px solid var(--border-strong);
  padding: 7px 12px;
  color: var(--text-dim);
}
.back:hover {
  border-color: var(--accent);
  color: var(--accent);
}

.setup {
  max-width: 760px;
  margin: 0 auto;
  padding: 32px 24px;
  overflow-y: auto;
}
.setup h2 {
  margin: 0;
}
.setup-head {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 8px;
}
.lead {
  color: var(--text-dim);
  margin: 0 0 20px;
  line-height: 1.5;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-bottom: 18px;
}
.field > span {
  font-weight: 600;
  font-size: 13px;
}
.field small {
  color: var(--text-faint);
  font-size: 11px;
}
.wsrow {
  display: flex;
  gap: 8px;
}
.wsrow input {
  flex: 1;
  font-family: var(--font-mono);
}
textarea {
  font-family: var(--font-mono);
  font-size: 13px;
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 10px;
  resize: vertical;
  line-height: 1.5;
}
code {
  font-family: var(--font-mono);
  color: var(--accent);
}
.ghost {
  border: 1px solid var(--border-strong);
  padding: 8px 14px;
  color: var(--text-dim);
}
.ghost:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.primary {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 10px 20px;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.work {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.stage-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 14px 16px;
}
.stage-head {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
}
.stage-num {
  font-family: var(--font-mono);
  font-weight: 700;
  color: var(--text-faint);
}
.stage-head h3 {
  margin: 0;
  font-size: 16px;
}
.status {
  font-size: 11px;
  padding: 2px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.status.st-running {
  color: var(--accent);
  border-color: var(--accent);
}
.status.st-completed {
  color: var(--green);
  border-color: var(--green);
}
.status.st-failed {
  color: var(--red);
  border-color: var(--red);
}
.run {
  border: 1px solid var(--accent);
  background: var(--accent);
  color: #1b1206;
  font-weight: 700;
  padding: 8px 16px;
}
.run:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.run-all {
  border: 1px solid var(--accent);
  color: var(--accent);
  font-weight: 700;
  padding: 8px 14px;
}
.run-all:hover:not(:disabled) {
  background: var(--accent-soft);
}
.run-all:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.auto-badge {
  font-size: 11px;
  color: var(--accent);
  border: 1px solid var(--accent);
  border-radius: 999px;
  padding: 1px 8px;
}
.stop {
  border: 1px solid var(--red);
  color: var(--red);
  padding: 8px 14px;
  font-weight: 600;
}
.retry {
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  padding: 8px 14px;
}
.retry:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.continue {
  border: 1px solid var(--amber);
  color: var(--amber);
  padding: 8px 14px;
  font-weight: 600;
}
.continue:hover {
  background: rgba(224, 176, 58, 0.12);
}
.continued-badge {
  font-size: 11px;
  color: var(--green);
  border: 1px solid var(--green);
  border-radius: 999px;
  padding: 1px 8px;
}
.route {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 12px;
  padding-top: 12px;
  border-top: 1px solid var(--border);
}
.rl {
  font-size: 12px;
  font-weight: 700;
  color: var(--text-dim);
}
.cycles {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
}
.route button {
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  padding: 6px 12px;
  font-size: 12px;
}
.route button:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
}
.route button:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.warn {
  margin: 0 0 10px;
  color: var(--amber);
  font-size: 12px;
}
.opt-note {
  margin: 0 0 10px;
  color: var(--text-dim);
  font-size: 12px;
}
.cfg-note {
  margin: 0 0 8px;
  color: var(--text-faint);
  font-size: 11px;
}
.findings-line {
  margin: 0 0 10px;
  font-size: 12px;
  color: var(--text-dim);
  font-family: var(--font-mono);
}
.findings-line.ok {
  color: var(--green);
  font-family: inherit;
}
.msg {
  margin: 0 0 10px;
  color: var(--text-dim);
  font-size: 13px;
}
.tiles {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(380px, 1fr));
  gap: 12px;
}
.hint {
  color: var(--text-faint);
  font-size: 13px;
  margin: 0;
}
.panel {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
  padding: 6px 12px 12px;
}
.panel > summary {
  cursor: pointer;
  font-weight: 700;
  font-size: 13px;
  padding: 6px 0;
  color: var(--text);
}
</style>

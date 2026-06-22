<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useDialog } from '~/composables/useDialog';
import { useT } from '~/composables/useT';
import { displayRoleName } from '~/lib/teamRoles';
import { useTeamStore } from '~/stores/team';
import { useConnectionStore } from '~/stores/connection';
import BaseButton from '../ui/BaseButton.vue';
import Spinner from '../ui/Spinner.vue';
import TeamLauncher from './TeamLauncher.vue';
import TeamRoleTile from './TeamRoleTile.vue';
import TeamChatPanel from './TeamChatPanel.vue';
import TeamDoneGate from './TeamDoneGate.vue';
import TeamSteerBar from './TeamSteerBar.vue';
import TeamTerminalPane from './TeamTerminalPane.vue';
import TeamChangesPanel from './TeamChangesPanel.vue';
import TeamMetricsPanel from './TeamMetricsPanel.vue';
import TeamAttemptsPanel from './TeamAttemptsPanel.vue';
import TeamRunHistory from './TeamRunHistory.vue';
import TeamRoleControls from './TeamRoleControls.vue';
import TeamVerifications from './TeamVerifications.vue';
import TeamCoordinationPanel from './TeamCoordinationPanel.vue';

const emit = defineEmits<{ back: [] }>();

const team = useTeamStore();
const connection = useConnectionStore();
const { t } = useT();

let unbind: (() => void) | null = null;

onMounted(() => {
  unbind = team.bindSocket();
  void team.hydrate({ quiet: true }).catch(() => {});
});
onBeforeUnmount(() => {
  unbind?.();
  unbind = null;
});

const state = computed(() => team.state);
const status = computed(() => state.value?.status ?? null);

// Total role turns the Lead has sequenced so far. Surfaced as forward Lead-managed
// progress, not as a round/round-robin counter — the Lead decides the order, so the
// user sees how much work has run, not which "round" the team is on.
const roleTurns = computed(() => state.value?.turnCount ?? null);
const turnsLabel = computed(() => {
  const n = roleTurns.value ?? 0;
  return t(n === 1 ? 'team.run.turnSingular' : 'team.run.turnPlural', { n });
});

// The role whose live terminal is open. Tracked by id so the pane follows the role's
// latest turn terminal as new turns start.
const selectedRoleId = ref<string | null>(null);
const showChanges = ref(false);
const showHistory = ref(false);
const showRoleControls = ref(false);
const readOnly = computed(() => team.readOnly);
const terminalRole = computed(
  () => state.value?.roles.find((r) => r.id === selectedRoleId.value && r.terminalId) ?? null,
);
const isActive = computed(() => status.value === 'running' || status.value === 'paused' || status.value === 'blocked');

function roleDisplayName(index: number): string {
  const roles = state.value?.roles ?? [];
  const role = roles[index];
  return role ? displayRoleName(roles, role, index) : '';
}
const terminalRoleTitle = computed(() => {
  const roles = state.value?.roles ?? [];
  const index = roles.findIndex((role) => role.id === terminalRole.value?.id);
  return index >= 0 ? roleDisplayName(index) : terminalRole.value?.name ?? '';
});

const dialog = useDialog();
async function closeRun(id: string) {
  const ok = await dialog.confirm({
    title: t('team.run.closeConfirmTitle'),
    message: t('team.run.closeConfirmMessage'),
    confirmText: t('team.run.closeConfirmText'),
    danger: true,
  });
  if (ok) void team.close(id);
}
const connected = computed(() => connection.status === 'connected');

// A Closed run had its persistent CLI sessions killed: it can neither Resume (no context to
// re-enter) nor be Closed again. `closed` overrides the status-based guesses below — a closed
// run keeps status 'stopped', which would otherwise still offer both.
const closed = computed(() => state.value?.closed === true);
// A read-only history view must offer no live controls — only "Back to live" and export.
const canPause = computed(() => !readOnly.value && status.value === 'running');
// Stop is a resumable halt (role sessions stay alive), so a stopped run can Resume into the
// same context; Close (hasLiveSessions) remains available to end those retained sessions.
const canResume = computed(
  () =>
    !readOnly.value &&
    !closed.value &&
    (status.value === 'paused' ||
      status.value === 'blocked' ||
      status.value === 'interrupted' ||
      status.value === 'stopped'),
);
const canStop = computed(() => !readOnly.value && (isActive.value || status.value === 'interrupted'));
// Persistent CLI terminals stay alive until the run completes/fails or is Closed, so a
// Close (kill terminals) is offered for any non-terminal-and-done run that isn't already closed.
const hasLiveSessions = computed(
  () =>
    !readOnly.value &&
    !closed.value &&
    status.value != null &&
    status.value !== 'completed' &&
    status.value !== 'failed',
);

async function returnToLive() {
  showRoleControls.value = false;
  await team.returnToLive().catch(() => {});
}

const STATUS_KEY: Record<string, string> = {
  running: 'team.status.running',
  paused: 'team.status.paused',
  blocked: 'team.status.blocked',
  completed: 'team.status.completed',
  failed: 'team.status.failed',
  stopped: 'team.status.stopped',
  interrupted: 'team.status.interrupted',
};

function statusLabel(s: string | null): string {
  return s ? t(STATUS_KEY[s] ?? s) : t('team.status.noRun');
}

async function reset() {
  // Returning to the launcher is a UI-only action; the run stays persisted and can be
  // re-opened by reloading state. We simply drop the active run from the view.
  team.viewingRunId = null;
  team.state = null;
}
</script>

<template>
  <div class="team" :class="status ? `run-${status}` : 'run-empty'">
    <header class="team-header">
      <div class="title-group">
        <BaseButton variant="ghost" size="sm" :aria-label="t('team.run.backToTerminals')" icon-only @click="emit('back')">‹</BaseButton>
        <span class="brand">?? {{ t('team.run.brand') }}</span>
        <span class="conn" :class="{ ok: connected }" :title="connected ? t('common.status.live') : t('common.status.disconnected')" />
      </div>

      <div v-if="state" class="run-meta">
        <span class="run-name" :title="state.goal">{{ state.name }}</span>
        <span class="status-chip" :class="`st-${status}`">
          <span class="chip-dot" aria-hidden="true" />
          {{ statusLabel(status) }}
        </span>
        <span
          v-if="roleTurns != null"
          class="progress-meter"
          :title="t('team.run.leadManagedTitle', { turns: turnsLabel })"
        >
          ? {{ t('team.run.leadManaged') }} ? {{ turnsLabel }}
        </span>
      </div>

      <div v-if="state" class="controls">
        <template v-if="readOnly">
          <span class="ro-tag" :title="t('team.run.readOnlyTitle')">{{ t('team.run.readOnly') }}</span>
          <BaseButton size="sm" variant="primary" @click="returnToLive">{{ t('team.run.backToLive') }}</BaseButton>
        </template>
        <BaseButton
          v-if="canPause"
          size="sm"
          :loading="team.isBusy(`pause:${state.id}`)"
          @click="team.pause(state.id)"
        >{{ t('team.controls.pause') }}</BaseButton>
        <BaseButton
          v-if="canResume"
          size="sm"
          variant="primary"
          :loading="team.isBusy(`resume:${state.id}`)"
          @click="team.resume(state.id)"
        >{{ t('team.controls.resume') }}</BaseButton>
        <BaseButton
          v-if="canStop"
          size="sm"
          variant="secondary"
          :loading="team.isBusy(`stop:${state.id}`)"
          :title="t('team.controls.haltTitle')"
          @click="team.stop(state.id)"
        >{{ t('team.controls.stop') }}</BaseButton>
        <BaseButton
          v-if="hasLiveSessions"
          size="sm"
          variant="danger"
          :loading="team.isBusy(`close:${state.id}`)"
          :title="t('team.controls.closeTitle')"
          @click="closeRun(state.id)"
        >{{ t('team.controls.close') }}</BaseButton>
        <BaseButton
          size="sm"
          variant="ghost"
          :title="t('team.controls.changesTitle')"
          @click="showChanges = true"
        >? {{ t('team.controls.changes') }}</BaseButton>
        <BaseButton
          size="sm"
          variant="ghost"
          :title="t('team.controls.historyTitle')"
          @click="showHistory = true"
        >? {{ t('team.controls.history') }}</BaseButton>
        <BaseButton size="sm" variant="ghost" :title="t('team.export.jsonTooltip')" @click="team.exportRun('json')">⇩ JSON</BaseButton>
        <BaseButton size="sm" variant="ghost" :title="t('team.export.markdownTooltip')" @click="team.exportRun('markdown')">⇩ MD</BaseButton>
        <BaseButton v-if="!isActive && !readOnly" size="sm" variant="ghost" @click="reset">{{ t('team.run.newRun') }}</BaseButton>
      </div>
    </header>

    <section v-if="!state && team.loading" class="placeholder">
      <Spinner :size="22" />
      <p>{{ t('team.run.loading') }}</p>
    </section>

    <TeamLauncher v-else-if="!state" />

    <section v-else class="workspace">
      <aside class="rail">
        <TeamDoneGate :gate="state.doneGate" :status="status" :message="team.actionError" />
        <div class="rail-head">
          <h3>{{ t('team.run.roles') }}</h3>
          <span class="count">{{ state.roles.length }}</span>
          <BaseButton
            v-if="isActive && !readOnly"
            size="sm"
            variant="ghost"
            class="manage-toggle"
            :title="showRoleControls ? t('team.controls.hideRoleControls') : t('team.controls.manageRoleControls')"
            @click="showRoleControls = !showRoleControls"
          >{{ showRoleControls ? t('team.controls.done') : t('team.controls.manage') }}</BaseButton>
        </div>
        <div v-if="showRoleControls" class="roles">
          <TeamRoleControls
            v-for="(role, i) in state.roles"
            :key="role.id"
            :role="role"
            :roles="state.roles"
            :display-name="roleDisplayName(i)"
          />
        </div>
        <TransitionGroup v-else name="tile" tag="div" class="roles">
          <TeamRoleTile
            v-for="(role, i) in state.roles"
            :key="role.id"
            :role="role"
            :display-name="roleDisplayName(i)"
            @select="selectedRoleId = role.id"
          />
        </TransitionGroup>

        <TeamMetricsPanel :metrics="team.metrics" />
        <TeamAttemptsPanel @view-diff="showChanges = true" />
        <TeamCoordinationPanel />
        <TeamVerifications :verifications="team.verifications" :sign-offs="team.signOffs" />

        <details v-if="team.artifacts.length" class="artifacts">
          <summary>{{ t('team.run.artifacts') }} ? {{ team.artifacts.length }}</summary>
          <ul>
            <li v-for="a in team.artifacts" :key="a.id" :title="a.path">{{ a.name }}</li>
          </ul>
        </details>
      </aside>

      <main class="chat-pane">
        <TeamChatPanel />
        <TeamSteerBar v-if="isActive && !readOnly" />
      </main>
    </section>

    <TeamTerminalPane
      v-if="terminalRole"
      :term-id="terminalRole.terminalId!"
      :title="terminalRoleTitle"
      @close="selectedRoleId = null"
    />

    <Transition name="panel">
      <TeamChangesPanel v-if="showChanges" @close="showChanges = false" />
    </Transition>
    <Transition name="panel">
      <TeamRunHistory v-if="showHistory" @close="showHistory = false" @opened="showHistory = false" />
    </Transition>
  </div>
</template>

<style scoped>
.team {
  position: relative;
  isolation: isolate;
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background:
    radial-gradient(circle at 12% 0%, color-mix(in srgb, var(--accent) 7%, transparent), transparent 34%),
    radial-gradient(circle at 92% 8%, color-mix(in srgb, var(--blue) 7%, transparent), transparent 28%),
    var(--bg);
}
.team::before {
  content: '';
  position: absolute;
  inset: 0;
  z-index: 0;
  pointer-events: none;
  background-image:
    linear-gradient(color-mix(in srgb, var(--border) 26%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--border) 22%, transparent) 1px, transparent 1px);
  background-size: 36px 36px;
  opacity: 0.12;
}
.team-header {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  min-height: var(--bar-h);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 42%),
    color-mix(in srgb, var(--bg-elev) 92%, var(--bg) 8%);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text) 4%, transparent);
}
.team-header::after {
  content: '';
  position: absolute;
  inset: 0 0 auto;
  height: 1px;
  background: linear-gradient(
    90deg,
    color-mix(in srgb, var(--accent) 48%, transparent),
    color-mix(in srgb, var(--green) 30%, transparent),
    transparent 62%
  );
  pointer-events: none;
}
.title-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex: none;
}
.brand {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-weight: 700;
  font-size: var(--text-md);
  white-space: nowrap;
}
.conn {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--slate);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--slate) 12%, transparent);
  transition:
    background-color var(--dur-base) var(--ease-standard),
    opacity var(--dur-base) var(--ease-standard);
}
.conn.ok {
  background: var(--green);
  box-shadow:
    0 0 0 3px color-mix(in srgb, var(--green) 18%, transparent),
    0 0 12px color-mix(in srgb, var(--green) 58%, transparent);
}
.run-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-2);
  min-width: 0;
  flex: 1 1 26rem;
}
.run-name {
  font-size: var(--text-sm);
  color: var(--text-dim);
  max-width: 42ch;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  background: color-mix(in srgb, var(--bg-elev-2) 72%, transparent);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  white-space: nowrap;
}
.chip-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-pill);
  background: currentColor;
  box-shadow: 0 0 0 3px color-mix(in srgb, currentColor 12%, transparent);
}
.st-running { color: var(--accent); border-color: color-mix(in srgb, var(--accent) 64%, var(--border)); }
.st-completed { color: var(--green); border-color: color-mix(in srgb, var(--green) 64%, var(--border)); }
.st-failed { color: var(--red); border-color: color-mix(in srgb, var(--red) 64%, var(--border)); }
.st-blocked, .st-interrupted { color: var(--amber); border-color: color-mix(in srgb, var(--amber) 64%, var(--border)); }
.st-paused, .st-stopped { color: var(--slate); border-color: color-mix(in srgb, var(--slate) 64%, var(--border)); }
.st-running .chip-dot,
.st-blocked .chip-dot {
  animation: chip-breathe 1.8s var(--ease-in-out) infinite;
}
.progress-meter {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-xs);
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, var(--border) 80%, transparent);
  border-radius: var(--radius-pill);
  background: color-mix(in srgb, var(--bg-elev-2) 48%, transparent);
}
.controls {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  min-width: 0;
}
.ro-tag {
  align-self: center;
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--amber);
}
.manage-toggle {
  margin-left: auto;
}
.placeholder {
  position: relative;
  z-index: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex: 1;
  color: var(--text-dim);
}
.workspace {
  position: relative;
  z-index: 1;
  display: grid;
  grid-template-columns: minmax(260px, 320px) 1fr;
  min-height: 0;
  flex: 1;
  background: linear-gradient(180deg, color-mix(in srgb, var(--bg-elev) 24%, transparent), transparent 180px);
}
.rail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-right: 1px solid var(--border);
  background:
    linear-gradient(180deg, color-mix(in srgb, var(--bg-elev) 82%, transparent), color-mix(in srgb, var(--bg) 72%, transparent)),
    var(--bg);
  box-shadow: inset -1px 0 0 color-mix(in srgb, var(--text) 3%, transparent);
  overflow-y: auto;
}
.rail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: var(--space-1);
}
.rail-head h3 {
  margin: 0;
  font-size: var(--text-sm);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.count {
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.roles {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.artifacts {
  margin-top: var(--space-2);
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.artifacts summary {
  cursor: pointer;
  color: var(--text-dim);
}
.artifacts ul {
  margin: var(--space-2) 0 0;
  padding-left: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.artifacts li {
  font-family: var(--font-mono);
  font-size: var(--text-xs);
  color: var(--text-faint);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chat-pane {
  display: flex;
  flex-direction: column;
  min-height: 0;
  min-width: 0;
  background:
    radial-gradient(circle at 70% 0%, color-mix(in srgb, var(--accent) 5%, transparent), transparent 30%),
    color-mix(in srgb, var(--bg) 94%, var(--bg-term) 6%);
}
@media (max-width: 720px) {
  .team-header {
    align-items: stretch;
    gap: var(--space-2);
    padding: var(--space-2) var(--space-3);
  }
  .title-group,
  .run-meta,
  .controls {
    width: 100%;
  }
  .run-meta {
    flex: 1 1 100%;
    flex-wrap: wrap;
    margin-left: 0;
  }
  .run-name {
    flex: 1 1 100%;
    max-width: 100%;
  }
  .controls {
    margin-left: 0;
    justify-content: flex-start;
  }
  .controls :deep(.btn) {
    max-width: 100%;
    min-width: 0;
  }
  .controls :deep(.btn-label) {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .workspace {
    grid-template-columns: 1fr;
  }
  .rail {
    min-height: 0;
    border-right: 0;
    border-bottom: 1px solid var(--border);
    box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text) 3%, transparent);
  }
}
@keyframes chip-breathe {
  0%,
  100% {
    opacity: 0.62;
  }
  50% {
    opacity: 1;
  }
}
@media (prefers-reduced-motion: reduce) {
  .st-running .chip-dot,
  .st-blocked .chip-dot {
    animation: none;
  }
}

/* Role tiles enter/leave with a subtle fade + slide; `tile-move` keeps the remaining
   tiles sliding smoothly when one is added/removed. Transform/opacity only — covered by
   the global prefers-reduced-motion safety net. */
.tile-enter-active,
.tile-leave-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.tile-enter-from,
.tile-leave-to {
  opacity: 0;
  transform: translateY(-6px);
}
.tile-leave-active {
  position: absolute;
  width: calc(100% - 2 * var(--space-3));
}
.tile-move {
  transition: transform var(--dur-base) var(--ease-standard);
}

/* The Changes / History overlay panels fade + slide in when opened/switched. */
.panel-enter-active,
.panel-leave-active {
  transition:
    opacity var(--dur-fast) var(--ease-standard),
    transform var(--dur-fast) var(--ease-out);
}
.panel-enter-from,
.panel-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>

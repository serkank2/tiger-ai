<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useConnectionStore } from '~/stores/connection';
import BaseButton from '../ui/BaseButton.vue';
import Spinner from '../ui/Spinner.vue';
import TeamLauncher from './TeamLauncher.vue';
import TeamRoleTile from './TeamRoleTile.vue';
import TeamChatPanel from './TeamChatPanel.vue';
import TeamDoneGate from './TeamDoneGate.vue';
import TeamSteerBar from './TeamSteerBar.vue';

const emit = defineEmits<{ back: [] }>();

const team = useTeamStore();
const connection = useConnectionStore();

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
const isActive = computed(() => status.value === 'running' || status.value === 'paused' || status.value === 'blocked');
const connected = computed(() => connection.status === 'connected');

const canPause = computed(() => status.value === 'running');
const canResume = computed(() => status.value === 'paused' || status.value === 'blocked' || status.value === 'interrupted');
const canStop = computed(() => isActive.value || status.value === 'interrupted');

const STATUS_LABEL: Record<string, string> = {
  running: 'Running',
  paused: 'Paused',
  blocked: 'Blocked',
  completed: 'Completed',
  failed: 'Failed',
  stopped: 'Stopped',
  interrupted: 'Interrupted',
};

function statusLabel(s: string | null): string {
  return s ? STATUS_LABEL[s] ?? s : 'No run';
}

async function reset() {
  // Returning to the launcher is a UI-only action; the run stays persisted and can be
  // re-opened by reloading state. We simply drop the active run from the view.
  team.state = null;
}
</script>

<template>
  <div class="team">
    <header class="team-header">
      <div class="title-group">
        <BaseButton variant="ghost" size="sm" aria-label="Back to terminals" icon-only @click="emit('back')">‹</BaseButton>
        <span class="brand">👥 AI Team</span>
        <span class="conn" :class="{ ok: connected }" :title="connected ? 'Live' : 'Disconnected'" />
      </div>

      <div v-if="state" class="run-meta">
        <span class="run-name" :title="state.goal">{{ state.name }}</span>
        <span class="status-chip" :class="`st-${status}`">{{ statusLabel(status) }}</span>
      </div>

      <div v-if="state" class="controls">
        <BaseButton
          v-if="canPause"
          size="sm"
          :loading="team.isBusy(`pause:${state.id}`)"
          @click="team.pause(state.id)"
        >Pause</BaseButton>
        <BaseButton
          v-if="canResume"
          size="sm"
          variant="primary"
          :loading="team.isBusy(`resume:${state.id}`)"
          @click="team.resume(state.id)"
        >Resume</BaseButton>
        <BaseButton
          v-if="canStop"
          size="sm"
          variant="danger"
          :loading="team.isBusy(`stop:${state.id}`)"
          @click="team.stop(state.id)"
        >Stop</BaseButton>
        <BaseButton v-if="!isActive" size="sm" variant="ghost" @click="reset">New run</BaseButton>
      </div>
    </header>

    <section v-if="!state && team.loading" class="placeholder">
      <Spinner :size="22" />
      <p>Loading team…</p>
    </section>

    <TeamLauncher v-else-if="!state" />

    <section v-else class="workspace">
      <aside class="rail">
        <TeamDoneGate :gate="state.doneGate" :status="status" :message="team.actionError" />
        <div class="rail-head">
          <h3>Roles</h3>
          <span class="count">{{ state.roles.length }}</span>
        </div>
        <div class="roles">
          <TeamRoleTile v-for="role in state.roles" :key="role.id" :role="role" />
        </div>
        <details v-if="team.artifacts.length" class="artifacts">
          <summary>Artifacts · {{ team.artifacts.length }}</summary>
          <ul>
            <li v-for="a in team.artifacts" :key="a.id" :title="a.path">{{ a.name }}</li>
          </ul>
        </details>
      </aside>

      <main class="chat-pane">
        <TeamChatPanel />
        <TeamSteerBar v-if="isActive" />
      </main>
    </section>
  </div>
</template>

<style scoped>
.team {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: var(--bg);
}
.team-header {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  min-height: var(--bar-h);
}
.title-group {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.brand {
  font-weight: 700;
  font-size: var(--text-md);
}
.conn {
  width: 8px;
  height: 8px;
  border-radius: var(--radius-pill);
  background: var(--slate);
}
.conn.ok {
  background: var(--green);
  box-shadow: 0 0 0 3px rgba(108, 197, 108, 0.18);
}
.run-meta {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin-left: var(--space-2);
  min-width: 0;
}
.run-name {
  font-size: var(--text-sm);
  color: var(--text-dim);
  max-width: 42ch;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-chip {
  font-size: var(--text-xs);
  font-weight: 700;
  padding: 2px 8px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.st-running { color: var(--accent); border-color: var(--accent); }
.st-completed { color: var(--green); border-color: var(--green); }
.st-failed { color: var(--red); border-color: var(--red); }
.st-blocked, .st-interrupted { color: var(--amber); border-color: var(--amber); }
.st-paused, .st-stopped { color: var(--slate); border-color: var(--slate); }
.controls {
  display: flex;
  gap: var(--space-2);
  margin-left: auto;
}
.placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  flex: 1;
  color: var(--text-dim);
}
.workspace {
  display: grid;
  grid-template-columns: minmax(260px, 320px) 1fr;
  min-height: 0;
  flex: 1;
}
.rail {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-3);
  border-right: 1px solid var(--border);
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
}
</style>

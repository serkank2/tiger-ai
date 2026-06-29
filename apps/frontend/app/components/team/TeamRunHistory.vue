<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useT } from '~/composables/useT';
import type { TeamRunStatus } from '~/types';
import BaseButton from '~/components/ui/BaseButton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const emit = defineEmits<{ close: []; opened: [] }>();
const team = useTeamStore();
const { t } = useT();

// This is a hand-rolled side drawer (BaseModal's centered layout doesn't fit), so it
// reproduces the accessible-dialog basics inline: focus-trap, initial focus, and
// focus-restore on close. Esc + role/aria-modal are wired in the template.
const drawerRef = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  const root = drawerRef.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

function onKeydown(e: KeyboardEvent): void {
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key !== 'Tab') return;
  const root = drawerRef.value;
  const els = focusables();
  if (!root || els.length === 0) {
    e.preventDefault();
    root?.focus();
    return;
  }
  const first = els[0]!;
  const last = els[els.length - 1]!;
  const active = document.activeElement as HTMLElement | null;
  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

onMounted(() => {
  opener = (document.activeElement as HTMLElement | null) ?? null;
  (focusables()[0] ?? drawerRef.value)?.focus();
});
onBeforeUnmount(() => {
  if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
});

const runs = computed(() => team.runHistory);
const loading = computed(() => team.runHistoryLoading);
const activeRunId = computed(() => team.activeRunId);

const STATUS_KEY: Record<TeamRunStatus, string> = {
  running: 'team.status.running',
  paused: 'team.status.paused',
  blocked: 'team.status.blocked',
  completed: 'team.status.completed',
  failed: 'team.status.failed',
  stopped: 'team.status.stopped',
  interrupted: 'team.status.interrupted',
};
function statusLabel(status: TeamRunStatus): string {
  return t(STATUS_KEY[status]) || status;
}

function when(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

async function open(runId: string): Promise<void> {
  try {
    await team.openRun(runId);
    emit('opened');
  } catch {
    /* notices surface the error */
  }
}

onMounted(() => void team.loadRuns());
</script>

<template>
  <div class="hist-overlay" @mousedown.self="emit('close')">
    <div
      ref="drawerRef"
      class="hist-drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="t('team.history.title')"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <header class="h-head">
        <strong>{{ t('team.history.title') }}</strong>
        <div class="h-actions">
          <BaseButton size="sm" variant="ghost" :loading="loading" @click="team.loadRuns()">{{ t('common.refresh') }}</BaseButton>
          <BaseButton size="sm" variant="ghost" @click="emit('close')">{{ t('team.history.close') }}</BaseButton>
        </div>
      </header>

      <section v-if="loading && !runs.length" class="h-state">
        <Spinner :size="20" /><span>{{ t('team.history.loading') }}</span>
      </section>
      <section v-else-if="!runs.length" class="h-state empty">
        <p>{{ t('team.history.empty') }}</p>
      </section>

      <ul v-else class="run-list">
        <li v-for="r in runs" :key="r.runId" class="run" :class="{ current: r.runId === activeRunId }">
          <div class="r-main">
            <div class="r-line">
              <span class="r-name" :title="r.goal">{{ r.name }}</span>
              <span class="r-status" :class="`st-${r.status}`">{{ statusLabel(r.status) }}</span>
              <span v-if="r.runId === activeRunId" class="r-live">{{ t('common.status.live') }}</span>
            </div>
            <div class="r-meta">
              <span>{{ t('team.history.roles', { n: r.roleCount }) }}</span>
              <span>{{ t('team.history.turns', { n: r.turnCount }) }}</span>
              <span>{{ t('team.history.messages', { n: r.messageCount }) }}</span>
              <span class="r-when">{{ when(r.startedAt ?? r.createdAt) }}</span>
            </div>
          </div>
          <div class="r-controls">
            <BaseButton
              size="sm"
              variant="ghost"
              :loading="team.isBusy(`open:${r.runId}`)"
              :disabled="r.runId === activeRunId && !team.readOnly"
              @click="open(r.runId)"
            >{{ t('common.open') }}</BaseButton>
            <BaseButton size="sm" variant="ghost" :title="t('team.export.jsonTooltip')" @click="team.exportRun('json', r.runId)">JSON</BaseButton>
            <BaseButton size="sm" variant="ghost" :title="t('team.export.markdownTooltip')" @click="team.exportRun('markdown', r.runId)">MD</BaseButton>
          </div>
        </li>
      </ul>
    </div>
  </div>
</template>

<style scoped>
.hist-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-backdrop);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}
.hist-drawer {
  width: min(560px, 92vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-shadow: var(--shadow-lg);
}
.h-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.h-actions { display: flex; gap: var(--space-1); }
.h-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--text-dim);
}
.run-list { list-style: none; margin: 0; padding: 0; overflow: auto; }
.run {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.run.current { background: var(--bg-elev); }
.r-main { min-width: 0; flex: 1; }
.r-line { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.r-name { font-weight: 600; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.r-status {
  font-size: var(--text-xs);
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 1px 6px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.st-running { color: var(--accent); border-color: var(--accent); }
.st-completed { color: var(--green); border-color: var(--green); }
.st-failed { color: var(--red); border-color: var(--red); }
.st-blocked, .st-interrupted { color: var(--amber); border-color: var(--amber); }
.r-live { font-size: var(--text-xs); color: var(--green); }
.r-meta { display: flex; gap: var(--space-2); margin-top: 2px; font-size: var(--text-xs); color: var(--text-faint); }
.r-when { margin-left: auto; }
.r-controls { display: flex; gap: var(--space-1); flex: none; }
.h-state.empty { color: var(--text-dim); }
</style>

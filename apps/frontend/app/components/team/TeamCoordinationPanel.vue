<script setup lang="ts">
import { computed } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useT } from '~/composables/useT';
import BaseButton from '~/components/ui/BaseButton.vue';

const team = useTeamStore();
const { t } = useT();

const handoffs = computed(() => team.handoffs);
const pendingHandoffs = computed(() => handoffs.value.filter((h) => h.pending));
const resolvedHandoffs = computed(() => handoffs.value.filter((h) => !h.pending));
const worktrees = computed(() => team.taskWorktrees);
// Worktrees left un-merged (a conflict / failed merge) are the ones the user can act on.
const keptWorktrees = computed(() => worktrees.value.filter((w) => w.status === 'conflict' || w.status === 'failed'));
const readOnly = computed(() => team.readOnly);

// Roles with a non-empty inbox (sendMessage verb deliveries pending their next turn).
const inboxes = computed(() =>
  team.roles.map((r) => ({ id: r.id, name: r.name, count: r.inbox ?? 0 })).filter((r) => r.count > 0),
);

const hasAnything = computed(() => handoffs.value.length > 0 || worktrees.value.length > 0 || inboxes.value.length > 0);

function roleName(id: string): string {
  return team.roles.find((r) => r.id === id)?.name ?? id;
}

async function merge(taskId: string): Promise<void> {
  await team.mergeWorktree(taskId, false).catch(() => {});
}
async function discard(taskId: string): Promise<void> {
  const ok = await useDialog().confirm({
    title: t('team.coordination.discardTitle'),
    message: t('team.coordination.discardMessage', { taskId }),
    confirmText: t('team.coordination.discard'),
    danger: true,
  });
  if (!ok) return;
  await team.mergeWorktree(taskId, true).catch(() => {});
}
</script>

<template>
  <section class="coord" :aria-label="t('team.coordination.ariaLabel')">
    <h3 class="coord-title">{{ t('team.coordination.title') }}</h3>

    <p v-if="!hasAnything" class="coord-empty">
      {{ t('team.coordination.empty') }}
    </p>

    <!-- Handoff dependencies (CAO handoff verb) -->
    <div v-if="handoffs.length" class="coord-block" data-testid="handoffs">
      <h4>{{ t('team.coordination.handoffs') }}</h4>
      <ul class="coord-list">
        <li v-for="h in pendingHandoffs" :key="h.id" class="coord-row pending" data-testid="handoff-pending">
          <span class="badge b-pending">{{ t('team.coordination.blocking') }}</span>
          <span class="flow">{{ roleName(h.fromRoleId) }} to {{ roleName(h.toRoleId) }}</span>
          <span class="task">{{ h.taskId }}</span>
          <span class="ttl">{{ h.title }}</span>
        </li>
        <li v-for="h in resolvedHandoffs" :key="h.id" class="coord-row done" data-testid="handoff-done">
          <span class="badge b-done">{{ t('team.coordination.done') }}</span>
          <span class="flow">{{ roleName(h.fromRoleId) }} to {{ roleName(h.toRoleId) }}</span>
          <span class="task">{{ h.taskId }}</span>
          <span class="ttl">{{ h.title }}</span>
        </li>
      </ul>
    </div>

    <!-- Per-role inboxes (sendMessage verb) -->
    <div v-if="inboxes.length" class="coord-block" data-testid="inboxes">
      <h4>{{ t('team.coordination.inboxes') }}</h4>
      <ul class="coord-list">
        <li v-for="r in inboxes" :key="r.id" class="coord-row" data-testid="inbox-row">
          <span class="badge b-inbox">{{ r.count }}</span>
          <span class="flow">{{ r.name }}</span>
          <span class="ttl">{{ t('team.coordination.messagesWaiting') }}</span>
        </li>
      </ul>
    </div>

    <!-- Per-task git worktrees (Part B) -->
    <div v-if="worktrees.length" class="coord-block" data-testid="worktrees">
      <h4>{{ t('team.coordination.worktrees') }}</h4>
      <ul class="coord-list">
        <li v-for="w in worktrees" :key="w.branch" class="coord-row" data-testid="worktree-row">
          <span class="badge" :class="`wt-${w.status}`">{{ w.status }}</span>
          <span class="task">{{ w.taskId }}</span>
          <span class="branch">Branch: {{ w.branch }}</span>
          <span v-if="w.note" class="note">{{ w.note }}</span>
          <span class="spacer" />
          <template v-if="!readOnly && (w.status === 'conflict' || w.status === 'failed')">
            <BaseButton
              size="sm"
              variant="primary"
              :loading="team.isBusy(`worktree:${w.taskId}`)"
              data-testid="worktree-merge"
              @click="merge(w.taskId)"
              >{{ t('team.coordination.mergeBack') }}</BaseButton
            >
            <BaseButton
              size="sm"
              variant="ghost"
              :disabled="team.isBusy(`worktree:${w.taskId}`)"
              data-testid="worktree-discard"
              @click="discard(w.taskId)"
              >{{ t('team.coordination.discard') }}</BaseButton
            >
          </template>
        </li>
      </ul>
      <p v-if="keptWorktrees.length" class="coord-hint">
        {{ keptWorktrees.length }} worktree(s) were kept un-merged after a conflict. Resolve manually, then Merge back
        or Discard.
      </p>
    </div>
  </section>
</template>

<style scoped>
.coord {
  padding: var(--space-2) var(--space-3);
}
.coord-title {
  font-size: var(--text-sm);
  margin: 0 0 var(--space-2);
}
.coord-empty {
  color: var(--text-dim);
  font-size: var(--text-xs);
}
.coord-block {
  margin-bottom: var(--space-3);
}
.coord-block h4 {
  font-size: var(--text-xs);
  color: var(--text-dim);
  margin: 0 0 var(--space-1);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.coord-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.coord-row {
  display: flex;
  align-items: flex-start;
  flex-wrap: wrap;
  gap: 3px var(--space-2);
  min-width: 0;
  padding: 3px 0;
  font-size: var(--text-sm);
}
.coord-row .spacer {
  flex: 1;
}
.flow {
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
}
.task {
  flex: none;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  color: var(--accent);
}
.branch {
  min-width: 0;
  overflow-wrap: anywhere;
  font-family: var(--font-mono, monospace);
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.ttl {
  flex: 1 1 12rem;
  min-width: 0;
  color: var(--text-dim);
  overflow-wrap: anywhere;
  line-height: var(--leading-snug);
}
.note {
  min-width: 0;
  color: var(--red);
  font-size: var(--text-xs);
  overflow-wrap: anywhere;
}
.coord-hint {
  color: var(--amber);
  font-size: var(--text-xs);
  margin: var(--space-1) 0 0;
}
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  min-width: 18px;
  height: 18px;
  padding: 0 5px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
  font-weight: 700;
  border: 1px solid var(--border-strong);
}
.b-pending {
  color: var(--amber);
  border-color: var(--amber);
}
.b-done {
  color: var(--green);
  border-color: var(--green);
}
.b-inbox {
  color: var(--accent);
  border-color: var(--accent);
}
.wt-active {
  color: var(--text-dim);
}
.wt-merged {
  color: var(--green);
  border-color: var(--green);
}
.wt-conflict {
  color: var(--red);
  border-color: var(--red);
}
.wt-failed {
  color: var(--amber);
  border-color: var(--amber);
}
</style>

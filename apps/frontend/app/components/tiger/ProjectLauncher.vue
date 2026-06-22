<script setup lang="ts">
import BaseButton from '~/components/ui/BaseButton.vue';
import Spinner from '~/components/ui/Spinner.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import { useT } from '~/composables/useT';

const { t } = useT();

const emit = defineEmits<{ new: [] }>();
const tiger = useTigerStore();
const dialog = useDialog();

// Local per-action pending state (the store has no per-project busy flag).
const refreshing = ref(false);
const opening = ref<string | null>(null);
const forgetting = ref<string | null>(null);

async function refresh() {
  refreshing.value = true;
  try {
    await tiger.loadProjects();
  } finally {
    refreshing.value = false;
  }
}

async function open(path: string) {
  opening.value = path;
  try {
    await tiger.openProject(path);
  } finally {
    opening.value = null;
  }
}

async function forget(p: { path: string; name: string }) {
  const ok = await dialog.confirm({
    title: t('tiger.projectLauncher.forgetDialogTitle'),
    message: t('tiger.projectLauncher.forgetDialogMessage', { name: p.name }),
    confirmText: t('tiger.projectLauncher.forgetDialogConfirm'),
    danger: true,
  });
  if (!ok) return;
  forgetting.value = p.path;
  try {
    await tiger.forgetProject(p.path);
  } finally {
    forgetting.value = null;
  }
}

function pct(p: { completedStages: number; totalStages: number }): number {
  return p.totalStages ? Math.round((p.completedStages / p.totalStages) * 100) : 0;
}
function fmtDate(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '';
  }
}

onMounted(() => {
  void tiger.loadProjects();
});
</script>

<template>
  <section class="launcher">
    <div class="lhead">
      <h2>{{ t('tiger.projectLauncher.title') }}</h2>
      <span class="spacer" />
      <BaseButton
        variant="secondary"
        icon-only
        :aria-label="t('tiger.projectLauncher.refreshProjects')"
        :title="t('tiger.projectLauncher.refresh')"
        :loading="refreshing"
        @click="refresh"
      >
        ⟳
      </BaseButton>
    </div>
    <p class="lead">{{ t('tiger.projectLauncher.lead') }}</p>

    <div class="grid">
      <button class="card new" @click="emit('new')">
        <span class="plus">＋</span>
        <span class="newlabel">{{ t('tiger.projectLauncher.newProject') }}</span>
        <span class="newhint">{{ t('tiger.projectLauncher.newProjectHint') }}</span>
      </button>

      <div v-if="tiger.projectsLoading && !tiger.projects.length" class="card skeleton-card">
        <Spinner :size="14" :label="t('tiger.projectLauncher.loading')" />
        <Skeleton :lines="4" />
      </div>

      <div v-else-if="tiger.projectsLoadError && !tiger.projects.length" class="card skeleton-card">
        <EmptyState
          tone="danger"
          icon="⚠️"
          :title="t('tiger.projectLauncher.errorStateTitle')"
          :description="tiger.projectsLoadError"
        >
          <template #actions>
            <BaseButton variant="secondary" @click="refresh">{{ t('tiger.projectLauncher.refresh') }}</BaseButton>
          </template>
        </EmptyState>
      </div>

      <div v-else-if="!tiger.projectsLoading && !tiger.projects.length" class="card skeleton-card">
        <EmptyState
          :title="t('tiger.projectLauncher.emptyStateTitle')"
          :description="t('tiger.projectLauncher.emptyStateDesc')"
        />
      </div>

      <div v-for="p in tiger.projects" :key="p.path" class="card" :class="{ missing: !p.exists }">
        <div class="ctop">
          <span class="cname" :title="p.path">📁 {{ p.name }}</span>
          <BaseButton
            class="forget"
            variant="ghost"
            size="sm"
            icon-only
            :title="t('tiger.projectLauncher.forgetTitle')"
            :aria-label="t('tiger.projectLauncher.forgetAriaLabel', { name: p.name })"
            :loading="forgetting === p.path"
            @click="forget(p)"
          >
            ✕
          </BaseButton>
        </div>
        <p class="cprompt">{{ p.promptPreview || (p.exists ? t('tiger.projectLauncher.noPromptYet') : t('tiger.projectLauncher.folderMissing')) }}</p>
        <div class="cprog">
          <div class="ptrack"><div class="pfill" :style="{ width: pct(p) + '%' }" /></div>
          <span class="pn">{{ t('tiger.projectLauncher.stagesProgress', { completed: p.completedStages, total: p.totalStages }) }}</span>
        </div>
        <div class="cfoot">
          <span class="cdate">{{ fmtDate(p.updatedAt) }}</span>
          <span class="spacer" />
          <BaseButton
            class="open"
            variant="secondary"
            size="sm"
            :disabled="!p.exists"
            :loading="opening === p.path"
            @click="open(p.path)"
          >
            {{ p.completedStages > 0 ? t('tiger.projectLauncher.continueBtn') : t('tiger.projectLauncher.openBtn') }}
          </BaseButton>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.launcher {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}
.lhead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.lhead h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.lead {
  color: var(--text-dim);
  margin: 6px 0 18px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 14px;
  min-height: 150px;
}
.card.missing {
  opacity: 0.6;
}
.card.new {
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: var(--border-strong);
  color: var(--text-dim);
  gap: 6px;
}
.card.new:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.skeleton-card {
  justify-content: center;
}
.plus {
  font-size: 28px;
  line-height: 1;
}
.newlabel {
  font-weight: 700;
  font-size: 14px;
}
.newhint {
  font-size: 11px;
  color: var(--text-faint);
}
.ctop {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cname {
  font-weight: 700;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.forget {
  flex: none;
  color: var(--text-faint);
}
.forget:hover {
  color: var(--red);
}
.cprompt {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}
.cprog {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ptrack {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-term);
  border: 1px solid var(--border);
  overflow: hidden;
}
.pfill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.4s ease;
}
.pn {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.cfoot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cdate {
  font-size: 10px;
  color: var(--text-faint);
}
.open {
  border-color: var(--accent);
  color: var(--accent);
  background: transparent;
}
.open:hover:not(:disabled) {
  background: var(--accent-soft);
  border-color: var(--accent);
}
</style>

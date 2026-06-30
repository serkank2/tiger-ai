<script setup lang="ts">
// Settings home. Surfaces system status — MySQL readiness (the durable system of
// record) and legacy-import status — and hosts app preferences via the retained
// SettingsModal, reachable from the shell instead of a hidden command-bar icon.
import type { HealthStatus } from '~/types';
import { errText } from '~/lib/apiError';
import StateView from '~/components/state/StateView.vue';
import SettingsModal from '~/components/SettingsModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';

const { t } = useT();
const api = useApi();
const settings = useSettingsStore();
const theme = useThemeStore();
const tiger = useTigerStore();

const health = ref<HealthStatus | null>(null);
const templateCount = ref<number | null>(null);
const loading = ref(false);
const error = ref('');
const showPreferences = ref(false);

async function loadStatus() {
  loading.value = true;
  error.value = '';
  try {
    // Health is the DB-readiness probe; projects + templates evidence that legacy
    // file-state was imported into MySQL on startup.
    const [h, templates] = await Promise.all([api.getHealth(), api.listTigerTemplates().catch(() => [])]);
    health.value = h;
    templateCount.value = templates.length;
    await tiger.loadProjects().catch(() => {});
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}

const dbReady = computed(() => health.value?.db.ready ?? false);
const projectCount = computed(() => tiger.projects.length);

onMounted(loadStatus);
</script>

<template>
  <section class="page">
    <header class="page-head">
      <h2>{{ t('settings.title') }}</h2>
      <p class="lead">{{ t('settings.page.lead') }}</p>
    </header>

    <StateView v-if="loading && !health" kind="loading" :title="t('settings.page.checking')" />
    <StateView v-else-if="error && !health" kind="error" :title="t('settings.page.loadError')" :description="error">
      <BaseButton @click="loadStatus">{{ t('common.retry') }}</BaseButton>
    </StateView>

    <template v-else>
      <!-- System status -->
      <section class="card">
        <header class="card-head">
          <h3>{{ t('settings.page.systemStatus') }}</h3>
          <BaseButton size="sm" :loading="loading" @click="loadStatus">
            {{ loading ? t('settings.page.refreshing') : t('common.refresh') }}
          </BaseButton>
        </header>
        <dl class="grid">
          <div class="row">
            <dt>{{ t('settings.page.database') }}</dt>
            <dd>
              <span class="pill" :class="dbReady ? 'ok' : 'bad'" role="status">
                <span class="dot" aria-hidden="true" />{{
                  dbReady ? t('common.status.ready') : t('settings.page.unavailable')
                }}
              </span>
              <span v-if="health?.db.name" class="muted">{{ health.db.name }}</span>
            </dd>
          </div>
          <div class="row">
            <dt>{{ t('settings.page.backend') }}</dt>
            <dd>
              <span class="pill" :class="health?.ok ? 'ok' : 'bad'" role="status">
                <span class="dot" aria-hidden="true" />{{ health?.status ?? t('common.status.unknown') }}
              </span>
            </dd>
          </div>
          <div class="row">
            <dt>{{ t('settings.page.terminalsTracked') }}</dt>
            <dd>{{ health?.terminals ?? '—' }}</dd>
          </div>
          <div class="row">
            <dt>{{ t('settings.page.dataDirectory') }}</dt>
            <dd class="mono">{{ health?.dataDir ?? '—' }}</dd>
          </div>
        </dl>
        <p v-if="!dbReady" class="warn">{{ t('settings.page.dbWarn') }}</p>
      </section>

      <!-- Legacy import -->
      <section class="card">
        <header class="card-head">
          <h3>{{ t('settings.page.legacyImport') }}</h3>
        </header>
        <p class="card-lead">{{ t('settings.page.legacyLead') }}</p>
        <dl class="grid">
          <div class="row">
            <dt>{{ t('settings.page.projectsAvailable') }}</dt>
            <dd>{{ projectCount }}</dd>
          </div>
          <div class="row">
            <dt>{{ t('settings.page.runTemplates') }}</dt>
            <dd>{{ templateCount ?? '—' }}</dd>
          </div>
        </dl>
      </section>

      <!-- Preferences -->
      <section class="card">
        <header class="card-head">
          <h3>{{ t('settings.page.preferences') }}</h3>
          <BaseButton size="sm" @click="showPreferences = true">{{ t('settings.page.editPreferences') }}</BaseButton>
        </header>
        <dl class="grid">
          <div class="row">
            <dt>{{ t('settings.theme') }}</dt>
            <dd>{{ theme.current.label }}</dd>
          </div>
          <div class="row">
            <dt>{{ t('settings.defaultCwd') }}</dt>
            <dd class="mono">{{ settings.settings?.defaultCwd || '—' }}</dd>
          </div>
          <div class="row">
            <dt>{{ t('settings.defaultShell') }}</dt>
            <dd>{{ settings.settings?.defaultShell.kind ?? '—' }}</dd>
          </div>
        </dl>
      </section>
    </template>

    <SettingsModal v-if="showPreferences && settings.settings" @close="showPreferences = false" />
  </section>
</template>

<style scoped>
.page {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px;
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.page-head h2 {
  margin: 0 0 6px;
  font-size: var(--text-xl);
}
.lead {
  margin: 0;
  max-width: 70ch;
  color: var(--text-dim);
  line-height: var(--leading-normal);
}
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 16px 18px;
  max-width: 720px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}
.card-head h3 {
  margin: 0;
  font-size: var(--text-md);
}
.card-lead {
  margin: 0 0 12px;
  color: var(--text-dim);
  font-size: var(--text-sm);
  line-height: var(--leading-snug);
  max-width: 64ch;
}
.grid {
  display: grid;
  gap: 10px;
  margin: 0;
}
.row {
  display: grid;
  grid-template-columns: 200px 1fr;
  gap: 12px;
  align-items: baseline;
}
dt {
  color: var(--text-faint);
  font-size: var(--text-sm);
  font-weight: 600;
}
dd {
  margin: 0;
  color: var(--text);
  font-size: var(--text-sm);
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.mono {
  font-family: var(--font-mono);
  overflow-wrap: anywhere;
}
.muted {
  color: var(--text-faint);
  font-size: var(--text-xs);
}
.pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 2px 9px;
  border-radius: var(--radius-pill);
  border: 1px solid var(--border-strong);
  font-size: var(--text-xs);
  font-weight: 700;
}
.pill .dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--slate);
}
.pill.ok {
  color: var(--green);
  border-color: var(--green);
}
.pill.ok .dot {
  background: var(--green);
}
.pill.bad {
  color: var(--red);
  border-color: var(--red);
}
.pill.bad .dot {
  background: var(--red);
}
.warn {
  margin: 12px 0 0;
  color: var(--amber);
  font-size: var(--text-sm);
}

@media (max-width: 560px) {
  .row {
    grid-template-columns: 1fr;
    gap: 4px;
  }
}
</style>

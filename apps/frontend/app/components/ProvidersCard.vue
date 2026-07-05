<script setup lang="ts">
// Provider CLI configuration (app-level providers.json): executable + default
// model/effort/permission per provider. This replaced the retired Tiger config
// screen as the single place these knobs are edited.
import { onMounted, reactive, ref } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseField from '~/components/ui/BaseField.vue';
import BaseInput from '~/components/ui/BaseInput.vue';
import BaseSelect from '~/components/ui/BaseSelect.vue';
import Spinner from '~/components/ui/Spinner.vue';
import { useApi } from '~/composables/useApi';
import { useNoticesStore } from '~/stores/notices';
import { useT } from '~/composables/useT';
import { errText } from '~/lib/apiError';
import type { ProvidersConfig } from '~/types';

const api = useApi();
const notices = useNoticesStore();
const { t } = useT();

const PROVIDERS = ['claude', 'codex', 'antigravity'] as const;
type ProviderKey = (typeof PROVIDERS)[number];

const config = ref<ProvidersConfig | null>(null);
const loading = ref(false);
const saving = ref(false);
const error = ref('');

const draft = reactive<Record<ProviderKey, { executable: string; model: string; effort: string; permission: string }>>({
  claude: { executable: '', model: '', effort: '', permission: '' },
  codex: { executable: '', model: '', effort: '', permission: '' },
  antigravity: { executable: '', model: '', effort: '', permission: '' },
});

function applyConfig(next: ProvidersConfig): void {
  config.value = next;
  for (const key of PROVIDERS) {
    draft[key] = {
      executable: next[key].executable,
      model: next[key].model,
      effort: next[key].effort,
      permission: next[key].permission,
    };
  }
}

async function load(): Promise<void> {
  loading.value = true;
  error.value = '';
  try {
    const { config: next } = await api.getProvidersConfig();
    applyConfig(next);
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}

async function save(): Promise<void> {
  saving.value = true;
  error.value = '';
  try {
    const { config: next } = await api.updateProvidersConfig({
      claude: draft.claude,
      codex: draft.codex,
      antigravity: draft.antigravity,
    });
    applyConfig(next);
    notices.push(t('settings.providers.saved'), 'info');
  } catch (e) {
    error.value = errText(e);
  } finally {
    saving.value = false;
  }
}

function options(values: string[], current: string): { value: string; label: string }[] {
  const set = new Set(values);
  if (current) set.add(current);
  set.add('');
  return [...set].map((value) => ({ value, label: value || t('settings.providers.cliDefault') }));
}

onMounted(load);
</script>

<template>
  <section class="card" data-testid="providers-card">
    <header class="card-head">
      <h3>{{ t('settings.providers.title') }}</h3>
      <BaseButton size="sm" :loading="saving" :disabled="!config" data-testid="providers-save" @click="save">
        {{ t('common.save') }}
      </BaseButton>
    </header>
    <p class="card-lead">{{ t('settings.providers.lead') }}</p>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <div v-if="loading" class="loading"><Spinner /> {{ t('common.loading') }}…</div>

    <div v-if="config" class="providers">
      <fieldset v-for="key in PROVIDERS" :key="key" class="provider">
        <legend>{{ key }}</legend>
        <BaseField :label="t('settings.providers.executable')">
          <BaseInput v-model="draft[key].executable" :data-testid="`providers-${key}-executable`" />
        </BaseField>
        <BaseField :label="t('settings.providers.model')">
          <BaseSelect v-model="draft[key].model" :options="options(config[key].models, draft[key].model)" />
        </BaseField>
        <BaseField v-if="config[key].efforts.length > 1" :label="t('settings.providers.effort')">
          <BaseSelect v-model="draft[key].effort" :options="options(config[key].efforts, draft[key].effort)" />
        </BaseField>
        <BaseField :label="t('settings.providers.permission')">
          <BaseSelect
            v-model="draft[key].permission"
            :options="options(config[key].permissionModes, draft[key].permission)"
          />
        </BaseField>
      </fieldset>
    </div>
  </section>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-elev);
  padding: 14px;
}
.card-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
}
.card-head h3 {
  margin: 0;
}
.card-lead {
  color: var(--text-dim);
  font-size: 13px;
  margin: 6px 0 12px;
}
.error {
  color: var(--danger, #f87171);
}
.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
}
.providers {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 260px), 1fr));
  gap: 12px;
}
.provider {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 10px 12px 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.provider legend {
  padding: 0 6px;
  font-weight: 600;
  text-transform: capitalize;
}
</style>

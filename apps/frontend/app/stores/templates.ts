import { computed, ref } from 'vue';
import { defineStore } from 'pinia';
import type { TigerRunTemplate, TigerRunTemplatePayload } from '~/types';
import { useApi } from '~/composables/useApi';
import { errText } from '~/lib/apiError';
import { useNoticesStore } from '~/stores/notices';

export function templateRef(template: Pick<TigerRunTemplate, 'id' | 'name'>): string {
  return template.id ?? template.name;
}

function sameTemplate(a: TigerRunTemplate, b: Pick<TigerRunTemplate, 'id' | 'name'>): boolean {
  return (!!a.id && !!b.id && a.id === b.id) || a.name.toLowerCase() === b.name.toLowerCase();
}

export const useTemplatesStore = defineStore('templates', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const items = ref<TigerRunTemplate[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const operationError = ref<string | null>(null);
  const savedMessage = ref<string | null>(null);
  const saving = ref(false);
  const applyingId = ref<string | null>(null);
  const duplicatingId = ref<string | null>(null);
  const archivingId = ref<string | null>(null);

  const builtins = computed(() => items.value.filter((template) => template.builtin));
  const custom = computed(() => items.value.filter((template) => !template.builtin));

  function clearFeedback() {
    operationError.value = null;
    savedMessage.value = null;
  }

  function setList(next: TigerRunTemplate[]) {
    items.value = next;
    loaded.value = true;
    loadError.value = null;
  }

  function replaceTemplate(template: TigerRunTemplate) {
    const index = items.value.findIndex((item) => sameTemplate(item, template));
    if (index >= 0) items.value.splice(index, 1, template);
    else items.value.push(template);
  }

  function recordSuccess(message: string) {
    operationError.value = null;
    savedMessage.value = message;
    notices.push(message, 'info');
  }

  function recordFailure(prefix: string, error: unknown) {
    const message = errText(error);
    operationError.value = message;
    savedMessage.value = null;
    notices.push(`${prefix}: ${message}`, 'error');
  }

  async function load(force = false) {
    if (loading.value) return;
    if (loaded.value && !force) return;
    loading.value = true;
    try {
      setList(await api.listTigerTemplates());
    } catch (error) {
      loadError.value = errText(error);
      notices.push(`Templates: ${loadError.value}`, 'error');
    } finally {
      loading.value = false;
    }
  }

  async function create(payload: TigerRunTemplatePayload): Promise<TigerRunTemplate | null> {
    saving.value = true;
    clearFeedback();
    try {
      const next = await api.createTigerTemplate(payload);
      setList(next);
      const created = next.find((template) => template.name.toLowerCase() === payload.name.toLowerCase()) ?? null;
      recordSuccess('Template saved');
      return created;
    } catch (error) {
      recordFailure('Template save failed', error);
      throw error;
    } finally {
      saving.value = false;
    }
  }

  async function update(id: string, payload: Partial<TigerRunTemplatePayload>): Promise<TigerRunTemplate> {
    saving.value = true;
    clearFeedback();
    try {
      const updated = await api.updateTigerTemplate(id, payload);
      replaceTemplate(updated);
      recordSuccess('Template saved');
      return updated;
    } catch (error) {
      recordFailure('Template save failed', error);
      throw error;
    } finally {
      saving.value = false;
    }
  }

  async function duplicate(template: TigerRunTemplate, payload: Partial<TigerRunTemplatePayload> = {}): Promise<TigerRunTemplate> {
    const id = templateRef(template);
    duplicatingId.value = id;
    clearFeedback();
    try {
      const copy = await api.duplicateTigerTemplate(id, payload);
      replaceTemplate(copy);
      recordSuccess('Template duplicated');
      return copy;
    } catch (error) {
      recordFailure('Template duplicate failed', error);
      throw error;
    } finally {
      duplicatingId.value = null;
    }
  }

  async function archive(template: TigerRunTemplate): Promise<void> {
    const id = templateRef(template);
    archivingId.value = id;
    clearFeedback();
    try {
      setList(await api.archiveTigerTemplate(id));
      recordSuccess('Template archived');
    } catch (error) {
      recordFailure('Template archive failed', error);
      throw error;
    } finally {
      archivingId.value = null;
    }
  }

  async function apply(template: TigerRunTemplate): Promise<TigerRunTemplate> {
    const id = templateRef(template);
    applyingId.value = id;
    clearFeedback();
    try {
      const applied = await api.applyTigerTemplate(id);
      recordSuccess('Template applied');
      return applied;
    } catch (error) {
      recordFailure('Template apply failed', error);
      throw error;
    } finally {
      applyingId.value = null;
    }
  }

  return {
    items,
    builtins,
    custom,
    loaded,
    loading,
    loadError,
    operationError,
    savedMessage,
    saving,
    applyingId,
    duplicatingId,
    archivingId,
    clearFeedback,
    load,
    create,
    update,
    duplicate,
    archive,
    apply,
  };
});

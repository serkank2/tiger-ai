import type { Group } from '~/types';
import { errText } from '~/lib/apiError';

export const useGroupsStore = defineStore('groups', () => {
  const api = useApi();
  const notices = useNoticesStore();
  const groups = ref<Group[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);

  const byId = computed<Record<string, Group>>(() => Object.fromEntries(groups.value.map((g) => [g.id, g])));

  async function load() {
    loading.value = true;
    try {
      groups.value = await api.listGroups();
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      notices.push(`Load groups failed: ${loadError.value}`, 'error');
      throw e;
    } finally {
      loading.value = false;
    }
  }
  async function create(body: { name: string; color?: string }) {
    try {
      const g = await api.createGroup(body);
      groups.value.push(g);
      return g;
    } catch (e) {
      notices.push(`Create group failed: ${errText(e)}`, 'error');
      throw e;
    }
  }
  async function update(id: string, body: { name?: string; color?: string }) {
    try {
      const g = await api.updateGroup(id, body);
      const i = groups.value.findIndex((x) => x.id === id);
      if (i >= 0) groups.value[i] = g;
      return g;
    } catch (e) {
      notices.push(`Update group failed: ${errText(e)}`, 'error');
      throw e;
    }
  }
  async function remove(id: string) {
    try {
      await api.deleteGroup(id);
      groups.value = groups.value.filter((g) => g.id !== id);
    } catch (e) {
      notices.push(`Delete group failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  return { groups, loaded, loading, loadError, byId, load, create, update, remove };
});

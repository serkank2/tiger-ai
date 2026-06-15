import type { Group } from '~/types';

export const useGroupsStore = defineStore('groups', () => {
  const api = useApi();
  const groups = ref<Group[]>([]);

  const byId = computed<Record<string, Group>>(() => Object.fromEntries(groups.value.map((g) => [g.id, g])));

  async function load() {
    groups.value = await api.listGroups();
  }
  async function create(body: { name: string; color?: string }) {
    const g = await api.createGroup(body);
    groups.value.push(g);
    return g;
  }
  async function update(id: string, body: { name?: string; color?: string }) {
    const g = await api.updateGroup(id, body);
    const i = groups.value.findIndex((x) => x.id === id);
    if (i >= 0) groups.value[i] = g;
    return g;
  }
  async function remove(id: string) {
    await api.deleteGroup(id);
    groups.value = groups.value.filter((g) => g.id !== id);
  }

  return { groups, byId, load, create, update, remove };
});

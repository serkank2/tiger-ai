export interface Notice {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

export const useNoticesStore = defineStore('notices', () => {
  const items = ref<Notice[]>([]);
  let seq = 0;

  function push(text: string, kind: 'info' | 'error' = 'info', ttl = 3500) {
    const id = ++seq;
    items.value.push({ id, kind, text });
    if (import.meta.client) setTimeout(() => dismiss(id), ttl);
  }
  function dismiss(id: number) {
    items.value = items.value.filter((n) => n.id !== id);
  }

  return { items, push, dismiss };
});

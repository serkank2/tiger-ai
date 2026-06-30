export interface Notice {
  id: number;
  kind: 'info' | 'error';
  text: string;
}

const MAX_NOTICES = 4;

export const useNoticesStore = defineStore('notices', () => {
  const items = ref<Notice[]>([]);
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  let seq = 0;

  function push(text: string, kind: 'info' | 'error' = 'info', ttl = 3500) {
    // coalesce an immediate duplicate of the newest toast
    const last = items.value[items.value.length - 1];
    if (last && last.text === text && last.kind === kind) return;

    const id = ++seq;
    items.value.push({ id, kind, text });
    while (items.value.length > MAX_NOTICES) {
      const removed = items.value.shift();
      if (removed) clearTimer(removed.id);
    }
    if (import.meta.client)
      timers.set(
        id,
        setTimeout(() => dismiss(id), ttl),
      );
  }

  function dismiss(id: number) {
    items.value = items.value.filter((n) => n.id !== id);
    clearTimer(id);
  }
  function clearTimer(id: number) {
    const t = timers.get(id);
    if (t) {
      clearTimeout(t);
      timers.delete(id);
    }
  }

  return { items, push, dismiss };
});

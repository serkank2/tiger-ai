import { setActivePinia, createPinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { useDialog } from '~/composables/useDialog';
import { useDialogStore } from '~/stores/dialog';

// The promise-based confirm()/alert() replacement: a request enqueues a pending
// dialog; the global outlet resolves it via store.settle(). These tests drive the
// store directly (no component) to assert the promise contract.
beforeEach(() => {
  setActivePinia(createPinia());
});

describe('useDialog', () => {
  it('confirm resolves true when settled true', async () => {
    const dialog = useDialog();
    const store = useDialogStore();
    const p = dialog.confirm('Delete?');
    expect(store.current?.kind).toBe('confirm');
    expect(store.current?.message).toBe('Delete?');
    store.settle(store.current!.id, true);
    await expect(p).resolves.toBe(true);
    expect(store.current).toBeNull();
  });

  it('confirm resolves false when settled false (cancel/Esc/backdrop)', async () => {
    const dialog = useDialog();
    const store = useDialogStore();
    const p = dialog.confirm({ message: 'Discard?', danger: true });
    expect(store.current?.danger).toBe(true);
    store.settle(store.current!.id, false);
    await expect(p).resolves.toBe(false);
  });

  it('alert carries its message and resolves true once dismissed', async () => {
    const dialog = useDialog();
    const store = useDialogStore();
    const p = dialog.alert('Saved.');
    expect(store.current?.kind).toBe('alert');
    store.settle(store.current!.id, true);
    await expect(p).resolves.toBe(true);
  });

  it('queues multiple requests and surfaces them one at a time in order', async () => {
    const dialog = useDialog();
    const store = useDialogStore();
    const first = dialog.confirm('First');
    const second = dialog.confirm('Second');
    expect(store.queue).toHaveLength(2);
    expect(store.current?.message).toBe('First');

    store.settle(store.current!.id, true);
    await expect(first).resolves.toBe(true);
    expect(store.current?.message).toBe('Second');

    store.settle(store.current!.id, false);
    await expect(second).resolves.toBe(false);
    expect(store.current).toBeNull();
  });
});

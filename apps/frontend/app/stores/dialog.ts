import { computed, ref } from 'vue';
import { defineStore } from 'pinia';

// Backing store for the app's promise-based confirm()/alert() replacement.
//
// A native confirm()/alert() blocks the event loop and can't be themed or made
// accessible. Instead callers use the `useDialog()` composable, which pushes a
// request here; the global <ConfirmDialog> outlet (mounted once in app.vue) renders
// the styled, focus-trapped modal and resolves the promise on the user's choice.
export type DialogKind = 'confirm' | 'alert';

export interface DialogRequest {
  id: number;
  kind: DialogKind;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  /** Style the confirm action as destructive (red). */
  danger?: boolean;
}

interface PendingDialog extends DialogRequest {
  resolve: (value: boolean) => void;
}

export const useDialogStore = defineStore('dialog', () => {
  const queue = ref<PendingDialog[]>([]);
  let seq = 0;

  /** The dialog currently shown (front of the queue), or null when idle. */
  const current = computed<DialogRequest | null>(() => queue.value[0] ?? null);

  function request(req: Omit<DialogRequest, 'id'>): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      queue.value.push({ ...req, id: ++seq, resolve });
    });
  }

  /** Resolve the front dialog with the user's choice and advance the queue. */
  function settle(id: number, value: boolean) {
    const idx = queue.value.findIndex((d) => d.id === id);
    if (idx === -1) return;
    const [done] = queue.value.splice(idx, 1);
    done?.resolve(value);
  }

  return { queue, current, request, settle };
});

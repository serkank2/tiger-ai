// Promise-based replacement for the browser's blocking confirm()/alert().
//
//   const dialog = useDialog();
//   if (await dialog.confirm('Delete this template? This cannot be undone.')) { … }
//   await dialog.alert('Saved.');
//
// Both return a Promise<boolean>. `confirm` resolves true on accept / false on
// cancel (or Esc / backdrop). `alert` always resolves true once dismissed. The
// styled, accessible modal is rendered by the single <ConfirmDialog> outlet in
// app.vue — callers never import a component.
import type { DialogKind } from '~/stores/dialog';
import { useDialogStore } from '~/stores/dialog';

export interface DialogOptions {
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
}

function normalize(input: string | DialogOptions): DialogOptions {
  return typeof input === 'string' ? { message: input } : input;
}

export function useDialog() {
  const store = useDialogStore();

  function open(kind: DialogKind, input: string | DialogOptions): Promise<boolean> {
    return store.request({ kind, ...normalize(input) });
  }

  return {
    /** Ask the user to confirm. Resolves true if accepted, false otherwise. */
    confirm: (input: string | DialogOptions) => open('confirm', input),
    /** Show a message with a single dismiss button. Resolves true once dismissed. */
    alert: (input: string | DialogOptions) => open('alert', input),
  };
}

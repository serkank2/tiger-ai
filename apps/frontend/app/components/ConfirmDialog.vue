<script setup lang="ts">
// Global outlet for useDialog()/useDialog().confirm()/.alert(). Mounted once in
// app.vue. Renders the current request from the dialog store inside the accessible
// BaseModal (focus trap, Esc-to-close, focus restore, aria-modal all inherited),
// then resolves the caller's promise on the chosen action.
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';

const dialog = useDialogStore();
const { t } = useT();

const req = computed(() => dialog.current);

function decide(value: boolean) {
  const id = req.value?.id;
  if (id != null) dialog.settle(id, value);
}

// Cancel maps to false for confirm; for an alert there is no "false" outcome, so a
// dismiss (Esc / backdrop / the single button) resolves true either way.
function onCancel() {
  decide(req.value?.kind === 'alert' ? true : false);
}
</script>

<template>
  <BaseModal
    v-if="req"
    :key="req.id"
    :title="req.title"
    :aria-label="req.title ? undefined : req.message"
    size="sm"
    @close="onCancel"
  >
    <p class="dialog-msg">{{ req.message }}</p>

    <template #footer>
      <BaseButton v-if="req.kind === 'confirm'" variant="ghost" @click="decide(false)">
        {{ req.cancelText ?? t('common.cancel') }}
      </BaseButton>
      <BaseButton :variant="req.danger ? 'danger' : 'primary'" @click="decide(true)">
        {{ req.confirmText ?? (req.kind === 'alert' ? t('common.ok') : t('common.confirm')) }}
      </BaseButton>
    </template>
  </BaseModal>
</template>

<style scoped>
.dialog-msg {
  margin: 0;
  line-height: var(--leading-normal, 1.5);
  color: var(--text);
  white-space: pre-line;
}
</style>

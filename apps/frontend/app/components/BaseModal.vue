<script setup lang="ts">
import UiBaseModal from './ui/BaseModal.vue';
import { useT } from '~/composables/useT';

withDefaults(
  defineProps<{
    open?: boolean;
    title?: string;
    dismissible?: boolean;
    panelClass?: string;
  }>(),
  { open: true, dismissible: false, panelClass: '' },
);

const emit = defineEmits<{ close: [] }>();
const { t } = useT();
</script>

<template>
  <UiBaseModal
    v-if="open"
    :close-on-backdrop="dismissible"
    :close-on-escape="dismissible"
    :panel-class="panelClass"
    teleport-disabled
    @close="emit('close')"
  >
    <template v-if="title || dismissible" #header>
      <b v-if="title">{{ title }}</b>
      <span v-else />
    </template>
    <template v-if="dismissible" #header-actions>
      <button type="button" class="close" :aria-label="t('common.close')" @click="emit('close')">x</button>
    </template>
    <slot />
  </UiBaseModal>
</template>

<style scoped>
.close {
  width: 28px;
  height: 28px;
  color: var(--text-dim);
  border: 1px solid var(--border-strong);
}
.close:hover {
  border-color: var(--accent);
  color: var(--accent);
}
</style>

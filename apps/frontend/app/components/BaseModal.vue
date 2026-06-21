<script setup lang="ts">
withDefaults(
  defineProps<{
    open?: boolean;
    title?: string;
    dismissible?: boolean;
    panelClass?: string;
  }>(),
  {
    open: true,
    dismissible: false,
    panelClass: '',
  },
);

const emit = defineEmits<{ close: [] }>();
</script>

<template>
  <Transition name="modal">
    <div v-if="open" class="modal-backdrop" @click.self="dismissible && emit('close')">
      <div class="modal-panel" :class="panelClass" role="dialog" aria-modal="true">
        <header v-if="title || dismissible" class="modal-head">
          <b v-if="title">{{ title }}</b>
          <span class="spacer" />
          <button v-if="dismissible" class="close" aria-label="Close" @click="emit('close')">x</button>
        </header>
        <slot />
      </div>
    </div>
  </Transition>
</template>

<style scoped>
.modal-backdrop {
  position: fixed;
  inset: 0;
  display: grid;
  place-items: center;
  background: rgba(0, 0, 0, 0.6);
  z-index: 40;
  padding: 18px;
}
.modal-panel {
  width: min(520px, 100%);
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
}
.modal-head {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
}
.spacer {
  flex: 1;
}
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

/* Backdrop fades; the panel scales in subtly. Transform/opacity only, so the global
   prefers-reduced-motion safety net neutralizes it. */
.modal-enter-active,
.modal-leave-active {
  transition: opacity var(--dur-base) var(--ease-standard);
}
.modal-enter-active .modal-panel,
.modal-leave-active .modal-panel {
  transition: transform var(--dur-base) var(--ease-out);
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .modal-panel,
.modal-leave-to .modal-panel {
  transform: scale(0.97) translateY(6px);
}
</style>

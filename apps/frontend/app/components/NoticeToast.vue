<script setup lang="ts">
const notices = useNoticesStore();
</script>

<template>
  <div class="toasts">
    <TransitionGroup name="toast">
      <div v-for="n in notices.items" :key="n.id" class="toast" :class="n.kind" @click="notices.dismiss(n.id)">
        <span class="ic">{{ n.kind === 'error' ? '⚠' : '✓' }}</span>
        <span class="msg">{{ n.text }}</span>
      </div>
    </TransitionGroup>
  </div>
</template>

<style scoped>
.toasts {
  position: fixed;
  bottom: 18px;
  right: 18px;
  z-index: 60;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-end;
}
.toast {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 10px 14px;
  max-width: 380px;
  background: var(--bg-elev-2);
  border: 1px solid var(--border-strong);
  border-left: 3px solid var(--accent);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
  font-size: 13px;
  cursor: pointer;
}
.toast.error {
  border-left-color: var(--red);
}
.toast.error .ic {
  color: var(--red);
}
.toast.info .ic {
  color: var(--green);
}
.toast-enter-active,
.toast-leave-active {
  transition: all 0.22s var(--ease, ease);
}
.toast-enter-from,
.toast-leave-to {
  opacity: 0;
  transform: translateX(12px);
}
</style>

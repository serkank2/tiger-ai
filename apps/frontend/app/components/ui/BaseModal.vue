<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useSlots } from 'vue';
// Accessible dialog primitive. Mount it with v-if (the parent owns open/close state);
// it handles everything an accessible modal must do so individual screens never have to:
//   • role="dialog" + aria-modal + aria-labelledby (or aria-label) wiring
//   • moves focus into the dialog on open (first focusable, else the dialog itself)
//   • traps Tab / Shift+Tab inside the dialog
//   • closes on Escape and on backdrop click (both opt-out via props)
//   • locks body scroll while open
//   • returns focus to the element that opened it on close
const props = withDefaults(
  defineProps<{
    /** Title text; renders the default header and is linked via aria-labelledby. */
    title?: string;
    /** Explicit id to use for aria-labelledby (when supplying a custom header slot). */
    labelledby?: string;
    /** Accessible name used when there is no visible title/header. */
    ariaLabel?: string;
    size?: 'sm' | 'md' | 'lg' | 'xl';
    closeOnBackdrop?: boolean;
    closeOnEscape?: boolean;
    panelClass?: string;
    teleportDisabled?: boolean;
  }>(),
  { size: 'md', closeOnBackdrop: true, closeOnEscape: true },
);

const emit = defineEmits<{ close: [] }>();
const slots = useSlots();

const titleId = useId();
const dialogRef = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;
let prevOverflow = '';
let backdropPointerClosed = false;

const labelledBy = computed(() => props.labelledby ?? (props.title && !slots.header ? titleId : undefined));

const FOCUSABLE =
  'a[href], area[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(): HTMLElement[] {
  const root = dialogRef.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) =>
      !el.hasAttribute('disabled') &&
      el.getAttribute('aria-hidden') !== 'true' &&
      (el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement),
  );
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === 'Escape') {
    if (props.closeOnEscape) {
      e.preventDefault();
      e.stopPropagation();
      emit('close');
    }
    return;
  }
  if (e.key !== 'Tab') return;

  const root = dialogRef.value;
  if (!root) return;
  const els = getFocusable();
  if (els.length === 0) {
    // Nothing focusable inside — keep focus on the dialog container.
    e.preventDefault();
    root.focus();
    return;
  }
  const first = els[0]!;
  const last = els[els.length - 1]!;
  const active = document.activeElement as HTMLElement | null;

  if (e.shiftKey) {
    if (active === first || !root.contains(active)) {
      e.preventDefault();
      last.focus();
    }
  } else if (active === last || !root.contains(active)) {
    e.preventDefault();
    first.focus();
  }
}

function onBackdrop(e: MouseEvent) {
  // mousedown (not click) so a text selection that ends on the backdrop doesn't close.
  if (props.closeOnBackdrop && e.target === e.currentTarget) {
    backdropPointerClosed = true;
    emit('close');
    window.setTimeout(() => {
      backdropPointerClosed = false;
    }, 0);
  }
}

function onBackdropClick(e: MouseEvent) {
  if (backdropPointerClosed) return;
  if (props.closeOnBackdrop && e.target === e.currentTarget) emit('close');
}

onMounted(async () => {
  opener = (document.activeElement as HTMLElement | null) ?? null;
  prevOverflow = document.body.style.overflow;
  document.body.style.overflow = 'hidden';
  await nextTick();
  const els = getFocusable();
  (els[0] ?? dialogRef.value)?.focus();
});

onBeforeUnmount(() => {
  document.body.style.overflow = prevOverflow;
  if (opener && document.contains(opener) && typeof opener.focus === 'function') {
    opener.focus();
  }
});
</script>

<template>
  <Teleport to="body" :disabled="teleportDisabled">
    <div class="backdrop modal-backdrop" @mousedown="onBackdrop" @click="onBackdropClick">
      <div
        ref="dialogRef"
        class="modal modal-panel"
        :class="[`size-${size}`, panelClass]"
        role="dialog"
        aria-modal="true"
        :aria-labelledby="labelledBy"
        :aria-label="!labelledBy ? ariaLabel : undefined"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <header v-if="title || $slots.header" class="head modal-head">
          <slot name="header">
            <h2 :id="titleId" class="title">{{ title }}</h2>
          </slot>
          <div v-if="$slots['header-actions']" class="head-actions">
            <slot name="header-actions" />
          </div>
        </header>

        <div class="body">
          <slot />
        </div>

        <footer v-if="$slots.footer" class="foot">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: grid;
  place-items: center;
  padding: var(--space-4, 16px);
  background: var(--overlay-backdrop);
  backdrop-filter: blur(2px);
  animation: fade var(--dur-fast) var(--ease-out, ease);
}
.modal {
  display: flex;
  flex-direction: column;
  max-height: calc(100vh - var(--space-8, 32px));
  width: min(500px, 92vw);
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius, 10px);
  box-shadow: var(--shadow-lg, var(--shadow));
  outline: none;
  animation: pop var(--dur-base) var(--ease-out, ease);
}
.size-sm {
  width: min(400px, 92vw);
}
.size-md {
  width: min(500px, 92vw);
}
.size-lg {
  width: min(720px, 94vw);
}
.size-xl {
  width: min(1180px, 96vw);
}
.head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-3, 12px);
  padding: var(--space-5, 20px) var(--space-6, 24px) var(--space-3, 12px);
}
.head-actions {
  display: flex;
  align-items: center;
  gap: var(--space-2, 8px);
  flex: none;
}
.title {
  margin: 0;
  font-size: var(--text-lg, 18px);
  font-weight: 600;
  line-height: var(--leading-snug, 1.3);
  color: var(--text);
}
.body {
  padding: var(--space-2, 8px) var(--space-6, 24px) var(--space-3, 12px);
  overflow-y: auto;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: var(--space-3, 12px);
  padding: var(--space-3, 12px) var(--space-6, 24px) var(--space-5, 20px);
}
@keyframes fade {
  from {
    opacity: 0;
  }
}
@keyframes pop {
  from {
    opacity: 0;
    transform: translateY(8px) scale(0.98);
  }
}
@media (prefers-reduced-motion: reduce) {
  .backdrop,
  .modal {
    animation: none;
  }
}
</style>

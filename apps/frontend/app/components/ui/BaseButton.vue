<script setup lang="ts">
import Spinner from './Spinner.vue';

// Single source of truth for buttons across the app: consistent variants, sizes,
// and a built-in loading/disabled state that genuinely prevents activation.
const props = withDefaults(
  defineProps<{
    variant?: 'primary' | 'secondary' | 'ghost' | 'danger';
    size?: 'sm' | 'md' | 'lg';
    type?: 'button' | 'submit' | 'reset';
    loading?: boolean;
    disabled?: boolean;
    /** Stretch to fill the container width. */
    block?: boolean;
    /** Square padding for a single-icon button — requires `ariaLabel`. */
    iconOnly?: boolean;
    /** Accessible name. Mandatory for icon-only buttons that have no text. */
    ariaLabel?: string;
  }>(),
  {
    variant: 'secondary',
    size: 'md',
    type: 'button',
    loading: false,
    disabled: false,
    block: false,
    iconOnly: false,
  },
);

const emit = defineEmits<{ click: [MouseEvent] }>();

const isDisabled = computed(() => props.disabled || props.loading);
const spinnerSize = computed(() => (props.size === 'lg' ? 18 : props.size === 'sm' ? 12 : 14));

function onClick(e: MouseEvent) {
  // Native `disabled` already blocks clicks; guard anyway so the event never leaks
  // if a caller forces activation programmatically.
  if (isDisabled.value) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  emit('click', e);
}
</script>

<template>
  <button
    :type="type"
    class="btn"
    :class="[`v-${variant}`, `s-${size}`, { block, 'icon-only': iconOnly, 'is-loading': loading }]"
    :disabled="isDisabled"
    :aria-disabled="isDisabled || undefined"
    :aria-busy="loading || undefined"
    :aria-label="ariaLabel"
    @click="onClick"
  >
    <Spinner v-if="loading" class="btn-spinner" :size="spinnerSize" label="" />
    <span v-if="!(loading && iconOnly)" class="btn-label">
      <slot />
    </span>
  </button>
</template>

<style scoped>
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2, 8px);
  border: 1px solid transparent;
  border-radius: var(--radius-sm, 6px);
  font-family: inherit;
  font-weight: 600;
  line-height: 1;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out, ease),
    border-color var(--dur-fast) var(--ease-out, ease),
    color var(--dur-fast) var(--ease-out, ease),
    filter var(--dur-fast) var(--ease-out, ease);
}
.btn.block {
  width: 100%;
}

/* Sizes */
.s-sm {
  padding: var(--space-1, 4px) var(--space-3, 12px);
  font-size: var(--text-xs, 12px);
}
.s-md {
  padding: var(--space-2, 8px) var(--space-4, 16px);
  font-size: var(--text-sm, 13px);
}
.s-lg {
  padding: var(--space-3, 12px) var(--space-5, 20px);
  font-size: var(--text-md, 14px);
}
.icon-only.s-sm {
  padding: var(--space-1, 4px);
  width: 28px;
  height: 28px;
}
.icon-only.s-md {
  padding: var(--space-2, 8px);
  width: 34px;
  height: 34px;
}
.icon-only.s-lg {
  padding: var(--space-3, 12px);
  width: 42px;
  height: 42px;
}

/* Variants — colors come exclusively from theme tokens. */
.v-primary {
  background: var(--accent);
  border-color: var(--accent);
  color: var(--bg);
}
.v-primary:not(:disabled):hover {
  background: var(--accent-strong);
  border-color: var(--accent-strong);
}
.v-secondary {
  background: var(--bg-elev-2);
  border-color: var(--border-strong);
  color: var(--text);
}
.v-secondary:not(:disabled):hover {
  border-color: var(--accent);
}
.v-ghost {
  background: transparent;
  border-color: transparent;
  color: var(--text-dim);
}
.v-ghost:not(:disabled):hover {
  background: var(--accent-soft);
  color: var(--text);
}
.v-danger {
  background: var(--red);
  border-color: var(--red);
  color: var(--text);
}
.v-danger:not(:disabled):hover {
  filter: brightness(1.08);
}

.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn.is-loading {
  cursor: progress;
}
.btn-label {
  display: inline-flex;
  align-items: center;
  gap: inherit;
}
</style>

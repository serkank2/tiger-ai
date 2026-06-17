<script setup lang="ts">
// Accessible wrapper over a native <select>. Accepts an `options` array for the common
// case, or a default slot of <option> elements for full control. Mirrors BaseInput's
// id/aria wiring so it drops into a BaseField the same way.
defineOptions({ inheritAttrs: false });

type Option = { value: string | number; label: string; disabled?: boolean };

const model = defineModel<string | number>();

const props = withDefaults(
  defineProps<{
    id?: string;
    invalid?: boolean;
    describedby?: string;
    options?: Option[];
  }>(),
  { invalid: false, options: () => [] },
);

const autoId = useId();
const selectId = computed(() => props.id ?? autoId);
</script>

<template>
  <select
    :id="selectId"
    v-model="model"
    class="select"
    :class="{ 'is-invalid': invalid }"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedby || undefined"
    v-bind="$attrs"
  >
    <slot>
      <option v-for="o in options" :key="o.value" :value="o.value" :disabled="o.disabled">
        {{ o.label }}
      </option>
    </slot>
  </select>
</template>

<style scoped>
.select {
  width: 100%;
  font-family: inherit;
  font-size: var(--text-sm, 13px);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm, 6px);
  padding: var(--space-2, 7px) var(--space-3, 10px);
  transition: border-color var(--dur-fast) var(--ease-out, ease);
}
.select:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.select.is-invalid {
  border-color: var(--red);
}
.select:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

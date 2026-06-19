<script setup lang="ts">
// Labelled checkbox row. Single source of truth for the hand-rolled
// "<input type=checkbox> + <span>label</span>" pattern scattered across panels.
// v-model binds the boolean checked state; the whole row is a <label> so the
// text is clickable and the native input keeps full keyboard/focus semantics.
const props = withDefaults(
  defineProps<{
    modelValue?: boolean;
    label?: string;
    disabled?: boolean;
  }>(),
  { modelValue: false, disabled: false },
);

const emit = defineEmits<{ 'update:modelValue': [boolean] }>();

function onChange(e: Event) {
  emit('update:modelValue', (e.target as HTMLInputElement).checked);
}
</script>

<template>
  <label class="checkbox" :class="{ disabled }">
    <input
      type="checkbox"
      class="box"
      :checked="modelValue"
      :disabled="disabled"
      @change="onChange"
    />
    <span v-if="label || $slots.default" class="label"><slot>{{ label }}</slot></span>
  </label>
</template>

<style scoped>
.checkbox {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2, 8px);
  cursor: pointer;
  color: var(--text);
  font-size: var(--text-sm, 13px);
  user-select: none;
}
.checkbox.disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.box {
  width: 16px;
  height: 16px;
  flex: none;
  margin: 0;
  accent-color: var(--accent);
  cursor: inherit;
}
.label {
  line-height: var(--leading-snug, 1.35);
}
</style>

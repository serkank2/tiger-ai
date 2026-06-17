<script setup lang="ts">
// Thin, accessible wrapper over a native <input>. Pairs with BaseField (which supplies
// `id`/`describedby`/`invalid`) but also works standalone — it falls back to a generated
// id. All other attributes (type, placeholder, spellcheck, autocomplete, …) fall through.
defineOptions({ inheritAttrs: false });

const model = defineModel<string | number>();

const props = withDefaults(
  defineProps<{
    id?: string;
    /** Marks the control invalid (sets aria-invalid). */
    invalid?: boolean;
    /** Space-separated ids of hint/error elements describing this control. */
    describedby?: string;
  }>(),
  { invalid: false },
);

const autoId = useId();
const inputId = computed(() => props.id ?? autoId);
</script>

<template>
  <input
    :id="inputId"
    v-model="model"
    class="input"
    :class="{ 'is-invalid': invalid }"
    :aria-invalid="invalid ? 'true' : undefined"
    :aria-describedby="describedby || undefined"
    v-bind="$attrs"
  />
</template>

<style scoped>
.input {
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
.input::placeholder {
  color: var(--text-faint);
}
.input:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.input.is-invalid {
  border-color: var(--red);
}
.input:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}
</style>

<script setup lang="ts">
// Form-row wrapper that owns label/hint/error markup and the id wiring that makes a
// control accessible. The control is provided through the default scoped slot, which
// receives the ids/flags to spread onto a BaseInput/BaseSelect (or any native field):
//
//   <BaseField label="Name" :error="err" v-slot="{ id, describedby, invalid }">
//     <BaseInput :id="id" v-model="name" :describedby="describedby" :invalid="invalid" />
//   </BaseField>
const props = withDefaults(
  defineProps<{
    label?: string;
    /** Helper text shown under the control and linked via aria-describedby. */
    hint?: string;
    /** Error message; presence sets aria-invalid and overrides the hint tone. */
    error?: string;
    required?: boolean;
    /** Override the generated control id (otherwise auto-generated). */
    id?: string;
  }>(),
  { required: false },
);

const autoId = useId();
const inputId = computed(() => props.id ?? autoId);
const hintId = computed(() => `${inputId.value}-hint`);
const errorId = computed(() => `${inputId.value}-error`);
const invalid = computed(() => !!props.error);
const describedby = computed(() => {
  const ids: string[] = [];
  if (props.hint) ids.push(hintId.value);
  if (props.error) ids.push(errorId.value);
  return ids.length ? ids.join(' ') : undefined;
});
</script>

<template>
  <div class="field" :class="{ 'is-invalid': invalid }">
    <label v-if="label" :for="inputId" class="label">
      {{ label }}<span v-if="required" class="req" aria-hidden="true">*</span>
    </label>

    <slot
      :id="inputId"
      :describedby="describedby"
      :invalid="invalid"
      :hint-id="hintId"
      :error-id="errorId"
    />

    <p v-if="hint" :id="hintId" class="hint">{{ hint }}</p>
    <p v-if="error" :id="errorId" class="error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.field {
  display: block;
  margin-bottom: var(--space-4, 16px);
}
.label {
  display: block;
  font-size: var(--text-xs, 12px);
  color: var(--text-dim);
  margin-bottom: var(--space-2, 8px);
}
.req {
  color: var(--red);
  margin-left: 2px;
}
.field :deep(input),
.field :deep(select),
.field :deep(textarea) {
  width: 100%;
}
.hint {
  margin: var(--space-2, 8px) 0 0;
  font-size: var(--text-xs, 12px);
  line-height: var(--leading-snug, 1.4);
  color: var(--text-faint);
}
.error {
  margin: var(--space-2, 8px) 0 0;
  font-size: var(--text-xs, 12px);
  line-height: var(--leading-snug, 1.4);
  color: var(--red);
}
</style>

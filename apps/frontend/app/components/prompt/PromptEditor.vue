<script setup lang="ts">
import { detectVariables, render } from '~/lib/promptTemplate';
import { strictestLimit } from '~/lib/shellLimits';
import { useT } from '~/composables/useT';
import BaseInput from '~/components/ui/BaseInput.vue';
import BaseSelect from '~/components/ui/BaseSelect.vue';

export interface PromptDraft {
  title: string;
  description: string;
  tagsText: string;
  target: string;
  run: boolean;
  body: string;
}

const props = defineProps<{
  draft: PromptDraft;
  values: Record<string, string>;
  targetShellKinds: (string | undefined)[];
}>();

// The parent owns `draft`/`values`. This editor never mutates them in place: each
// edit is announced and the parent writes it back (keeps a single source of truth).
const emit = defineEmits<{
  'update:draft': [draft: PromptDraft];
  'update:value': [name: string, value: string];
}>();

const { t } = useT();
const groups = useGroupsStore();

function patchDraft(changes: Partial<PromptDraft>): void {
  emit('update:draft', { ...props.draft, ...changes });
}
// Writable computed per field so the template keeps `v-model` ergonomics while the
// setter emits instead of assigning to the prop.
function draftField<K extends keyof PromptDraft>(key: K) {
  return computed<PromptDraft[K]>({
    get: () => props.draft[key],
    set: (value) => patchDraft({ [key]: value } as Partial<PromptDraft>),
  });
}
const title = draftField('title');
const description = draftField('description');
const tagsText = draftField('tagsText');
const target = draftField('target');
const body = draftField('body');

const detectedVars = computed(() => detectVariables(props.draft.body));
// No pre-seeding of props.values: each variable input emits on first keystroke, which
// creates the key in the parent; unfilled variables stay absent (→ treated unresolved).

const today = new Date().toISOString().slice(0, 10);
const renderedLen = computed(() => render(props.draft.body, { values: props.values, date: today }).length);
const limit = computed(() => strictestLimit(props.targetShellKinds));
const overLimit = computed(() => Number.isFinite(limit.value) && renderedLen.value > limit.value);
</script>

<template>
  <div class="editor">
    <div class="metarow">
      <BaseInput
        v-model="title"
        class="title"
        :placeholder="t('prompts.editor.placeholders.title')"
        spellcheck="false"
      />
      <BaseSelect v-model="target" class="target" :title="t('prompts.editor.targetTitle')">
        <option value="">{{ t('prompts.editor.targets.pickOnSend') }}</option>
        <option value="all">{{ t('prompts.editor.targets.all') }}</option>
        <option value="selected">{{ t('prompts.editor.targets.selected') }}</option>
        <option v-for="g in groups.groups" :key="g.id" :value="`group:${g.name}`">
          {{ t('prompts.editor.targets.group', { name: g.name }) }}
        </option>
      </BaseSelect>
    </div>
    <BaseInput
      v-model="description"
      class="desc"
      :placeholder="t('prompts.editor.placeholders.description')"
      spellcheck="false"
    />
    <BaseInput
      v-model="tagsText"
      class="tags"
      :placeholder="t('prompts.editor.placeholders.tags')"
      spellcheck="false"
    />

    <textarea v-model="body" class="body" spellcheck="false" :placeholder="t('prompts.editor.placeholders.body')" />

    <div v-if="detectedVars.length" class="vars">
      <div class="vars-head">{{ t('prompts.editor.variables') }}</div>
      <div v-for="v in detectedVars" :key="v" class="varrow">
        <label :for="`var-${v}`">{{ v }}</label>
        <BaseInput
          :id="`var-${v}`"
          :model-value="values[v]"
          spellcheck="false"
          :placeholder="t('prompts.editor.placeholders.variableValue', { name: v })"
          @update:model-value="(val) => emit('update:value', v, String(val ?? ''))"
        />
      </div>
    </div>

    <div class="footer-row">
      <div class="mode" :aria-label="t('prompts.editor.sendMode')">
        <button
          type="button"
          :class="{ on: !draft.run }"
          :aria-pressed="!draft.run"
          @click="patchDraft({ run: false })"
        >
          {{ t('prompts.editor.paste') }}
        </button>
        <button type="button" :class="{ on: draft.run }" :aria-pressed="draft.run" @click="patchDraft({ run: true })">
          {{ t('prompts.editor.run') }}
        </button>
      </div>
      <span class="count" :class="{ over: overLimit }">
        {{ t('prompts.editor.chars', { n: renderedLen }) }}
        <span v-if="overLimit"> · ⚠ {{ t('prompts.editor.mayBeCut', { limit }) }}</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.editor {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  gap: 8px;
}
.metarow {
  display: flex;
  gap: 8px;
}
.title {
  flex: 1;
  font-weight: 600;
}
.target {
  flex: none;
  max-width: 46%;
  font-size: 12px;
}
.desc,
.tags {
  width: 100%;
  font-size: 12px;
}
.tags {
  font-family: var(--font-mono);
}
.body {
  flex: 1;
  min-height: 160px;
  resize: none;
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.5;
}
.vars {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 8px 10px;
  max-height: 140px;
  overflow-y: auto;
}
.vars-head {
  font-size: 11px;
  text-transform: uppercase;
  letter-spacing: 0.6px;
  color: var(--text-faint);
  font-weight: 700;
  margin-bottom: 6px;
}
.varrow {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}
.varrow label {
  width: 30%;
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--accent);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.varrow :deep(input) {
  flex: 1;
  font-size: 12px;
}
.footer-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mode {
  display: inline-flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.mode button {
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text-dim);
  border-right: 1px solid var(--border);
}
.mode button:last-child {
  border-right: none;
}
.mode button.on {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.count {
  font-size: 12px;
  color: var(--text-faint);
}
.count.over {
  color: var(--amber);
}
</style>

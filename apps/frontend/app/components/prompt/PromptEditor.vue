<script setup lang="ts">
import { detectVariables, render } from '~/lib/promptTemplate';
import { strictestLimit } from '~/lib/shellLimits';

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

const groups = useGroupsStore();

const detectedVars = computed(() => detectVariables(props.draft.body));
// No pre-seeding of props.values: each variable input binds v-model="values[v]", which
// creates the key on first keystroke; unfilled variables stay absent (→ treated unresolved).

const today = new Date().toISOString().slice(0, 10);
const renderedLen = computed(() => render(props.draft.body, { values: props.values, date: today }).length);
const limit = computed(() => strictestLimit(props.targetShellKinds));
const overLimit = computed(() => Number.isFinite(limit.value) && renderedLen.value > limit.value);
</script>

<template>
  <div class="editor">
    <div class="metarow">
      <input v-model="draft.title" class="title" placeholder="Title" spellcheck="false" />
      <select v-model="draft.target" class="target" title="Default target (hint)">
        <option value="">target: pick on send</option>
        <option value="all">target: all</option>
        <option value="selected">target: selected</option>
        <option v-for="g in groups.groups" :key="g.id" :value="`group:${g.name}`">target: {{ g.name }}</option>
      </select>
    </div>
    <input v-model="draft.description" class="desc" placeholder="Description (optional)" spellcheck="false" />
    <input v-model="draft.tagsText" class="tags" placeholder="tags: comma, separated" spellcheck="false" />

    <textarea
      v-model="draft.body"
      class="body"
      spellcheck="false"
      placeholder="Prompt text. Use {{variable}} and built-ins {{terminal.name}}, {{terminal.cwd}}, {{date}}."
    />

    <div v-if="detectedVars.length" class="vars">
      <div class="vars-head">Variables</div>
      <div v-for="v in detectedVars" :key="v" class="varrow">
        <label :for="`var-${v}`">{{ v }}</label>
        <input :id="`var-${v}`" v-model="values[v]" spellcheck="false" :placeholder="`value for {{${v}}}`" />
      </div>
    </div>

    <div class="footer-row">
      <div class="mode" aria-label="Send mode">
        <button type="button" :class="{ on: !draft.run }" :aria-pressed="!draft.run" @click="draft.run = false">Paste</button>
        <button type="button" :class="{ on: draft.run }" :aria-pressed="draft.run" @click="draft.run = true">Run ⏎</button>
      </div>
      <span class="count" :class="{ over: overLimit }">
        {{ renderedLen }} chars<span v-if="overLimit"> · ⚠ may be cut (~{{ limit }})</span>
      </span>
    </div>
  </div>
</template>

<style scoped>
.editor { display: flex; flex-direction: column; min-height: 0; height: 100%; gap: 8px; }
.metarow { display: flex; gap: 8px; }
.title { flex: 1; font-weight: 600; }
.target { flex: none; max-width: 46%; font-size: 12px; }
.desc, .tags { width: 100%; font-size: 12px; }
.tags { font-family: var(--font-mono); }
.body { flex: 1; min-height: 160px; resize: none; font-family: var(--font-mono); font-size: 13px; line-height: 1.5; }
.vars { border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 8px 10px; max-height: 140px; overflow-y: auto; }
.vars-head { font-size: 11px; text-transform: uppercase; letter-spacing: 0.6px; color: var(--text-faint); font-weight: 700; margin-bottom: 6px; }
.varrow { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.varrow label { width: 30%; font-family: var(--font-mono); font-size: 12px; color: var(--accent); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.varrow input { flex: 1; font-size: 12px; }
.footer-row { display: flex; align-items: center; justify-content: space-between; }
.mode { display: inline-flex; border: 1px solid var(--border-strong); border-radius: var(--radius-sm); overflow: hidden; }
.mode button { padding: 5px 12px; font-size: 12px; color: var(--text-dim); border-right: 1px solid var(--border); }
.mode button:last-child { border-right: none; }
.mode button.on { background: var(--accent-soft); color: var(--accent); font-weight: 600; }
.count { font-size: 12px; color: var(--text-faint); }
.count.over { color: var(--amber); }
</style>

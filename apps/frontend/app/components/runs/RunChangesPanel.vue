<script setup lang="ts">
// The human review unit: what the run actually changed in the working tree.
// Same evidence the reviewer agent gets — file list + unified diff vs HEAD.
import { computed } from 'vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import { useT } from '~/composables/useT';
import type { RunChanges } from '~/types';

const props = defineProps<{ changes: RunChanges | null; loading: boolean }>();
const emit = defineEmits<{ refresh: [] }>();
const { t } = useT();

const STATUS_GLYPH: Record<string, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  unknown: '·',
};

/** Split the unified diff into lines with a render class (add/del/hunk/meta). */
const diffLines = computed(() => {
  const text = props.changes?.diff ?? '';
  if (!text.trim()) return [] as Array<{ text: string; kind: string }>;
  return text.split('\n').map((line) => ({
    text: line,
    kind:
      line.startsWith('+++') || line.startsWith('---')
        ? 'meta'
        : line.startsWith('@@')
          ? 'hunk'
          : line.startsWith('+')
            ? 'add'
            : line.startsWith('-')
              ? 'del'
              : line.startsWith('diff ')
                ? 'file'
                : 'ctx',
  }));
});
</script>

<template>
  <div class="card changes" data-testid="run-changes">
    <header class="head">
      <h2>{{ t('runs.changes.title') }}</h2>
      <span v-if="changes" class="stat">
        {{ changes.summary.files }} {{ t('runs.changes.files') }} ·
        <span class="ins">+{{ changes.summary.insertions }}</span>
        <span class="del">−{{ changes.summary.deletions }}</span>
      </span>
      <BaseButton
        size="sm"
        variant="ghost"
        :loading="loading"
        data-testid="run-changes-refresh"
        @click="emit('refresh')"
      >
        {{ t('common.refresh') }}
      </BaseButton>
    </header>

    <p v-if="changes && !changes.isGitRepo" class="note">{{ t('runs.changes.notGit') }}</p>
    <p v-else-if="changes && changes.files.length === 0" class="note">{{ t('runs.changes.none') }}</p>

    <template v-if="changes && changes.files.length">
      <ul class="files">
        <li v-for="file in changes.files" :key="file.path" :data-status="file.status">
          <code class="glyph">{{ STATUS_GLYPH[file.status] ?? '·' }}</code>
          <code class="path">{{ file.path }}</code>
          <code v-if="file.oldPath" class="old">← {{ file.oldPath }}</code>
        </li>
      </ul>
      <pre class="diff" tabindex="0"><span
        v-for="(line, index) in diffLines"
        :key="index"
        class="line"
        :data-kind="line.kind"
      >{{ line.text }}
</span></pre>
      <p v-if="changes.diffTruncated" class="note">{{ t('runs.changes.truncated') }}</p>
    </template>
  </div>
</template>

<style scoped>
.card {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  background: var(--bg-elev);
  padding: 14px;
}
.head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.head h2 {
  margin: 0;
  font-size: 15px;
  flex: 1;
}
.stat {
  color: var(--text-dim);
  font-size: 12px;
}
.ins {
  color: var(--ok, #4ade80);
}
.del {
  color: var(--danger, #f87171);
  margin-left: 4px;
}
.note {
  color: var(--text-dim);
  font-size: 12px;
  margin: 10px 0 0;
}
.files {
  list-style: none;
  margin: 10px 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 3px;
  max-height: 180px;
  overflow: auto;
  font-size: 12px;
}
.files li {
  display: flex;
  gap: 8px;
  align-items: baseline;
}
.glyph {
  width: 14px;
  color: var(--text-dim);
}
.files li[data-status='added'] .glyph {
  color: var(--ok, #4ade80);
}
.files li[data-status='deleted'] .glyph {
  color: var(--danger, #f87171);
}
.old {
  color: var(--text-dim);
}
.diff {
  margin: 8px 0 0;
  max-height: 50vh;
  overflow: auto;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 8px);
  padding: 8px;
  font-size: 12px;
  line-height: 1.45;
}
.line {
  display: block;
  white-space: pre-wrap;
  word-break: break-all;
}
.line[data-kind='add'] {
  color: var(--ok, #4ade80);
  background: color-mix(in srgb, var(--ok, #4ade80) 8%, transparent);
}
.line[data-kind='del'] {
  color: var(--danger, #f87171);
  background: color-mix(in srgb, var(--danger, #f87171) 8%, transparent);
}
.line[data-kind='hunk'] {
  color: var(--accent, #60a5fa);
}
.line[data-kind='meta'],
.line[data-kind='file'] {
  color: var(--text-dim);
  font-weight: 600;
}
</style>

<script setup lang="ts">
import { computed, onMounted } from 'vue';
import { useTeamStore } from '~/stores/team';
import type { TeamChangeStatus } from '~/types';
import BaseButton from '~/components/ui/BaseButton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const emit = defineEmits<{ close: [] }>();
const team = useTeamStore();

const changes = computed(() => team.changes);
const loading = computed(() => team.changesLoading);

const STATUS_LABEL: Record<TeamChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  unknown: '•',
};

/** Split the unified diff into classed lines so additions/deletions/hunks are colored. */
interface DiffLine {
  text: string;
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
}
const diffLines = computed<DiffLine[]>(() => {
  const diff = changes.value?.diff ?? '';
  if (!diff) return [];
  return diff.split('\n').map((text) => {
    if (text.startsWith('@@')) return { text, kind: 'hunk' };
    if (text.startsWith('+++') || text.startsWith('---') || text.startsWith('diff ') || text.startsWith('index ') || text.startsWith('new file') || text.startsWith('deleted file') || text.startsWith('rename ')) return { text, kind: 'meta' };
    if (text.startsWith('+')) return { text, kind: 'add' };
    if (text.startsWith('-')) return { text, kind: 'del' };
    return { text, kind: 'ctx' };
  });
});

function refresh(): void {
  void team.loadChanges();
}

onMounted(refresh);
</script>

<template>
  <div class="changes-overlay" role="dialog" aria-label="Team changes" @keydown.esc="emit('close')">
    <div class="changes-drawer">
      <header class="ch-head">
        <div class="ch-title">
          <strong>Changes</strong>
          <span v-if="changes?.branch" class="branch" :title="changes.head ?? ''">⎇ {{ changes.branch }}</span>
          <span v-if="changes" class="stat">
            <span class="files">{{ changes.summary.files }} files</span>
            <span class="ins">+{{ changes.summary.insertions }}</span>
            <span class="del">−{{ changes.summary.deletions }}</span>
          </span>
        </div>
        <div class="ch-actions">
          <BaseButton size="sm" variant="ghost" :loading="loading" @click="refresh">Refresh</BaseButton>
          <BaseButton size="sm" variant="ghost" icon-only aria-label="Close changes" @click="emit('close')">✕</BaseButton>
        </div>
      </header>

      <section v-if="loading && !changes" class="ch-state">
        <Spinner :size="20" /><span>Computing changes…</span>
      </section>

      <section v-else-if="changes && !changes.isGitRepo" class="ch-state empty">
        <p>{{ changes.note ?? 'The workspace is not a git repository.' }}</p>
      </section>

      <section v-else-if="changes && changes.files.length === 0" class="ch-state empty">
        <p>No changes yet — the team has not modified any tracked files.</p>
        <p v-if="changes.note" class="note">{{ changes.note }}</p>
      </section>

      <template v-else-if="changes">
        <p v-if="changes.note" class="note inline">{{ changes.note }}</p>
        <ul class="file-list">
          <li v-for="f in changes.files" :key="f.path" class="file" :title="f.oldPath ? `${f.oldPath} → ${f.path}` : f.path">
            <span class="badge" :class="`b-${f.status}`">{{ STATUS_LABEL[f.status] }}</span>
            <span class="fpath">{{ f.path }}</span>
          </li>
        </ul>

        <div v-if="diffLines.length" class="diff">
          <pre><code><span
            v-for="(line, i) in diffLines"
            :key="i"
            class="dl"
            :class="`d-${line.kind}`"
          >{{ line.text }}
</span></code></pre>
          <p v-if="changes.diffTruncated" class="truncated">Diff truncated — open the workspace to see the full diff.</p>
        </div>
        <p v-else-if="changes.files.length" class="note">
          (Only untracked files changed — there is no tracked diff to show.)
        </p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.changes-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}
.changes-drawer {
  width: min(820px, 92vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.25);
}
.ch-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
}
.ch-title { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
.branch { font-size: var(--text-xs); color: var(--text-dim); }
.stat { display: flex; gap: var(--space-2); font-size: var(--text-xs); font-variant-numeric: tabular-nums; }
.stat .ins { color: var(--green); }
.stat .del { color: var(--red); }
.ch-actions { display: flex; gap: var(--space-1); }
.ch-state {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-4);
  color: var(--text-dim);
}
.ch-state.empty { flex-direction: column; align-items: flex-start; }
.note { color: var(--text-dim); font-size: var(--text-xs); }
.note.inline { padding: var(--space-2) var(--space-3) 0; }
.file-list {
  list-style: none;
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  max-height: 28vh;
  overflow: auto;
}
.file { display: flex; align-items: center; gap: var(--space-2); padding: 2px 0; font-size: var(--text-sm); }
.fpath { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-sm);
  font-size: 11px;
  font-weight: 700;
  flex: none;
  border: 1px solid var(--border-strong);
}
.b-added, .b-untracked { color: var(--green); border-color: var(--green); }
.b-deleted { color: var(--red); border-color: var(--red); }
.b-modified, .b-renamed, .b-copied { color: var(--amber); border-color: var(--amber); }
.diff { flex: 1; min-height: 0; overflow: auto; }
.diff pre { margin: 0; padding: var(--space-2) var(--space-3); }
.diff code { font-family: var(--font-mono, monospace); font-size: 12px; line-height: 1.45; }
.dl { display: block; white-space: pre-wrap; word-break: break-word; }
.d-add { background: rgba(108, 197, 108, 0.14); color: var(--green); }
.d-del { background: rgba(220, 100, 100, 0.14); color: var(--red); }
.d-hunk { color: var(--accent); }
.d-meta { color: var(--text-dim); }
.truncated { padding: var(--space-2) var(--space-3); color: var(--amber); font-size: var(--text-xs); }
</style>

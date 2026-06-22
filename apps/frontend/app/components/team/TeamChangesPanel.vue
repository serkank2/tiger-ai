<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useApi } from '~/composables/useApi';
import { useNoticesStore } from '~/stores/notices';
import { useT } from '~/composables/useT';
import type { TeamChangeStatus } from '~/types';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseModal from '~/components/ui/BaseModal.vue';
import Spinner from '~/components/ui/Spinner.vue';

const emit = defineEmits<{ close: [] }>();
const team = useTeamStore();
const api = useApi();
const notices = useNoticesStore();
const { t } = useT();

const changes = computed(() => team.changes);
const loading = computed(() => team.changesLoading);
const readOnly = computed(() => team.readOnly);

const STATUS_LABEL: Record<TeamChangeStatus, string> = {
  added: 'A',
  modified: 'M',
  deleted: 'D',
  renamed: 'R',
  copied: 'C',
  untracked: '?',
  unknown: '•',
};

interface DiffLine {
  text: string;
  kind: 'add' | 'del' | 'hunk' | 'meta' | 'ctx';
  /** 1-based index of this line within its file's diff, used to anchor review comments. */
  n: number;
}
interface FileDiff {
  path: string;
  status: TeamChangeStatus;
  oldPath?: string;
  lines: DiffLine[];
}

function classify(text: string): DiffLine['kind'] {
  if (text.startsWith('@@')) return 'hunk';
  if (
    text.startsWith('+++') ||
    text.startsWith('---') ||
    text.startsWith('diff ') ||
    text.startsWith('index ') ||
    text.startsWith('new file') ||
    text.startsWith('deleted file') ||
    text.startsWith('rename ')
  )
    return 'meta';
  if (text.startsWith('+')) return 'add';
  if (text.startsWith('-')) return 'del';
  return 'ctx';
}

/**
 * Split the unified diff into per-file sections by `diff --git` headers, so each file
 * can be collapsed independently and review comments can anchor to file + line.
 */
const fileDiffs = computed<FileDiff[]>(() => {
  const diff = changes.value?.diff ?? '';
  const files = changes.value?.files ?? [];
  const statusByPath = new Map(files.map((f) => [f.path, f.status] as const));
  if (!diff) return [];
  const sections: FileDiff[] = [];
  let current: FileDiff | null = null;
  for (const raw of diff.split('\n')) {
    const header = /^diff --git a\/(.+?) b\/(.+)$/.exec(raw);
    if (header) {
      const path = header[2] ?? header[1] ?? '';
      current = { path, status: statusByPath.get(path) ?? 'unknown', lines: [] };
      sections.push(current);
    }
    if (!current) {
      current = { path: '(diff)', status: 'unknown', lines: [] };
      sections.push(current);
    }
    current.lines.push({ text: raw, kind: classify(raw), n: current.lines.length + 1 });
  }
  return sections;
});

const collapsed = reactive<Record<string, boolean>>({});
function toggle(path: string): void {
  collapsed[path] = !collapsed[path];
}

// --- Inline review comments (vibe-kanban loop) ----------------------------
interface ReviewComment {
  path: string;
  line: number;
  excerpt: string;
  body: string;
}
const comments = ref<ReviewComment[]>([]);
const draftKey = ref<string | null>(null); // `${path}#${line}` of the line being annotated
const draftBody = ref('');

function startComment(file: FileDiff, line: DiffLine): void {
  draftKey.value = `${file.path}#${line.n}`;
  draftBody.value = '';
}
function saveComment(file: FileDiff, line: DiffLine): void {
  const body = draftBody.value.trim();
  if (!body) {
    draftKey.value = null;
    return;
  }
  comments.value = [
    ...comments.value,
    { path: file.path, line: line.n, excerpt: line.text.slice(0, 200), body },
  ];
  draftKey.value = null;
  draftBody.value = '';
}
function removeComment(index: number): void {
  comments.value = comments.value.filter((_, i) => i !== index);
}

const sending = ref(false);
const canSend = computed(() => comments.value.length > 0 && !readOnly.value && !sending.value);

/** Bundle the inline comments into a single steering directive sent back to the run. */
async function sendReview(): Promise<void> {
  if (!canSend.value) return;
  const lines = comments.value.map(
    (c) => `- ${c.path}:${c.line}\n  > ${c.excerpt.trim()}\n  ${c.body}`,
  );
  const body = `Code review feedback (please address these comments):\n${lines.join('\n')}`;
  sending.value = true;
  try {
    await team.steer({ body });
    comments.value = [];
  } catch {
    /* store surfaces the error via notices */
  } finally {
    sending.value = false;
  }
}

function refresh(): void {
  void team.loadChanges();
}

// Hand-rolled side drawer (BaseModal's centered layout doesn't fit). Reproduce the
// accessible-dialog basics inline: focus-trap, initial focus, focus-restore on close.
// Nested commit/PR dialogs use BaseModal and Teleport out, so they own their own trap.
const drawerRef = ref<HTMLElement | null>(null);
let opener: HTMLElement | null = null;

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function focusables(): HTMLElement[] {
  const root = drawerRef.value;
  if (!root) return [];
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => el.offsetWidth > 0 || el.offsetHeight > 0 || el === document.activeElement,
  );
}

function onDrawerKeydown(e: KeyboardEvent): void {
  // A nested BaseModal (commit / PR) is open: let it handle keys via its own trap.
  if (commitOpen.value || prOpen.value) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    emit('close');
    return;
  }
  if (e.key !== 'Tab') return;
  const root = drawerRef.value;
  const els = focusables();
  if (!root || els.length === 0) {
    e.preventDefault();
    root?.focus();
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

onMounted(() => {
  refresh();
  opener = (document.activeElement as HTMLElement | null) ?? null;
  (focusables()[0] ?? drawerRef.value)?.focus();
});
onBeforeUnmount(() => {
  if (opener && document.contains(opener) && typeof opener.focus === 'function') opener.focus();
});

// --- Stage / commit / PR (backend git-write routes) -----------------------
// Read-only history views and non-git workspaces can't perform writes.
const writeRoutesAvailable = computed(
  () => !readOnly.value && !!changes.value?.isGitRepo,
);
const hasChanges = computed(() => (changes.value?.files.length ?? 0) > 0);

/** Pull the run id directly off the store; writes target the live active run. */
function runIdOrNull(): string | null {
  return team.activeRunId ?? null;
}

/** Map a backend error to its stable `code` (set by the HttpError envelope). */
function errCode(e: unknown): string | undefined {
  return (e as { data?: { error?: { code?: string } } })?.data?.error?.code;
}
function errMessage(e: unknown): string {
  const err = e as { data?: { error?: { message?: string } }; message?: string };
  return err?.data?.error?.message ?? err?.message ?? t('team.changes.requestFailed');
}

const staging = ref(false);
async function stageAll(): Promise<void> {
  const runId = runIdOrNull();
  if (!runId || staging.value) return;
  staging.value = true;
  try {
    team.changes = await api.stageTeamChanges(runId);
    notices.push(t('team.changes.stagedNotice'), 'info');
  } catch (e) {
    notices.push(t('team.changes.stageFailed', { message: errMessage(e) }), 'error');
  } finally {
    staging.value = false;
  }
}

// Commit modal -------------------------------------------------------------
const commitOpen = ref(false);
const commitMessage = ref('');
const commitError = ref('');
const committing = ref(false);
function openCommit(): void {
  commitMessage.value = '';
  commitError.value = '';
  commitOpen.value = true;
}
async function doCommit(): Promise<void> {
  const runId = runIdOrNull();
  if (!runId || committing.value) return;
  const message = commitMessage.value.trim();
  if (!message) {
    commitError.value = t('team.changes.commitRequired');
    return;
  }
  committing.value = true;
  commitError.value = '';
  try {
    const result = await api.commitTeamChanges(runId, message);
    team.changes = result.changes;
    if (result.committed) {
      notices.push(t('team.changes.committedNotice', { sha: result.sha?.slice(0, 7) ?? '', summary: result.summary }).trim(), 'info');
      commitOpen.value = false;
    } else {
      // "nothing to commit" is a non-error outcome: keep the modal open with the note.
      commitError.value = result.summary || t('team.changes.nothingToCommit');
    }
  } catch (e) {
    if (errCode(e) === 'validation_failed') commitError.value = errMessage(e);
    else notices.push(t('team.changes.commitFailed', { message: errMessage(e) }), 'error');
  } finally {
    committing.value = false;
  }
}

// Create-PR modal ----------------------------------------------------------
const prOpen = ref(false);
const prTitle = ref('');
const prBody = ref('');
const prBase = ref('');
const prError = ref('');
const prUrl = ref('');
const creatingPr = ref(false);
function openPr(): void {
  prTitle.value = '';
  prBody.value = '';
  prBase.value = '';
  prError.value = '';
  prUrl.value = '';
  prOpen.value = true;
}
async function doCreatePr(): Promise<void> {
  const runId = runIdOrNull();
  if (!runId || creatingPr.value) return;
  const title = prTitle.value.trim();
  if (!title) {
    prError.value = t('team.changes.prTitleRequired');
    return;
  }
  creatingPr.value = true;
  prError.value = '';
  try {
    const result = await api.createTeamPr(runId, {
      title,
      body: prBody.value.trim() || undefined,
      base: prBase.value.trim() || undefined,
    });
    prUrl.value = result.url;
    notices.push(t('team.changes.pullRequestCreatedNotice'), 'info');
  } catch (e) {
    // `conflict` (missing/unauth gh, detached HEAD) carries an actionable message
    // from the backend (install gh / gh auth login / checkout a branch) — show it inline.
    if (errCode(e) === 'conflict' || errCode(e) === 'validation_failed') prError.value = errMessage(e);
    else notices.push(t('team.changes.createPrFailed', { message: errMessage(e) }), 'error');
  } finally {
    creatingPr.value = false;
  }
}
function openPrUrl(): void {
  if (prUrl.value && typeof window !== 'undefined') window.open(prUrl.value, '_blank', 'noopener');
}
async function copyPrUrl(): Promise<void> {
  if (!prUrl.value) return;
  try {
    await navigator.clipboard?.writeText(prUrl.value);
    notices.push(t('team.changes.prUrlCopied'), 'info');
  } catch {
    notices.push(t('team.changes.copyFailed'), 'error');
  }
}
</script>

<template>
  <div class="changes-overlay" @mousedown.self="emit('close')">
    <div
      ref="drawerRef"
      class="changes-drawer"
      role="dialog"
      aria-modal="true"
      :aria-label="t('team.changes.reviewTitle')"
      tabindex="-1"
      @keydown="onDrawerKeydown"
    >
      <header class="ch-head">
        <div class="ch-title">
          <strong>{{ t('team.changes.title') }}</strong>
          <span v-if="changes?.branch" class="branch" :title="changes.head ?? ''">⎇ {{ changes.branch }}</span>
          <span v-if="changes" class="stat">
            <span class="files">{{ t('team.changes.files', { n: changes.summary.files }) }}</span>
            <span class="ins">+{{ changes.summary.insertions }}</span>
            <span class="del">−{{ changes.summary.deletions }}</span>
          </span>
        </div>
        <div class="ch-actions">
          <BaseButton size="sm" variant="ghost" :loading="loading" @click="refresh">{{ t('team.changes.refresh') }}</BaseButton>
          <BaseButton size="sm" variant="ghost" icon-only :aria-label="t('team.changes.close')" @click="emit('close')">✕</BaseButton>
        </div>
      </header>

      <!-- Stage / commit / PR — wired to the backend git-write routes. -->
      <div class="pr-bar">
        <BaseButton
          size="sm"
          variant="ghost"
          :loading="staging"
          :disabled="!writeRoutesAvailable || !hasChanges"
          :title="readOnly ? t('team.changes.liveRunOnly') : t('team.changes.stageAllTitle')"
          @click="stageAll"
        >{{ t('team.changes.stageAll') }}</BaseButton>
        <BaseButton
          size="sm"
          variant="ghost"
          :disabled="!writeRoutesAvailable || !hasChanges"
          :title="readOnly ? t('team.changes.liveRunOnly') : t('team.changes.commitTitle')"
          @click="openCommit"
        >{{ t('team.changes.commit') }}</BaseButton>
        <BaseButton
          size="sm"
          variant="ghost"
          :disabled="!writeRoutesAvailable"
          :title="readOnly ? t('team.changes.liveRunOnly') : t('team.changes.createPrTitle')"
          @click="openPr"
        >{{ t('team.changes.createPr') }}</BaseButton>
        <span v-if="!writeRoutesAvailable" class="pr-note">
          {{ readOnly ? t('team.changes.liveRunOnly') : t('team.changes.notGitRepo') }}
        </span>
      </div>

      <section v-if="loading && !changes" class="ch-state">
        <Spinner :size="20" /><span>{{ t('team.changes.computing') }}</span>
      </section>

      <section v-else-if="changes && !changes.isGitRepo" class="ch-state empty">
        <p>{{ changes.note ?? t('team.changes.notGitRepo') }}</p>
      </section>

      <section v-else-if="changes && changes.files.length === 0" class="ch-state empty">
        <p>{{ t('team.changes.noChanges') }}</p>
        <p v-if="changes.note" class="note">{{ changes.note }}</p>
      </section>

      <template v-else-if="changes">
        <p v-if="changes.note" class="note inline">{{ changes.note }}</p>

        <div class="review-scroll">
          <!-- Untracked-only / no-diff fallback keeps the simple file list. -->
          <ul v-if="!fileDiffs.length" class="file-list">
            <li v-for="f in changes.files" :key="f.path" class="file" :title="f.oldPath ? `${f.oldPath} → ${f.path}` : f.path">
              <span class="badge" :class="`b-${f.status}`">{{ STATUS_LABEL[f.status] }}</span>
              <span class="fpath">{{ f.path }}</span>
            </li>
          </ul>

          <section v-for="file in fileDiffs" :key="file.path" class="file-diff">
            <button
              type="button"
              class="file-head"
              :aria-expanded="!collapsed[file.path]"
              :aria-label="t('team.changes.diffToggleAria', { action: collapsed[file.path] ? t('team.changes.expand') : t('team.changes.collapse'), path: file.path })"
              @click="toggle(file.path)"
            >
              <span class="chev" aria-hidden="true">{{ collapsed[file.path] ? '▸' : '▾' }}</span>
              <span class="badge" :class="`b-${file.status}`">{{ STATUS_LABEL[file.status] }}</span>
              <span class="fpath">{{ file.path }}</span>
            </button>
            <div v-show="!collapsed[file.path]" class="diff">
              <template v-for="line in file.lines" :key="line.n">
                <div class="dl-row">
                  <button
                    v-if="!readOnly"
                    type="button"
                    class="add-comment"
                    :title="t('team.changes.commentOnLine')"
                    :aria-label="t('team.changes.commentOnLine')"
                    @click="startComment(file, line)"
                  >＋</button>
                  <span class="dl" :class="`d-${line.kind}`">{{ line.text }}</span>
                </div>
                <div v-if="draftKey === `${file.path}#${line.n}`" class="comment-draft">
                  <textarea
                    v-model="draftBody"
                    class="comment-input"
                    rows="2"
                    :placeholder="t('team.changes.commentPlaceholder')"
                    :aria-label="t('team.changes.reviewComment')"
                  />
                  <div class="comment-actions">
                    <BaseButton size="sm" variant="primary" @click="saveComment(file, line)">{{ t('team.changes.addComment') }}</BaseButton>
                    <BaseButton size="sm" variant="ghost" @click="draftKey = null">{{ t('common.cancel') }}</BaseButton>
                  </div>
                </div>
              </template>
            </div>
          </section>

          <p v-if="changes.diffTruncated" class="truncated">{{ t('team.changes.diffTruncated') }}</p>
        </div>

        <!-- Bundled review → steering directive (the review→follow-up loop). -->
        <footer v-if="comments.length || !readOnly" class="review-bar">
          <ul v-if="comments.length" class="review-comments">
            <li v-for="(c, i) in comments" :key="i" class="rc">
              <span class="rc-anchor">{{ c.path }}:{{ c.line }}</span>
              <span class="rc-body">{{ c.body }}</span>
              <button type="button" class="rc-rm" :aria-label="t('team.changes.removeComment')" @click="removeComment(i)">✕</button>
            </li>
          </ul>
          <div class="review-send">
            <span class="rc-count">{{ t('team.changes.commentCount', { n: comments.length }) }}</span>
            <BaseButton
              size="sm"
              variant="primary"
              :loading="sending"
              :disabled="!canSend"
              :title="readOnly ? t('team.changes.readOnlyReviewTitle') : t('team.changes.sendReviewTitle')"
              @click="sendReview"
            >{{ t('team.changes.sendReview') }}</BaseButton>
          </div>
        </footer>
      </template>
    </div>

    <!-- Commit message prompt (app modal pattern; no window.prompt). -->
    <BaseModal v-if="commitOpen" :title="t('team.changes.commitChanges')" size="sm" @close="commitOpen = false">
      <label class="modal-field">
        <span>{{ t('team.changes.commitMessage') }}</span>
        <textarea
          v-model="commitMessage"
          rows="3"
          :placeholder="t('team.changes.commitMessagePlaceholder')"
          :aria-label="t('team.changes.commitMessage')"
          @input="commitError = ''"
        />
      </label>
      <p v-if="commitError" class="modal-err" role="alert" aria-live="polite">{{ commitError }}</p>
      <template #footer>
        <BaseButton variant="ghost" @click="commitOpen = false">{{ t('common.cancel') }}</BaseButton>
        <BaseButton variant="primary" :loading="committing" :disabled="!commitMessage.trim()" @click="doCommit">{{ t('team.changes.commitAction') }}</BaseButton>
      </template>
    </BaseModal>

    <!-- Create-PR prompt. -->
    <BaseModal v-if="prOpen" :title="t('team.changes.createPullRequest')" size="sm" @close="prOpen = false">
      <template v-if="!prUrl">
        <label class="modal-field">
          <span>{{ t('team.changes.prTitle') }}</span>
          <input v-model="prTitle" :placeholder="t('team.changes.prTitlePlaceholder')" :aria-label="t('team.changes.prTitle')" @input="prError = ''" />
        </label>
        <label class="modal-field">
          <span>{{ t('team.changes.prBody') }} <i>({{ t('team.changes.optional') }})</i></span>
          <textarea v-model="prBody" rows="3" :placeholder="t('team.changes.prBodyPlaceholder')" :aria-label="t('team.changes.prBody')" />
        </label>
        <label class="modal-field">
          <span>{{ t('team.changes.baseBranch') }} <i>({{ t('team.changes.optional') }})</i></span>
          <input v-model="prBase" :placeholder="t('team.changes.baseBranchPlaceholder')" :aria-label="t('team.changes.baseBranch')" />
        </label>
        <p v-if="prError" class="modal-err" role="alert" aria-live="polite">{{ prError }}</p>
      </template>
      <template v-else>
        <p class="modal-ok">{{ t('team.changes.pullRequestCreated') }}</p>
        <a class="pr-url" :href="prUrl" target="_blank" rel="noopener">{{ prUrl }}</a>
      </template>
      <template #footer>
        <template v-if="!prUrl">
          <BaseButton variant="ghost" @click="prOpen = false">{{ t('common.cancel') }}</BaseButton>
          <BaseButton variant="primary" :loading="creatingPr" :disabled="!prTitle.trim()" @click="doCreatePr">{{ t('team.changes.createPr') }}</BaseButton>
        </template>
        <template v-else>
          <BaseButton variant="ghost" @click="copyPrUrl">{{ t('team.changes.copyUrl') }}</BaseButton>
          <BaseButton variant="ghost" @click="openPrUrl">{{ t('team.changes.open') }}</BaseButton>
          <BaseButton variant="primary" @click="prOpen = false">{{ t('team.changes.done') }}</BaseButton>
        </template>
      </template>
    </BaseModal>
  </div>
</template>

<style scoped>
.changes-overlay {
  position: fixed;
  inset: 0;
  background: var(--overlay-backdrop);
  display: flex;
  justify-content: flex-end;
  z-index: 60;
}
.changes-drawer {
  width: min(860px, 94vw);
  height: 100%;
  background: var(--bg);
  border-left: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  min-height: 0;
  box-shadow: var(--shadow-lg);
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
.pr-bar {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
  border-bottom: 1px solid var(--border);
  flex-wrap: wrap;
}
.pr-note { font-size: var(--text-xs); color: var(--text-faint); }
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
.review-scroll { flex: 1; min-height: 0; overflow: auto; }
.file-list {
  list-style: none;
  margin: 0;
  padding: var(--space-2) var(--space-3);
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
.b-unknown { color: var(--text-dim); }
.file-diff { border-bottom: 1px solid var(--border); }
.file-head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  padding: var(--space-2) var(--space-3);
  background: var(--bg-elev);
  border: none;
  cursor: pointer;
  color: var(--text);
  font-size: var(--text-sm);
  text-align: left;
}
.file-head:hover { background: var(--bg-elev-2); }
.chev { color: var(--text-faint); width: 12px; flex: none; }
.diff { padding: var(--space-1) 0; }
.dl-row { display: flex; align-items: flex-start; }
.add-comment {
  flex: none;
  width: 18px;
  border: none;
  background: transparent;
  color: var(--text-faint);
  cursor: pointer;
  opacity: 0;
  font-size: 12px;
  line-height: 1.45;
}
.dl-row:hover .add-comment { opacity: 1; }
.add-comment:hover { color: var(--accent); }
.dl {
  display: block;
  flex: 1;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: var(--font-mono, monospace);
  font-size: 12px;
  line-height: 1.45;
  padding-right: var(--space-3);
}
.d-add { background: var(--green-soft); color: var(--green); }
.d-del { background: var(--red-soft); color: var(--red); }
.d-hunk { color: var(--accent); }
.d-meta { color: var(--text-dim); }
.comment-draft { padding: var(--space-2) var(--space-3) var(--space-2) 22px; }
.comment-input {
  width: 100%;
  resize: vertical;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
}
.comment-actions { display: flex; gap: var(--space-2); margin-top: var(--space-1); }
.truncated { padding: var(--space-2) var(--space-3); color: var(--amber); font-size: var(--text-xs); }
.review-bar {
  border-top: 1px solid var(--border);
  background: var(--bg-elev);
  padding: var(--space-2) var(--space-3);
}
.review-comments { list-style: none; margin: 0 0 var(--space-2); padding: 0; max-height: 22vh; overflow: auto; }
.rc {
  display: flex;
  align-items: baseline;
  gap: var(--space-2);
  padding: 2px 0;
  font-size: var(--text-xs);
}
.rc-anchor { font-family: var(--font-mono, monospace); color: var(--accent); flex: none; }
.rc-body { color: var(--text-dim); flex: 1; }
.rc-rm { border: none; background: transparent; color: var(--text-faint); cursor: pointer; }
.review-send { display: flex; align-items: center; justify-content: space-between; gap: var(--space-2); }
.rc-count { font-size: var(--text-xs); color: var(--text-faint); }
.modal-field { display: block; margin-bottom: var(--space-3); }
.modal-field > span { display: block; font-size: var(--text-xs); color: var(--text-dim); margin-bottom: var(--space-1); }
.modal-field i { color: var(--text-faint); font-style: normal; }
.modal-field input,
.modal-field textarea {
  width: 100%;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  resize: vertical;
}
.modal-err { color: var(--red); font-size: var(--text-sm); margin: 0; }
.modal-ok { color: var(--text-dim); font-size: var(--text-sm); margin: 0 0 var(--space-2); }
.pr-url { font-family: var(--font-mono, monospace); font-size: var(--text-sm); color: var(--accent); word-break: break-all; }
</style>

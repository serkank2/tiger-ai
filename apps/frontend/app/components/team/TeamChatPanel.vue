<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { useTeamStore } from '~/stores/team';
import { useNoticesStore } from '~/stores/notices';
import { useT } from '~/composables/useT';
import { useTeamTranslation, type ChatLang } from '~/composables/useTeamTranslation';
import type { TeamMessage, TeamMessageKind, TigerAgentType } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';

const team = useTeamStore();
const notices = useNoticesStore();
const { t } = useT();

const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);

const messages = computed(() => team.messages);

// Display-only translation: the team's agents always work in English (enforced
// server-side); this only changes what the human reads. Failures fall back to the
// original body and surface a single subtle toast.
let toastedFailure = false;
const translation = useTeamTranslation(() => {
  if (toastedFailure) return;
  toastedFailure = true;
  notices.push(t('team.translateFailed'), 'error');
});
const { chatLang, translating, displayBody, hasTranslation, ensureTranslations, setChatLang } = translation;

const LANG_OPTIONS: { value: ChatLang; key: string }[] = [
  { value: 'original', key: 'team.langOriginal' },
  { value: 'tr', key: 'team.langTurkish' },
  { value: 'en', key: 'team.langEnglish' },
];

function pickLang(lang: ChatLang): void {
  toastedFailure = false;
  setChatLang(lang, messages.value.map((m) => ({ id: m.id, body: m.body })));
}

// Translate whatever is currently displayed whenever the set changes while a non-original
// language is active. ensureTranslations is cheap (skips cached/queued ids) and debounces.
watch(
  [() => messages.value, chatLang],
  () => {
    if (chatLang.value === 'original') return;
    ensureTranslations(messages.value.map((m) => ({ id: m.id, body: m.body })));
  },
  { immediate: true },
);

function bodyFor(m: TeamMessage): string {
  return displayBody({ id: m.id, body: m.body });
}

onBeforeUnmount(() => translation.dispose());

interface SenderInfo {
  label: string;
  tool: TigerAgentType | null;
  kind: 'role' | 'user' | 'system';
}

const roleById = computed(() => {
  const map = new Map<string, { name: string; tool: TigerAgentType }>();
  for (const role of team.state?.roles ?? []) map.set(role.id, { name: role.name, tool: role.tool });
  return map;
});

function senderInfo(from: string): SenderInfo {
  if (from === 'user') return { label: t('team.chat.you'), tool: null, kind: 'user' };
  if (from === 'system') return { label: t('team.chat.system'), tool: null, kind: 'system' };
  const role = roleById.value.get(from);
  return { label: role?.name ?? from, tool: role?.tool ?? null, kind: 'role' };
}

const KIND_KEY: Partial<Record<TeamMessageKind, string>> = {
  decision: 'team.chat.kinds.decision',
  task: 'team.chat.kinds.task',
  handoff: 'team.chat.kinds.handoff',
  verification: 'team.chat.kinds.verification',
  finding: 'team.chat.kinds.finding',
  steering: 'team.chat.kinds.steering',
  signoff: 'team.chat.kinds.signoff',
  blocker: 'team.chat.kinds.blocker',
  tool: 'team.chat.kinds.tool',
};

function time(iso: string): string {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function onScroll() {
  const el = scroller.value;
  if (!el) return;
  atBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
}

async function scrollToBottom() {
  await nextTick();
  const el = scroller.value;
  if (el) el.scrollTop = el.scrollHeight;
}

// Follow the conversation when the user is already at the bottom; otherwise leave
// their scroll position so reading history isn't interrupted by live messages.
watch(
  () => messages.value.length,
  () => {
    if (atBottom.value) void scrollToBottom();
  },
);
watch(
  () => team.activeRunId,
  () => {
    atBottom.value = true;
    void scrollToBottom();
  },
);

function loadOlder() {
  void team.loadMoreMessages();
}
</script>

<template>
  <div class="chat">
    <div class="chat-head">
      <div class="lang-toggle" role="group" :aria-label="t('team.chatLanguage')">
        <span class="lang-label">{{ t('team.chatLanguage') }}</span>
        <button
          v-for="opt in LANG_OPTIONS"
          :key="opt.value"
          type="button"
          class="lang-btn"
          :class="{ active: chatLang === opt.value }"
          :aria-pressed="chatLang === opt.value"
          @click="pickLang(opt.value)"
        >
          {{ t(opt.key) }}
        </button>
      </div>
      <Transition name="fade">
        <span v-if="translating" class="translating" role="status" aria-live="polite">
          <span class="tdot" aria-hidden="true" />{{ t('team.translating') }}
        </span>
      </Transition>
    </div>

    <div ref="scroller" class="stream" @scroll="onScroll">
      <div v-if="team.hasMoreMessages" class="load-more">
        <button type="button" :disabled="team.transcriptLoading" @click="loadOlder">
          {{ team.transcriptLoading ? t('team.chat.loadingEarlier') : t('team.chat.loadEarlier') }}
        </button>
      </div>

      <p v-if="!messages.length" class="empty">{{ t('team.chat.empty') }}</p>

      <TransitionGroup name="msg" tag="div" class="msg-list">
        <article
          v-for="m in messages"
          :key="m.id"
          class="msg"
          :class="[`from-${senderInfo(m.from).kind}`, `kind-${m.kind}`]"
        >
          <div class="avatar">
            <TeamAgentBadge v-if="senderInfo(m.from).tool" :tool="senderInfo(m.from).tool!" />
            <span v-else class="glyph">{{ senderInfo(m.from).kind === 'user' ? 'User' : 'System' }}</span>
          </div>
          <div class="bubble">
            <div class="head">
              <span class="author">{{ senderInfo(m.from).label }}</span>
              <span v-if="m.to && m.to !== 'all'" class="to">to {{ roleById.get(m.to)?.name ?? m.to }}</span>
              <span v-if="KIND_KEY[m.kind]" class="kind-tag" :class="`k-${m.kind}`">{{ t(KIND_KEY[m.kind]!) }}</span>
              <span
                v-if="chatLang !== 'original' && !hasTranslation(m.id)"
                class="pending-tag"
                :title="t('team.translating')"
              >...</span>
              <span class="time">{{ time(m.createdAt) }}</span>
            </div>
            <p class="text">{{ bodyFor(m) }}</p>
          </div>
        </article>
      </TransitionGroup>
    </div>
  </div>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
}
.chat-head {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border);
  flex: none;
}
.lang-toggle {
  display: flex;
  align-items: center;
  gap: var(--space-1-5);
  flex-wrap: wrap;
}
.lang-label {
  font-size: var(--text-xs);
  color: var(--text-faint);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.lang-btn {
  font-size: var(--text-xs);
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 3px 11px;
  background: var(--bg-elev);
}
.lang-btn:hover {
  border-color: var(--border-strong);
  color: var(--text);
}
.lang-btn.active {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--accent-soft);
}
.translating {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.tdot {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--accent);
  animation: tpulse 1.1s var(--ease-in-out) infinite;
}
@keyframes tpulse {
  0%, 100% { opacity: 0.35; }
  50% { opacity: 1; }
}
.stream {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  scroll-behavior: smooth;
}
.msg-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}
.load-more {
  display: flex;
  justify-content: center;
}
.load-more button {
  font-size: var(--text-xs);
  color: var(--text-dim);
  border: 1px solid var(--border);
  border-radius: var(--radius-pill);
  padding: 3px 12px;
  background: var(--bg-elev);
}
.empty {
  color: var(--text-faint);
  text-align: center;
  margin-top: var(--space-8);
}
.msg {
  display: flex;
  gap: var(--space-2);
  max-width: 80%;
}
.from-user {
  align-self: flex-end;
  flex-direction: row-reverse;
}
.avatar {
  width: 48px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-top: 2px;
}
.glyph {
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.bubble {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  min-width: 0;
}
.from-user .bubble {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}
.from-system .bubble {
  background: transparent;
  border-style: dashed;
}
.kind-blocker .bubble {
  border-color: var(--red);
  background: var(--red-soft);
}
.kind-signoff .bubble {
  border-color: var(--green);
  background: var(--green-soft);
}
.kind-decision .bubble, .kind-steering .bubble {
  border-color: var(--border-strong);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  flex-wrap: wrap;
}
.author {
  font-weight: 700;
  font-size: var(--text-sm);
}
.to {
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.time {
  margin-left: auto;
  font-size: var(--text-xs);
  color: var(--text-faint);
}
.pending-tag {
  font-size: var(--text-xs);
  color: var(--text-faint);
  letter-spacing: 0.08em;
}
.kind-tag {
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  border-radius: var(--radius-pill);
  padding: 0 6px;
  border: 1px solid var(--border-strong);
  color: var(--text-faint);
}
.k-blocker { color: var(--red); border-color: var(--red); }
.k-signoff { color: var(--green); border-color: var(--green); }
.k-decision { color: var(--blue); border-color: var(--blue); }
.k-steering { color: var(--accent); border-color: var(--accent); }
.k-finding, .k-verification { color: var(--amber); border-color: var(--amber); }
.text {
  margin: var(--space-1) 0 0;
  font-size: var(--text-sm);
  color: var(--text);
  line-height: var(--leading-normal);
  white-space: pre-wrap;
  word-break: break-word;
}

/* New messages fade + slide up on arrival. Kept cheap (transform/opacity only) and
   covered by the global prefers-reduced-motion safety net. */
.msg-enter-active {
  transition:
    opacity var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
}
.msg-enter-from {
  opacity: 0;
  transform: translateY(8px);
}
.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur-fast) var(--ease-standard);
}
.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}
</style>

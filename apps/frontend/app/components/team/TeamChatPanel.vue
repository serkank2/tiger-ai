<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue';
import { useTeamStore } from '~/stores/team';
import type { TeamMessage, TeamMessageKind, TigerAgentType } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';

const team = useTeamStore();

const scroller = ref<HTMLElement | null>(null);
const atBottom = ref(true);

const messages = computed(() => team.messages);

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
  if (from === 'user') return { label: 'You', tool: null, kind: 'user' };
  if (from === 'system') return { label: 'System', tool: null, kind: 'system' };
  const role = roleById.value.get(from);
  return { label: role?.name ?? from, tool: role?.tool ?? null, kind: 'role' };
}

const KIND_LABEL: Partial<Record<TeamMessageKind, string>> = {
  decision: 'decision',
  task: 'task',
  handoff: 'handoff',
  verification: 'verification',
  finding: 'finding',
  steering: 'steering',
  signoff: 'sign-off',
  blocker: 'blocker',
  tool: 'tool',
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
    <div ref="scroller" class="stream" @scroll="onScroll">
      <div v-if="team.hasMoreMessages" class="load-more">
        <button type="button" :disabled="team.transcriptLoading" @click="loadOlder">
          {{ team.transcriptLoading ? 'Loading…' : 'Load earlier messages' }}
        </button>
      </div>

      <p v-if="!messages.length" class="empty">No messages yet — the team is getting started.</p>

      <article
        v-for="m in messages"
        :key="m.id"
        class="msg"
        :class="[`from-${senderInfo(m.from).kind}`, `kind-${m.kind}`]"
      >
        <div class="avatar">
          <TeamAgentBadge v-if="senderInfo(m.from).tool" :tool="senderInfo(m.from).tool!" />
          <span v-else class="glyph">{{ senderInfo(m.from).kind === 'user' ? '🧑' : '⚙' }}</span>
        </div>
        <div class="bubble">
          <div class="head">
            <span class="author">{{ senderInfo(m.from).label }}</span>
            <span v-if="m.to && m.to !== 'all'" class="to">→ {{ roleById.get(m.to)?.name ?? m.to }}</span>
            <span v-if="KIND_LABEL[m.kind]" class="kind-tag" :class="`k-${m.kind}`">{{ KIND_LABEL[m.kind] }}</span>
            <span class="time">{{ time(m.createdAt) }}</span>
          </div>
          <p class="text">{{ m.body }}</p>
        </div>
      </article>
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
.stream {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4);
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
  width: 22px;
  height: 22px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  margin-top: 2px;
}
.glyph {
  font-size: 14px;
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
  font-size: 10px;
  color: var(--text-faint);
}
.kind-tag {
  font-size: 10px;
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
</style>

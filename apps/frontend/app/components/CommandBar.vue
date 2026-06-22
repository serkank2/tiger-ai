<script setup lang="ts">
import { strictestLimit } from '~/lib/shellLimits';
import type { BroadcastOutcome } from '~/composables/useSocket';
import { useT } from '~/composables/useT';
import BaseButton from '~/components/ui/BaseButton.vue';

const { t } = useT();

const emit = defineEmits<{
  create: [];
  manageGroups: [];
  openSettings: [];
  openComposer: [];
  openPrompts: [];
  openTiger: [];
  openTemplates: [];
}>();
const terminals = useTerminalsStore();
const groups = useGroupsStore();
const conn = useConnectionStore();
const socket = useSocket();
const notices = useNoticesStore();

const cmd = ref('');

const targetCount = computed(() => {
  // count only deliverable (unprotected) targets — protected terminals are skipped server-side
  if (terminals.commandMode === 'selected') return terminals.unprotectedIds(terminals.selectedIds).length;
  if (terminals.commandMode === 'group') {
    return terminals.commandGroupId
      ? terminals.items.filter((t) => t.groupId === terminals.commandGroupId && !t.protected).length
      : 0;
  }
  return terminals.items.filter((t) => !t.protected).length;
});

const canSend = computed(() => {
  if (conn.status !== 'connected') return false;
  if (terminals.commandMode === 'group' && !terminals.commandGroupId) return false;
  return targetCount.value > 0;
});

// Long-input guard: a shell truncates a single command line (cmd ~8191, PowerShell ~16K;
// bash/zsh/custom effectively unbounded). Warn (never block) past the strictest target limit.
const targetTerminals = computed(() => {
  // protected terminals never receive the command, so they don't affect the length warning
  if (terminals.commandMode === 'selected')
    return terminals.items.filter((t) => terminals.selectedIds.includes(t.id) && !t.protected);
  if (terminals.commandMode === 'group')
    return terminals.commandGroupId
      ? terminals.items.filter((t) => t.groupId === terminals.commandGroupId && !t.protected)
      : [];
  return terminals.items.filter((t) => !t.protected);
});
const inputLimit = computed(() => strictestLimit(targetTerminals.value.map((t) => t.shell?.kind)));
const lengthWarning = computed(() => {
  const len = cmd.value.length;
  if (Number.isFinite(inputLimit.value) && len > inputLimit.value) {
    return `${len} characters - the target shell may truncate the command near the ${inputLimit.value} character limit. For very long content, write it to a file and run it from there.`;
  }
  return null;
});

function broadcastFailureMessage(result: BroadcastOutcome): string | null {
  switch (result.kind) {
    case 'ok':
      return null;
    case 'not_sent':
      return result.reason === 'server_error'
        ? `Command not sent: ${result.message ?? 'the backend rejected the request.'}`
        : 'Command not sent: the socket is not connected.';
    case 'timeout':
      return 'Command status unknown: no broadcast confirmation was received within 5 seconds.';
    case 'disconnected':
      return 'Command status unknown: the socket disconnected before confirming delivery.';
  }
}

// Short, screen-reader-only confirmation of the last broadcast outcome. Toasts only
// fire on failure, so a successful send was previously silent to assistive tech.
const sendStatus = ref('');

async function send() {
  if (!canSend.value) return;
  const result = await socket.broadcast(terminals.buildTarget(), cmd.value);
  const failureMessage = broadcastFailureMessage(result);
  if (failureMessage) notices.push(failureMessage, 'error');
  // keep the input for retry if nothing actually ran (all targets failed, or not sent)
  if (result.kind === 'ok' && result.written > 0) {
    cmd.value = '';
    sendStatus.value = `Sent to ${result.written} terminal(s).`;
  } else if (failureMessage) {
    sendStatus.value = failureMessage;
  }
}

// Roving tabindex for the segmented (single-select) controls: the group is one Tab
// stop; Left/Right (and Home/End) move focus between options without leaving it.
function onSegKeydown(e: KeyboardEvent) {
  const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
  if (!keys.includes(e.key)) return;
  const group = e.currentTarget as HTMLElement;
  const buttons = Array.from(group.querySelectorAll<HTMLButtonElement>('button:not([disabled])'));
  if (buttons.length === 0) return;
  const idx = buttons.indexOf(document.activeElement as HTMLButtonElement);
  let next = idx;
  if (e.key === 'ArrowLeft') next = idx <= 0 ? buttons.length - 1 : idx - 1;
  else if (e.key === 'ArrowRight') next = idx >= buttons.length - 1 ? 0 : idx + 1;
  else if (e.key === 'Home') next = 0;
  else if (e.key === 'End') next = buttons.length - 1;
  e.preventDefault();
  buttons[next]?.focus();
}

// one-click control keys sent to the current target (raw byte, no trailing newline)
const QUICK_KEYS = [
  { label: '^C', char: '\x03', title: 'Ctrl+C (interrupt)' },
  { label: '^D', char: '\x04', title: 'Ctrl+D (EOF)' },
  { label: 'Esc', char: '\x1b', title: 'Escape' },
];
function sendKey(ch: string) {
  if (!canSend.value) return;
  void socket.broadcast(terminals.buildTarget(), ch, false);
}
</script>

<template>
  <header class="bar">
    <div class="target">
      <div class="seg" role="group" :aria-label="t('terminals.commandInput')" @keydown="onSegKeydown">
        <button
          :class="{ on: terminals.commandMode === 'selected' }"
          :aria-pressed="terminals.commandMode === 'selected'"
          :tabindex="terminals.commandMode === 'selected' ? 0 : -1"
          @click="terminals.commandMode = 'selected'"
        >
          {{ t('terminals.targetSelected') }}<span class="n">{{ terminals.selectedIds.length }}</span>
        </button>
        <button
          :class="{ on: terminals.commandMode === 'group' }"
          :aria-pressed="terminals.commandMode === 'group'"
          :tabindex="terminals.commandMode === 'group' ? 0 : -1"
          @click="terminals.commandMode = 'group'"
        >
          {{ t('terminals.targetGroup') }}
        </button>
        <button
          :class="{ on: terminals.commandMode === 'all' }"
          :aria-pressed="terminals.commandMode === 'all'"
          :tabindex="terminals.commandMode === 'all' ? 0 : -1"
          @click="terminals.commandMode = 'all'"
        >
          {{ t('terminals.targetAll') }}
        </button>
      </div>
      <select v-if="terminals.commandMode === 'group'" v-model="terminals.commandGroupId" class="gsel" :aria-label="t('terminals.targetGroup')">
        <option :value="null" disabled>{{ t('terminals.chooseGroup') }}</option>
        <option v-for="g in groups.groups" :key="g.id" :value="g.id">{{ g.name }}</option>
      </select>
      <BaseButton class="iconbtn" variant="ghost" icon-only :aria-label="t('terminals.manageGroups')" :title="t('terminals.manageGroups')" @click="emit('manageGroups')">🗂</BaseButton>
    </div>

    <form class="cmd" @submit.prevent="send">
      <label class="sr-only" for="broadcast-cmd">{{ t('terminals.commandInput') }}</label>
      <input
        id="broadcast-cmd"
        v-model="cmd"
        :placeholder="t('terminals.sendPlaceholder', { n: targetCount })"
        :aria-describedby="lengthWarning ? 'cmd-lenwarn' : undefined"
        spellcheck="false"
      />
      <BaseButton type="submit" class="send" variant="primary" :disabled="!canSend">{{ t('terminals.send') }}</BaseButton>
      <p v-if="lengthWarning" id="cmd-lenwarn" class="lenwarn" role="status" aria-live="polite">⚠ {{ lengthWarning }}</p>
    </form>

    <!-- Screen-reader-only broadcast outcome announcer (visual feedback is via toasts/input clear). -->
    <p class="sr-only" role="status" aria-live="polite">{{ sendStatus }}</p>

    <BaseButton class="iconbtn" variant="ghost" icon-only :aria-label="t('terminals.openComposer')" :title="t('terminals.openComposer')" @click="emit('openComposer')">⤢</BaseButton>

    <BaseButton class="tiger" :title="t('terminals.openPrompts')" @click="emit('openPrompts')">{{ t('nav.prompts') }}</BaseButton>

    <div class="keys">
      <button
        v-for="k in QUICK_KEYS"
        :key="k.label"
        type="button"
        class="key"
        :disabled="!canSend"
        :title="`Send ${k.title} to ${terminals.commandMode}`"
        @click="sendKey(k.char)"
      >
        {{ k.label }}
      </button>
    </div>

    <div class="seg layout" role="group" :aria-label="t('terminals.focusView')" @keydown="onSegKeydown">
      <button
        :class="{ on: terminals.layoutMode === 'focus' }"
        :aria-pressed="terminals.layoutMode === 'focus'"
        :tabindex="terminals.layoutMode === 'focus' ? 0 : -1"
        title="Single focused terminal"
        :aria-label="t('terminals.focusView')"
        @click="terminals.layoutMode = 'focus'"
      >▭</button>
      <button
        :class="{ on: terminals.layoutMode === 'grid' }"
        :aria-pressed="terminals.layoutMode === 'grid'"
        :tabindex="terminals.layoutMode === 'grid' ? 0 : -1"
        title="Tiled grid view"
        :aria-label="t('terminals.gridView')"
        @click="terminals.layoutMode = 'grid'"
      >▦</button>
    </div>

    <BaseButton class="tiger" :title="t('terminals.openTemplates')" @click="emit('openTemplates')">{{ t('nav.templates') }}</BaseButton>
    <BaseButton class="tiger" :title="t('terminals.openTiger')" @click="emit('openTiger')">Tiger</BaseButton>
    <BaseButton class="new" variant="secondary" @click="emit('create')">{{ t('terminals.newTerminal') }}</BaseButton>
  </header>
</template>

<style scoped>
.bar {
  height: var(--bar-h);
  flex: none;
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 0 16px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.target {
  display: flex;
  align-items: center;
  gap: 8px;
}
/* Icon-only controls keep their square footprint over BaseButton's ghost variant. */
.iconbtn.btn {
  width: 32px;
  height: 32px;
  border-color: var(--border-strong);
  flex: none;
}
.iconbtn.btn:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}

/* Dense toolbar: on narrow viewports let the controls wrap onto a second row
   instead of overflowing/clipping. The command input keeps priority width. */
@media (max-width: 880px) {
  .bar {
    height: auto;
    flex-wrap: wrap;
    gap: 8px 12px;
    padding: 8px 12px;
  }
  .cmd {
    flex-basis: 100%;
    order: 99;
  }
}
.seg {
  display: flex;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  overflow: hidden;
}
.seg button {
  padding: 6px 11px;
  font-size: 12px;
  color: var(--text-dim);
  border-radius: 0;
  border-right: 1px solid var(--border);
}
.seg button:last-child {
  border-right: none;
}
.seg button.on {
  background: var(--accent-soft);
  color: var(--accent);
}
.seg .n {
  margin-left: 5px;
  opacity: 0.8;
}
.cmd {
  flex: 1;
  display: flex;
  gap: 8px;
  position: relative;
}
.lenwarn {
  position: absolute;
  top: calc(100% + 5px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 6px 10px;
  font-size: 11px;
  line-height: 1.35;
  color: var(--amber);
  background: var(--bg-elev);
  border: 1px solid var(--amber);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow);
}
.cmd input {
  flex: 1;
  font-family: var(--font-mono);
}
/* .send uses BaseButton (primary) — accent fill + on-accent text handled by the token system. */
.keys {
  display: flex;
  gap: 4px;
}
.key {
  border: 1px solid var(--border-strong);
  padding: 7px 9px;
  font-size: 12px;
  font-family: var(--font-mono);
  color: var(--text-dim);
}
.key:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.key:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
/* .new uses BaseButton (secondary) — no extra styling needed. */

/* Tiger/Prompts/Templates shortcuts: BaseButton with the accent-outline identity. */
.tiger.btn {
  border-color: var(--accent);
  color: var(--accent);
  flex: none;
}
.tiger.btn:hover:not(:disabled) {
  background: var(--accent-soft);
}
</style>

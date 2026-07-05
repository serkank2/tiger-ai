<script setup lang="ts">
import type { TerminalDto } from '~/types';
import IconTrash from '~/components/IconTrash.vue';
import BaseButton from '~/components/ui/BaseButton.vue';

const { t } = useT();
const props = defineProps<{ terminal: TerminalDto; active: boolean; selected: boolean }>();
const emit = defineEmits<{
  select: [];
  toggle: [];
  start: [];
  stop: [];
  restart: [];
  edit: [];
  duplicate: [];
  remove: [];
}>();

const running = computed(() => props.terminal.status.state === 'running' || props.terminal.status.state === 'starting');

// two-step delete confirm (no native dialog)
const confirming = ref(false);
let resetTimer: ReturnType<typeof setTimeout> | null = null;
function onDelete() {
  if (confirming.value) {
    confirming.value = false;
    if (resetTimer) clearTimeout(resetTimer);
    emit('remove');
  } else {
    confirming.value = true;
    resetTimer = setTimeout(() => (confirming.value = false), 2500);
  }
}

onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer);
});
</script>

<template>
  <div
    class="item"
    :class="{ active }"
    tabindex="0"
    @click="emit('select')"
    @keydown.enter.self="emit('select')"
    @keydown.space.self.prevent="emit('select')"
  >
    <input
      class="chk"
      type="checkbox"
      :checked="selected"
      :disabled="terminal.protected"
      :title="terminal.protected ? t('terminals.listItem.protectedCheckbox') : ''"
      :aria-label="
        terminal.protected
          ? t('terminals.listItem.protectedAria', { name: terminal.name })
          : t('terminals.listItem.selectAria', { name: terminal.name })
      "
      @click.stop
      @change="emit('toggle')"
    />
    <StatusDot :state="terminal.status.state" />
    <div class="meta">
      <div class="name">
        <span v-if="terminal.protected" class="lock" :title="t('terminals.listItem.protectedLock')">🔒</span
        >{{ terminal.name }}
      </div>
      <div class="cwd" :title="terminal.cwd">{{ terminal.cwd }}</div>
      <div v-if="terminal.lastOutput" class="out">{{ terminal.lastOutput }}</div>
    </div>
    <div class="actions" @click.stop>
      <BaseButton
        v-if="!running"
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.startTerminal')"
        :title="t('terminals.actions.start')"
        @click="emit('start')"
        >▶</BaseButton
      >
      <BaseButton
        v-else
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.stopTerminal')"
        :title="t('terminals.actions.stop')"
        @click="emit('stop')"
        >■</BaseButton
      >
      <BaseButton
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.restartTerminal')"
        :title="t('terminals.actions.restart')"
        @click="emit('restart')"
        >⟳</BaseButton
      >
      <BaseButton
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.duplicateTerminal')"
        :title="t('terminals.actions.duplicate')"
        @click="emit('duplicate')"
        >⧉</BaseButton
      >
      <BaseButton
        class="ic"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="t('terminals.actions.editTerminal')"
        :title="t('terminals.actions.edit')"
        @click="emit('edit')"
        >✎</BaseButton
      >
      <BaseButton
        class="ic danger"
        :class="{ confirm: confirming }"
        size="sm"
        variant="ghost"
        icon-only
        :aria-label="confirming ? t('terminals.actions.confirmDeleteTerminal') : t('terminals.actions.deleteTerminal')"
        :title="confirming ? t('terminals.actions.clickAgainToDelete') : t('terminals.actions.delete')"
        @click="onDelete"
      >
        <template v-if="confirming">✓?</template>
        <IconTrash v-else />
      </BaseButton>
    </div>
  </div>
</template>

<style scoped>
.item {
  display: flex;
  align-items: flex-start;
  gap: 9px;
  padding: 9px 12px 9px 10px;
  border-left: 2px solid transparent;
  cursor: pointer;
  position: relative;
}
.item:hover {
  background: var(--bg-elev-2);
}
.item.active {
  background: var(--accent-soft);
  border-left-color: var(--accent);
}
.chk {
  margin-top: 3px;
  accent-color: var(--accent);
  flex: none;
}
.meta {
  min-width: 0;
  flex: 1;
}
.lock {
  font-size: 10px;
  margin-right: 4px;
  opacity: 0.85;
}
.name {
  font-weight: 600;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.cwd {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 1px;
}
.out {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-dim);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  margin-top: 3px;
  opacity: 0.8;
}
.actions {
  display: none;
  gap: 2px;
  flex: none;
}
.item:hover .actions,
.item.active .actions {
  display: flex;
}
/* Compact row controls. BaseButton (ghost) handles focus-visible/disabled/aria;
   we only tighten the icon-only square size and keep the destructive accents. */
.ic.btn {
  width: 26px;
  height: 26px;
  font-size: 12px;
}
.ic.danger:hover:not(:disabled) {
  color: var(--red);
}
.ic.confirm {
  color: var(--red);
  border-color: var(--red);
}
</style>

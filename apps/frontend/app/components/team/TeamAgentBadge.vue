<script setup lang="ts">
import { computed } from 'vue';
import type { TeamAgentType } from '~/types';

const props = defineProps<{ tool: TeamAgentType }>();

const GLYPH: Record<TeamAgentType, string> = { claude: '✳', codex: '◆', antigravity: '✦' };
const glyph = computed(() => GLYPH[props.tool] ?? '◆');
</script>

<template>
  <span class="agent-badge" :class="`t-${tool}`" :title="tool">{{ glyph }}</span>
</template>

<style scoped>
.agent-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  border-radius: var(--radius-sm);
  font-size: 10px;
  line-height: 1;
  flex: none;
}
.t-claude {
  color: var(--agent-claude-color);
  background: var(--agent-claude-bg);
}
.t-codex {
  color: var(--agent-codex-color);
  background: var(--agent-codex-bg);
}
.t-antigravity {
  color: var(--agent-antigravity-color);
  background: var(--agent-antigravity-bg);
}
</style>

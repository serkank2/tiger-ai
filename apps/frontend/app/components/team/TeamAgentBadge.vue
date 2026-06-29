<script setup lang="ts">
import { computed } from 'vue';
import type { TeamAgentType } from '~/types';

const props = defineProps<{ tool: TeamAgentType }>();

const LABEL: Record<TeamAgentType, string> = { claude: 'CL', codex: 'CX', antigravity: 'AG' };
const label = computed(() => LABEL[props.tool] ?? 'AI');
</script>

<template>
  <span class="agent-badge" :class="`t-${tool}`" :title="tool">{{ label }}</span>
</template>

<style scoped>
.agent-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 22px;
  border-radius: var(--radius-sm);
  font-size: var(--text-xs);
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

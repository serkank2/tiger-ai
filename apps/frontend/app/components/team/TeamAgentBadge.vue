<script setup lang="ts">
import { computed } from 'vue';
import type { TeamAgentType } from '~/types';

const props = defineProps<{ tool: TeamAgentType }>();

const glyph = computed(() => (props.tool === 'claude' ? '✳' : '◆'));
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
  color: #d97757;
  background: rgba(217, 119, 87, 0.16);
}
.t-codex {
  color: var(--text-dim);
  background: var(--bg-elev-2);
}
</style>

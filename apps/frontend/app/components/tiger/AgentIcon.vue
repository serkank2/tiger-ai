<script setup lang="ts">
import type { TigerAgentType } from '~/types';
defineProps<{ type: TigerAgentType; size?: number }>();
</script>

<template>
  <!-- Claude (Anthropic) — sparkle mark in the Anthropic clay color. -->
  <svg
    v-if="type === 'claude'"
    class="ai-icon claude"
    :width="size ?? 15"
    :height="size ?? 15"
    viewBox="0 0 24 24"
    role="img"
    aria-label="Claude"
  >
    <path fill="#D97757" d="M12 1.6c.62 5.2 3.6 8.18 8.8 8.8-5.2.62-8.18 3.6-8.8 8.8-.62-5.2-3.6-8.18-8.8-8.8 5.2-.62 8.18-3.6 8.8-8.8z" />
  </svg>

  <!-- Codex (OpenAI) — OpenAI logomark. -->
  <svg
    v-else-if="type === 'codex'"
    class="ai-icon codex"
    :width="size ?? 15"
    :height="size ?? 15"
    viewBox="0 0 24 24"
    role="img"
    aria-label="Codex (OpenAI)"
  >
    <path
      fill="currentColor"
      d="M21.55 10.004a5.416 5.416 0 0 0-.478-4.501c-1.217-2.09-3.662-3.166-6.05-2.66A5.59 5.59 0 0 0 10.831 1C8.39.995 6.224 2.546 5.473 4.838A5.553 5.553 0 0 0 1.76 7.496a5.487 5.487 0 0 0 .691 6.5 5.416 5.416 0 0 0 .477 4.502c1.217 2.09 3.662 3.165 6.05 2.66A5.586 5.586 0 0 0 13.168 23c2.443.006 4.61-1.546 5.361-3.84a5.553 5.553 0 0 0 3.715-2.66 5.488 5.488 0 0 0-.693-6.497zm-8.381 11.558a4.199 4.199 0 0 1-2.675-.954l.132-.074 4.44-2.53a.71.71 0 0 0 .364-.623v-6.176l1.877 1.069.036.05v5.115a4.16 4.16 0 0 1-4.174 4.123zM4.192 18.087a4.085 4.085 0 0 1-.498-2.776l.134.078 4.44 2.53c.225.13.504.13.73 0l5.42-3.088v2.138l-.027.057L9.9 19.685c-1.999 1.136-4.552.46-5.707-1.598zM3.023 8.687a4.153 4.153 0 0 1 2.169-1.81V12.15a.71.71 0 0 0 .363.622l5.42 3.088-1.876 1.07-.063.005-4.489-2.559c-1.995-1.14-2.679-3.658-1.524-5.628zm15.417 3.563l-5.42-3.088 1.876-1.069.063-.005 4.489 2.557c1.998 1.14 2.683 3.662 1.524 5.63a4.155 4.155 0 0 1-2.169 1.81V12.87a.71.71 0 0 0-.363-.62zm1.867-2.808-.134-.078-4.44-2.53a.712.712 0 0 0-.731 0L9.583 9.92V7.782l.027-.057 4.489-2.559c1.998-1.14 4.552-.46 5.707 1.6.547.94.747 2.04.568 3.114zM8.567 13.324l-1.877-1.069-.036-.05V7.09c.002-2.276 1.872-4.122 4.176-4.12.997 0 1.96.336 2.675.95l-.132.073-4.44 2.53a.71.71 0 0 0-.364.622l-.002 6.179zm1.019-2.195L12 9.736l2.414 1.392v2.785L12 15.305l-2.414-1.392z"
    />
  </svg>

  <!-- Antigravity (Google) — Gemini-style four-point spark in Google blue. -->
  <svg
    v-else
    class="ai-icon antigravity"
    :width="size ?? 15"
    :height="size ?? 15"
    viewBox="0 0 24 24"
    role="img"
    aria-label="Antigravity (Google)"
  >
    <path fill="#4285F4" d="M12 2c.7 4.9 2.4 6.6 7.3 7.3-4.9.7-6.6 2.4-7.3 7.3-.7-4.9-2.4-6.6-7.3-7.3C9.6 8.6 11.3 6.9 12 2z" />
  </svg>
</template>

<style scoped>
.ai-icon {
  display: block;
  flex: none;
}
.ai-icon.codex {
  color: var(--text);
}
</style>

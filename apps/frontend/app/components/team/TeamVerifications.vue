<script setup lang="ts">
import { computed } from 'vue';
import type { TeamSignoffSnapshot, TeamVerificationSnapshot } from '~/types';

const props = defineProps<{
  verifications: TeamVerificationSnapshot[];
  signOffs: TeamSignoffSnapshot[];
}>();

const verifications = computed(() => props.verifications);
const signOffs = computed(() => props.signOffs);
</script>

<template>
  <details v-if="verifications.length" class="vlist">
    <summary>Verifications · {{ verifications.length }}</summary>
    <ul>
      <li v-for="v in verifications" :key="v.id" class="v" :class="`vs-${v.status}`">
        <span class="vstatus">{{ v.status }}</span>
        <span v-if="v.command" class="vcmd" :title="v.command">{{ v.command }}</span>
        <span v-if="v.exitCode != null" class="vexit" :class="{ bad: v.exitCode !== 0 }">exit {{ v.exitCode }}</span>
        <span v-if="v.summary" class="vsum">{{ v.summary }}</span>
      </li>
    </ul>
  </details>

  <details v-if="signOffs.length" class="vlist">
    <summary>Sign-offs · {{ signOffs.length }}</summary>
    <ul>
      <li v-for="s in signOffs" :key="s.id" class="s" :class="{ stale: s.stale }">
        <span class="sname">{{ s.roleName }}</span>
        <span v-if="s.stale" class="sstale" :title="s.staleReason ?? 'Sign-off is stale'">stale</span>
        <span v-else class="sok">✓</span>
      </li>
    </ul>
  </details>
</template>

<style scoped>
.vlist {
  font-size: var(--text-sm);
  color: var(--text-dim);
}
summary {
  cursor: pointer;
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
ul { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
.v, .s { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-xs); }
.vstatus {
  font-weight: 700;
  text-transform: uppercase;
  font-size: 10px;
  flex: none;
}
.vs-passed .vstatus { color: var(--green); }
.vs-failed .vstatus { color: var(--red); }
.vs-running .vstatus { color: var(--accent); }
.vcmd { font-family: var(--font-mono, monospace); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.vexit { color: var(--text-faint); font-variant-numeric: tabular-nums; }
.vexit.bad { color: var(--red); }
.vsum { color: var(--text-faint); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sname { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.sok { color: var(--green); }
.sstale { color: var(--amber); font-size: 10px; }
.s.stale .sname { color: var(--text-faint); }
</style>

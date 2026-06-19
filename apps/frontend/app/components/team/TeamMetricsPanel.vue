<script setup lang="ts">
import { computed } from 'vue';
import type { TeamMetrics } from '~/types';

const props = defineProps<{ metrics: TeamMetrics | null }>();

const m = computed(() => props.metrics);

/** Compact ms → "1h 2m" / "3m 4s" / "5s" formatting. */
function fmtDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '0s';
  const s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  const min = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h) return `${h}h ${min}m`;
  if (min) return `${min}m ${sec}s`;
  return `${sec}s`;
}

const tokensLabel = computed(() => (m.value?.tokens == null ? 'n/a' : String(m.value.tokens)));
const costLabel = computed(() => (m.value?.cost == null ? 'n/a' : `$${m.value.cost.toFixed(2)}`));
const naTip = 'Token/cost totals need a usage-reporting runner — the CLIs run as interactive PTYs and do not self-report usage.';
</script>

<template>
  <details class="metrics" open>
    <summary>Metrics</summary>
    <div v-if="m" class="m-body">
      <div class="totals">
        <span class="kv"><span class="k">Duration</span><span class="v">{{ fmtDuration(m.durationMs) }}</span></span>
        <span class="kv"><span class="k">Turns</span><span class="v">{{ m.turnCount }}</span></span>
        <span class="kv" :title="naTip"><span class="k">Tokens</span><span class="v na">{{ tokensLabel }}</span></span>
        <span class="kv" :title="naTip"><span class="k">Cost</span><span class="v na">{{ costLabel }}</span></span>
      </div>
      <table v-if="m.perRole.length" class="per-role">
        <thead>
          <tr><th>Role</th><th>Provider</th><th class="num">Turns</th><th class="num">Duration</th></tr>
        </thead>
        <tbody>
          <tr v-for="r in m.perRole" :key="r.roleId">
            <td class="rn" :title="r.roleName">{{ r.roleName }}</td>
            <td class="prov">{{ r.provider ?? '—' }}</td>
            <td class="num">{{ r.turnCount }}</td>
            <td class="num">{{ fmtDuration(r.durationMs) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else class="empty">No metrics yet.</p>
  </details>
</template>

<style scoped>
.metrics {
  background: var(--bg-elev);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-2) var(--space-3);
  font-size: var(--text-sm);
}
summary {
  cursor: pointer;
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.m-body { margin-top: var(--space-2); }
.totals { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.kv { display: flex; flex-direction: column; }
.k { font-size: 10px; color: var(--text-faint); text-transform: uppercase; letter-spacing: 0.04em; }
.v { font-variant-numeric: tabular-nums; color: var(--text); }
.v.na { color: var(--text-faint); font-style: italic; }
.per-role { width: 100%; margin-top: var(--space-2); border-collapse: collapse; }
.per-role th, .per-role td {
  text-align: left;
  padding: 2px 4px;
  font-size: var(--text-xs);
  border-bottom: 1px solid var(--border);
}
.per-role th { color: var(--text-faint); font-weight: 600; }
.per-role .num { text-align: right; font-variant-numeric: tabular-nums; }
.rn { max-width: 14ch; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.prov { color: var(--text-dim); }
.empty { margin: var(--space-2) 0 0; font-size: var(--text-xs); color: var(--text-faint); }
</style>

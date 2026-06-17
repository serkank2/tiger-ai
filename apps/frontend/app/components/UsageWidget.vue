<script setup lang="ts">
import type { TigerUsage, TigerUsageEntry, TigerUsageProbe } from '~/types';
import { errText } from '~/lib/apiError';

const api = useApi();
const open = ref(false);
const loading = ref(false);
const error = ref('');
const usage = ref<TigerUsage | null>(null);
const showRaw = reactive<Record<string, boolean>>({ claude: false, codex: false });

const REFRESH_MS = 5 * 60 * 1000;
let timer: ReturnType<typeof setInterval> | null = null;

async function refresh() {
  if (loading.value) return;
  loading.value = true;
  error.value = '';
  try {
    usage.value = await api.getTigerUsage();
  } catch (e) {
    error.value = errText(e);
  } finally {
    loading.value = false;
  }
}

const probes = computed(() => [usage.value?.claude, usage.value?.codex].filter(Boolean) as TigerUsageProbe[]);
const noProvidersDetected = computed(
  () => !!usage.value && probes.value.length > 0 && probes.value.every((p) => !p.ok && !p.entries.length),
);

/** Portion consumed, regardless of whether the CLI reports "used" or "left". */
function usedPct(e: TigerUsageEntry): number {
  return Math.round(e.metric === 'used' ? e.percent : 100 - e.percent);
}
function sev(used: number): string {
  return used >= 90 ? 'red' : used >= 70 ? 'amber' : 'ok';
}

const maxUsed = computed<number | null>(() => {
  const all = probes.value.flatMap((p) => p.entries);
  if (!all.length) return null;
  return Math.max(...all.map(usedPct));
});
const fabSev = computed(() => (maxUsed.value == null ? '' : sev(maxUsed.value)));

function fmtTime(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleTimeString();
  } catch {
    return '';
  }
}
function cleanReset(r: string | null): string {
  if (!r) return '';
  return r.replace(/^resets?\s*/i, '').trim();
}

onMounted(() => {
  // Fetch immediately in the background so the panel is never empty when opened,
  // then keep it fresh every 5 minutes regardless of whether it is open.
  void refresh();
  timer = setInterval(() => void refresh(), REFRESH_MS);
});
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="usage-widget">
    <transition name="pop">
      <div v-if="open" class="panel">
        <div class="phead">
          <span class="pt">Usage &amp; Limits</span>
          <span v-if="loading" class="upd">updating…</span>
          <span class="spacer" />
          <button class="ic" :disabled="loading" title="Refresh now" @click="refresh">⟳</button>
          <button class="ic" title="Close" @click="open = false">✕</button>
        </div>

        <p v-if="error" class="err">{{ error }}</p>
        <div v-if="loading && !usage" class="loading">
          <span class="spin" /> Querying Claude &amp; Codex…
        </div>

        <EmptyState
          v-if="noProvidersDetected"
          title="No providers detected"
          description="Claude and Codex are unavailable or did not report usage data."
        />

        <template v-if="!noProvidersDetected">
          <div v-for="probe in probes" :key="probe.type" class="prov">
          <div class="prov-head">
            <span class="dot" :class="probe.type" />
            <b>{{ probe.type }}</b>
            <span class="spacer" />
            <span class="ts">{{ fmtTime(probe.checkedAt) }}</span>
          </div>

          <div v-if="probe.entries.length" class="bars">
            <div v-for="(e, i) in probe.entries" :key="i" class="bar-row">
              <div class="bar-top">
                <span class="blabel">{{ e.label }}</span>
                <span class="bval" :class="sev(usedPct(e))">{{ e.percent }}% {{ e.metric }}</span>
              </div>
              <div class="track">
                <div class="fill" :class="sev(usedPct(e))" :style="{ width: usedPct(e) + '%' }" />
              </div>
              <div v-if="e.reset" class="reset">resets {{ cleanReset(e.reset) }}</div>
            </div>
          </div>
          <p v-else-if="probe.error" class="perr">⚠ {{ probe.error }}</p>
          <p v-else-if="!loading" class="dim">No usage figures parsed — open the raw panel.</p>

          <button v-if="probe.raw" class="rawtoggle" @click="showRaw[probe.type] = !showRaw[probe.type]">
            {{ showRaw[probe.type] ? 'Hide' : 'Show' }} raw panel
          </button>
          <pre v-if="showRaw[probe.type] && probe.raw" class="raw">{{ probe.raw }}</pre>
          </div>
        </template>
      </div>
    </transition>

    <button class="fab" :class="[{ active: open }, fabSev ? 'sev-' + fabSev : '']" title="Usage & limits" @click="open = !open">
      <span class="gauge" :class="{ spinning: loading && !usage }">◔</span>
      <span class="lab">Limits</span>
      <span v-if="maxUsed != null" class="pct">{{ maxUsed }}%</span>
    </button>
  </div>
</template>

<style scoped>
.usage-widget {
  position: fixed;
  right: 18px;
  bottom: 18px;
  z-index: 55;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 10px;
}
.fab {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 44px;
  padding: 0 16px;
  border-radius: 999px;
  border: 1px solid var(--border-strong);
  background: var(--bg-elev);
  color: var(--text);
  box-shadow: var(--shadow);
  font-weight: 600;
}
.fab:hover,
.fab.active {
  border-color: var(--accent);
  color: var(--accent);
}
.fab.sev-amber {
  border-color: var(--amber);
}
.fab.sev-red {
  border-color: var(--red);
}
.gauge {
  font-size: 18px;
}
.gauge.spinning {
  animation: spin 1s linear infinite;
}
.lab {
  font-size: 13px;
}
.pct {
  font-size: 12px;
  font-weight: 700;
  font-family: var(--font-mono);
  padding: 1px 7px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
}
.fab.sev-amber .pct {
  background: rgba(224, 176, 58, 0.16);
  color: var(--amber);
}
.fab.sev-red .pct {
  background: rgba(229, 86, 75, 0.16);
  color: var(--red);
}
.panel {
  width: min(420px, 92vw);
  max-height: min(72vh, 640px);
  overflow-y: auto;
  background: var(--bg-elev);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: var(--shadow);
  padding: 14px 16px;
}
.phead {
  display: flex;
  align-items: center;
  gap: 8px;
}
.pt {
  font-weight: 700;
  font-size: 14px;
}
.upd {
  font-size: 11px;
  color: var(--text-faint);
}
.spacer {
  flex: 1;
}
.ic {
  width: 28px;
  height: 28px;
  border: 1px solid var(--border-strong);
  color: var(--text-dim);
}
.ic:hover:not(:disabled) {
  color: var(--accent);
  border-color: var(--accent);
}
.err {
  color: var(--red);
  font-size: 12px;
  margin: 8px 0;
}
.loading {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-dim);
  font-size: 13px;
  padding: 12px 0;
}
.spin,
.gauge.spinning {
  display: inline-block;
}
.spin {
  width: 13px;
  height: 13px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.prov {
  border-top: 1px solid var(--border);
  padding: 12px 0 4px;
  margin-top: 8px;
}
.prov-head {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  margin-bottom: 10px;
}
.prov-head b {
  text-transform: capitalize;
}
.dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
}
.dot.claude {
  background: var(--accent);
}
.dot.codex {
  background: var(--blue);
}
.ts {
  font-size: 11px;
  color: var(--text-faint);
}
.bars {
  display: flex;
  flex-direction: column;
  gap: 11px;
}
.bar-row {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.bar-top {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.blabel {
  font-size: 12px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.bval {
  margin-left: auto;
  font-size: 12px;
  font-weight: 700;
  font-family: var(--font-mono);
  white-space: nowrap;
}
.bval.ok {
  color: var(--accent);
}
.bval.amber {
  color: var(--amber);
}
.bval.red {
  color: var(--red);
}
.track {
  height: 7px;
  border-radius: 999px;
  background: var(--bg-term);
  border: 1px solid var(--border);
  overflow: hidden;
}
.fill {
  height: 100%;
  border-radius: 999px;
  transition: width 0.4s ease;
}
.fill.ok {
  background: var(--accent);
}
.fill.amber {
  background: var(--amber);
}
.fill.red {
  background: var(--red);
}
.reset {
  font-size: 10px;
  color: var(--text-faint);
}
.perr {
  font-size: 12px;
  color: var(--amber);
  margin: 4px 0;
}
.dim {
  font-size: 12px;
  color: var(--text-faint);
  margin: 4px 0;
}
.rawtoggle {
  margin-top: 10px;
  font-size: 11px;
  color: var(--text-dim);
  border: 1px solid var(--border);
  padding: 3px 9px;
}
.rawtoggle:hover {
  color: var(--accent);
  border-color: var(--accent);
}
.raw {
  margin: 8px 0 0;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  background: var(--bg-term);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-family: var(--font-mono);
  font-size: 10px;
  line-height: 1.5;
  color: var(--text-dim);
  white-space: pre-wrap;
  word-break: break-word;
}
.pop-enter-active,
.pop-leave-active {
  transition:
    opacity 0.12s ease,
    transform 0.12s ease;
}
.pop-enter-from,
.pop-leave-to {
  opacity: 0;
  transform: translateY(8px);
}
</style>

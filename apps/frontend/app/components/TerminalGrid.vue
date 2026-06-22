<script setup lang="ts">
import BaseButton from '~/components/ui/BaseButton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const emit = defineEmits<{ create: [] }>();
const terminals = useTerminalsStore();

// Tile every terminal (decoupled from command-target selection to avoid confusion).
const tiles = computed(() => terminals.items);
</script>

<template>
  <section class="grid-pane">
    <div v-if="tiles.length" class="grid-bar">
      <span class="hint">Tiling all {{ tiles.length }} terminal(s) · click a tile to focus it, ⛶ to expand to single view</span>
    </div>

    <div v-if="terminals.loading && !terminals.loaded" class="grid loading-grid">
      <div v-for="i in 4" :key="i" class="loading-tile">
        <Spinner v-if="i === 1" :size="14" label="Loading terminals" />
        <Skeleton :lines="5" />
      </div>
    </div>

    <div v-else-if="tiles.length" class="grid">
      <TerminalTile v-for="t in tiles" :key="t.id" :terminal="t" />
    </div>

    <EmptyState v-else title="No terminals yet." class="empty">
      <template #actions>
        <BaseButton variant="primary" @click="emit('create')">+ Create one</BaseButton>
      </template>
    </EmptyState>
  </section>
</template>

<style scoped>
.grid-pane {
  position: relative;
  isolation: isolate;
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background:
    radial-gradient(circle at 16% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 34%),
    radial-gradient(circle at 88% 14%, color-mix(in srgb, var(--blue) 10%, transparent), transparent 30%),
    var(--bg-term);
}
.grid-pane::before,
.grid-pane::after {
  content: '';
  position: absolute;
  inset: 0;
  pointer-events: none;
}
.grid-pane::before {
  z-index: 0;
  background-image:
    linear-gradient(color-mix(in srgb, var(--border) 34%, transparent) 1px, transparent 1px),
    linear-gradient(90deg, color-mix(in srgb, var(--border) 30%, transparent) 1px, transparent 1px);
  background-size: 32px 32px;
  opacity: 0.28;
}
.grid-pane::after {
  z-index: 0;
  background:
    linear-gradient(180deg, transparent, color-mix(in srgb, var(--bg) 70%, transparent)),
    radial-gradient(circle at 50% 100%, color-mix(in srgb, var(--green) 7%, transparent), transparent 42%);
  opacity: 0.72;
}
.grid-bar {
  position: relative;
  z-index: 1;
  min-height: 34px;
  display: flex;
  align-items: center;
  padding: 7px 14px 7px 30px;
  border-bottom: 1px solid var(--border);
  background:
    linear-gradient(90deg, color-mix(in srgb, var(--accent) 8%, transparent), transparent 46%),
    color-mix(in srgb, var(--bg-elev) 92%, var(--bg) 8%);
  box-shadow: inset 0 -1px 0 color-mix(in srgb, var(--text) 4%, transparent);
}
.grid-bar::before {
  content: '';
  position: absolute;
  left: 14px;
  top: 50%;
  width: 7px;
  height: 7px;
  border-radius: var(--radius-pill);
  background: var(--green);
  box-shadow: 0 0 0 4px color-mix(in srgb, var(--green) 14%, transparent);
  transform: translateY(-50%);
}
.hint {
  font-size: 12px;
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
}
.grid {
  position: relative;
  z-index: 1;
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 10px;
  /* responsive auto-tiling with a usable preferred tile width */
  grid-template-columns: repeat(auto-fit, minmax(min(100%, 340px), 1fr));
  grid-auto-rows: minmax(200px, 1fr);
  padding: 10px;
  overflow: auto;
}
.loading-grid {
  align-items: stretch;
}
.loading-tile {
  position: relative;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background:
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 7%, transparent), transparent 42%),
    var(--bg-elev);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, var(--text) 5%, transparent),
    0 8px 22px color-mix(in srgb, var(--bg) 34%, transparent);
}
.loading-tile::before {
  content: '';
  position: absolute;
  inset: 0 auto 0 0;
  width: 3px;
  background: var(--accent);
  opacity: 0.65;
}
.empty {
  position: relative;
  z-index: 1;
  flex: 1;
  display: grid;
  place-items: center;
  text-align: center;
  color: var(--text-faint);
}
</style>

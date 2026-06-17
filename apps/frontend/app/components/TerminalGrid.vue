<script setup lang="ts">
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
        <Spinner v-if="i === 1" small label="Loading terminals" />
        <Skeleton :lines="5" />
      </div>
    </div>

    <div v-else-if="tiles.length" class="grid">
      <TerminalTile v-for="t in tiles" :key="t.id" :terminal="t" />
    </div>

    <EmptyState v-else title="No terminals yet." class="empty">
      <button class="new" @click="emit('create')">+ Create one</button>
    </EmptyState>
  </section>
</template>

<style scoped>
.grid-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-term);
}
.grid-bar {
  padding: 7px 14px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-elev);
}
.hint {
  font-size: 12px;
  color: var(--text-faint);
}
.grid {
  flex: 1;
  min-height: 0;
  display: grid;
  gap: 8px;
  /* responsive auto-tiling with a usable minimum tile width */
  grid-template-columns: repeat(auto-fit, minmax(340px, 1fr));
  grid-auto-rows: minmax(200px, 1fr);
  padding: 8px;
  overflow: auto;
}
.loading-grid {
  align-items: stretch;
}
.loading-tile {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elev);
}
.empty {
  flex: 1;
  display: grid;
  place-items: center;
  text-align: center;
  color: var(--text-faint);
}
.new {
  margin-top: 12px;
  border: 1px solid var(--accent);
  color: var(--accent);
  padding: 7px 14px;
  font-weight: 600;
}
.new:hover {
  background: var(--accent-soft);
}
</style>

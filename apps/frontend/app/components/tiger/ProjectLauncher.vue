<script setup lang="ts">
const emit = defineEmits<{ new: [] }>();
const tiger = useTigerStore();

function pct(p: { completedStages: number; totalStages: number }): number {
  return p.totalStages ? Math.round((p.completedStages / p.totalStages) * 100) : 0;
}
function fmtDate(iso?: string) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return '';
  }
}

onMounted(() => {
  void tiger.loadProjects();
});
</script>

<template>
  <section class="launcher">
    <div class="lhead">
      <h2>Projects</h2>
      <span class="spacer" />
      <button class="ghost" title="Refresh" @click="tiger.loadProjects()">⟳</button>
    </div>
    <p class="lead">Continue a previous project, or create a new one.</p>

    <div class="grid">
      <button class="card new" @click="emit('new')">
        <span class="plus">＋</span>
        <span class="newlabel">New project</span>
        <span class="newhint">Pick a folder &amp; write a prompt</span>
      </button>

      <div v-for="p in tiger.projects" :key="p.path" class="card" :class="{ missing: !p.exists }">
        <div class="ctop">
          <span class="cname" :title="p.path">📁 {{ p.name }}</span>
          <button class="forget" title="Forget (does not delete files)" @click="tiger.forgetProject(p.path)">✕</button>
        </div>
        <p class="cprompt">{{ p.promptPreview || (p.exists ? '(no prompt yet)' : 'Folder is missing') }}</p>
        <div class="cprog">
          <div class="ptrack"><div class="pfill" :style="{ width: pct(p) + '%' }" /></div>
          <span class="pn">{{ p.completedStages }}/{{ p.totalStages }} stages</span>
        </div>
        <div class="cfoot">
          <span class="cdate">{{ fmtDate(p.updatedAt) }}</span>
          <span class="spacer" />
          <button class="open" :disabled="!p.exists" @click="tiger.openProject(p.path)">
            {{ p.completedStages > 0 ? 'Continue →' : 'Open →' }}
          </button>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.launcher {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px;
  max-width: 1100px;
  margin: 0 auto;
  width: 100%;
}
.lhead {
  display: flex;
  align-items: center;
  gap: 10px;
}
.lhead h2 {
  margin: 0;
}
.spacer {
  flex: 1;
}
.ghost {
  border: 1px solid var(--border-strong);
  width: 34px;
  height: 34px;
  color: var(--text-dim);
}
.ghost:hover {
  border-color: var(--accent);
  color: var(--accent);
}
.lead {
  color: var(--text-dim);
  margin: 6px 0 18px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 14px;
}
.card {
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: left;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
  padding: 14px;
  min-height: 150px;
}
.card.missing {
  opacity: 0.6;
}
.card.new {
  align-items: center;
  justify-content: center;
  border-style: dashed;
  border-color: var(--border-strong);
  color: var(--text-dim);
  gap: 6px;
}
.card.new:hover {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.plus {
  font-size: 28px;
  line-height: 1;
}
.newlabel {
  font-weight: 700;
  font-size: 14px;
}
.newhint {
  font-size: 11px;
  color: var(--text-faint);
}
.ctop {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cname {
  font-weight: 700;
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
}
.forget {
  width: 24px;
  height: 24px;
  color: var(--text-faint);
  border: 1px solid transparent;
  flex: none;
}
.forget:hover {
  color: var(--red);
  border-color: var(--red);
}
.cprompt {
  margin: 0;
  font-size: 12px;
  color: var(--text-dim);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
  flex: 1;
}
.cprog {
  display: flex;
  align-items: center;
  gap: 8px;
}
.ptrack {
  flex: 1;
  height: 6px;
  border-radius: 999px;
  background: var(--bg-term);
  border: 1px solid var(--border);
  overflow: hidden;
}
.pfill {
  height: 100%;
  background: var(--accent);
  border-radius: 999px;
  transition: width 0.4s ease;
}
.pn {
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  white-space: nowrap;
}
.cfoot {
  display: flex;
  align-items: center;
  gap: 8px;
}
.cdate {
  font-size: 10px;
  color: var(--text-faint);
}
.open {
  border: 1px solid var(--accent);
  color: var(--accent);
  font-weight: 700;
  padding: 6px 12px;
  font-size: 12px;
}
.open:hover:not(:disabled) {
  background: var(--accent-soft);
}
.open:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  border-color: var(--border-strong);
  color: var(--text-faint);
}
</style>

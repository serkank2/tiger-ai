<script setup lang="ts">
import type { PromptSummary } from '~/types';
import IconTrash from '~/components/IconTrash.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import EmptyState from '~/components/ui/EmptyState.vue';
import Skeleton from '~/components/ui/Skeleton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const props = defineProps<{
  items: PromptSummary[];
  currentPath: string | null;
  dirty: boolean;
  loading?: boolean;
  error?: string | null;
}>();
const emit = defineEmits<{
  open: [path: string];
  create: [];
  remove: [path: string];
  rename: [from: string, to: string];
  refresh: [];
}>();

const q = ref('');
const filtered = computed(() => {
  const s = q.value.trim().toLowerCase();
  if (!s) return props.items;
  return props.items.filter(
    (p) => p.path.toLowerCase().includes(s) || (p.title ?? '').toLowerCase().includes(s) || (p.tags ?? []).some((t) => t.toLowerCase().includes(s)),
  );
});

// two-step delete confirm
const confirmingPath = ref<string | null>(null);
let confirmTimer: ReturnType<typeof setTimeout> | null = null;
function onDelete(path: string) {
  if (confirmTimer) clearTimeout(confirmTimer);
  if (confirmingPath.value === path) {
    confirmingPath.value = null;
    emit('remove', path);
  } else {
    confirmingPath.value = path;
    confirmTimer = setTimeout(() => (confirmingPath.value = null), 2500);
  }
}

// inline rename
const renamingPath = ref<string | null>(null);
const renameValue = ref('');
function startRename(path: string) {
  renamingPath.value = path;
  renameValue.value = path;
}
function commitRename() {
  const from = renamingPath.value;
  const to = renameValue.value.trim();
  renamingPath.value = null;
  if (from && to && to !== from) emit('rename', from, to);
}
onBeforeUnmount(() => {
  if (confirmTimer) clearTimeout(confirmTimer);
});
</script>

<template>
  <div class="lib">
    <div class="top">
      <input v-model="q" class="search" placeholder="🔍 search prompts" spellcheck="false" />
    </div>
    <div class="actions">
      <BaseButton size="sm" variant="secondary" block @click="emit('create')">+ New</BaseButton>
      <BaseButton
        size="sm"
        variant="secondary"
        icon-only
        aria-label="Reload from disk"
        title="Reload from disk"
        :disabled="loading"
        @click="emit('refresh')"
      >
        ⟳
      </BaseButton>
    </div>
    <div class="list">
      <div v-if="loading && !items.length" class="loading-list">
        <Spinner :size="14" label="Loading prompts" />
        <Skeleton v-for="i in 4" :key="i" :lines="2" />
      </div>

      <EmptyState v-else-if="error" title="Prompt library unavailable" :description="error" tone="danger">
        <template #actions>
          <BaseButton size="sm" variant="secondary" @click="emit('refresh')">Retry</BaseButton>
        </template>
      </EmptyState>

      <template v-else>
        <div
          v-for="p in filtered"
          :key="p.path"
          class="item"
          :class="{ active: p.path === currentPath }"
          tabindex="0"
          @click="emit('open', p.path)"
          @keydown.enter="emit('open', p.path)"
          @keydown.space.prevent="emit('open', p.path)"
        >
          <template v-if="renamingPath === p.path">
            <input
              v-model="renameValue"
              class="renameinput"
              spellcheck="false"
              @click.stop
              @keydown.enter.stop="commitRename"
              @keydown.esc.stop.prevent="renamingPath = null"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <div class="meta">
              <div class="title">
                {{ p.title || p.path }}
                <span v-if="p.path === currentPath && dirty" class="dirty" title="Unsaved changes">●</span>
              </div>
              <div class="path">{{ p.path }}</div>
              <div v-if="p.tags?.length" class="tags">
                <span v-for="(t, i) in p.tags" :key="`${t}-${i}`" class="tag">{{ t }}</span>
              </div>
            </div>
            <div class="row-actions" @click.stop>
              <BaseButton
                size="sm"
                variant="ghost"
                icon-only
                class="ic"
                aria-label="Rename"
                title="Rename"
                @click="startRename(p.path)"
              >
                ✎
              </BaseButton>
              <BaseButton
                size="sm"
                variant="ghost"
                icon-only
                class="ic danger"
                :class="{ confirm: confirmingPath === p.path }"
                :aria-label="confirmingPath === p.path ? 'Click again to delete' : 'Delete'"
                :title="confirmingPath === p.path ? 'Click again to delete' : 'Delete'"
                @click="onDelete(p.path)"
              >
                <template v-if="confirmingPath === p.path">✓?</template>
                <IconTrash v-else />
              </BaseButton>
            </div>
          </template>
        </div>
        <div v-if="!filtered.length" class="empty">{{ items.length ? 'No matches.' : 'No prompts yet. Create one →' }}</div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.lib { display: flex; flex-direction: column; min-height: 0; height: 100%; }
.top { margin-bottom: 8px; }
.search { width: 100%; }
.actions { display: flex; gap: 6px; margin-bottom: 8px; }
.list { flex: 1; overflow-y: auto; border: 1px solid var(--border); border-radius: var(--radius-sm); }
.loading-list { display: flex; flex-direction: column; gap: 12px; padding: 14px; }
.item { display: flex; gap: 8px; padding: 8px 10px; border-bottom: 1px solid var(--border); cursor: pointer; }
.item:hover { background: var(--bg-elev-2); }
.item.active { background: var(--accent-soft); border-left: 2px solid var(--accent); }
.meta { flex: 1; min-width: 0; }
.title { font-weight: 600; font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.dirty { color: var(--amber); margin-left: 4px; }
.path { font-family: var(--font-mono); font-size: 11px; color: var(--text-faint); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.tag { font-size: 10px; background: var(--bg-elev-2); color: var(--text-dim); border-radius: 999px; padding: 1px 7px; }
.row-actions { display: none; gap: 2px; }
.item:hover .row-actions, .item.active .row-actions, .item:focus-within .row-actions { display: flex; }
.item:focus-visible { outline: 2px solid var(--accent); outline-offset: -2px; }
.ic { font-size: 12px; }
.ic.danger:hover, .ic.confirm { color: var(--red); }
.renameinput { width: 100%; font-family: var(--font-mono); font-size: 12px; }
.empty { padding: 18px; text-align: center; color: var(--text-faint); font-size: 13px; }
</style>

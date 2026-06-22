<script setup lang="ts">
import { errText } from '~/lib/apiError';
import { hexColorError } from '~/lib/formValidation';
import IconTrash from '~/components/IconTrash.vue';
import BaseModal from '~/components/ui/BaseModal.vue';
import BaseButton from '~/components/ui/BaseButton.vue';
import BaseField from '~/components/ui/BaseField.vue';
import BaseInput from '~/components/ui/BaseInput.vue';

const emit = defineEmits<{ close: [] }>();
const groups = useGroupsStore();
const terminals = useTerminalsStore();
const { t } = useT();

// A small set of predefined tag colors using available theme tokens.
const COLORS = [
  'var(--accent)',
  'var(--green)',
  'var(--blue)',
  'var(--agent-claude-color)',
  'var(--red)',
  'var(--amber)',
  'var(--agent-antigravity-color)',
  'var(--slate)',
];
const GROUP_NAME_MAX_CHARS = 80;

const newName = ref('');
const newColor = ref(COLORS[0]!);
const busy = ref(false);

type CreateField = 'name' | 'color';
const createServerErrors = reactive<Partial<Record<CreateField, string>>>({});
const renameErrors = reactive<Record<string, string>>({});

function clearCreateError(field: CreateField) {
  delete createServerErrors[field];
}
function chooseColor(color: string) {
  newColor.value = color;
  clearCreateError('color');
}
function clearCreateErrors() {
  for (const key of Object.keys(createServerErrors) as CreateField[]) delete createServerErrors[key];
}
function groupNameError(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return 'Group name is required.';
  if (trimmed.length > GROUP_NAME_MAX_CHARS) return `Group name must be ${GROUP_NAME_MAX_CHARS} characters or fewer.`;
  return null;
}
function applyCreateServerError(e: unknown) {
  const message = errText(e);
  const lower = message.toLowerCase();
  if (lower.includes('name')) createServerErrors.name = message;
  else if (lower.includes('color')) createServerErrors.color = message;
}
function clearRenameError(id: string) {
  delete renameErrors[id];
}

const newNameError = computed(() => createServerErrors.name ?? (newName.value.length ? groupNameError(newName.value) : null));
const newColorError = computed(() => createServerErrors.color ?? hexColorError(newColor.value, 'Group color'));
const hasCreateError = computed(() => Boolean(groupNameError(newName.value) || newColorError.value));

// two-step delete confirm (consistent with the terminal list)
const confirmingId = ref<string | null>(null);
let resetTimer: ReturnType<typeof setTimeout> | null = null;
function onDelete(id: string) {
  if (resetTimer) clearTimeout(resetTimer);
  if (confirmingId.value === id) {
    confirmingId.value = null;
    void remove(id);
  } else {
    confirmingId.value = id;
    resetTimer = setTimeout(() => (confirmingId.value = null), 2500);
  }
}
onBeforeUnmount(() => {
  if (resetTimer) clearTimeout(resetTimer);
});

async function create() {
  clearCreateErrors();
  const name = newName.value.trim();
  if (hasCreateError.value) return;
  busy.value = true;
  try {
    await groups.create({ name, color: newColor.value.trim() });
    newName.value = '';
    newColor.value = COLORS[0]!;
  } catch (e) {
    applyCreateServerError(e);
  } finally {
    busy.value = false;
  }
}

async function rename(id: string, name: string) {
  const trimmed = name.trim();
  const validationError = groupNameError(name);
  if (validationError) {
    renameErrors[id] = validationError;
    return;
  }
  try {
    await groups.update(id, { name: trimmed });
    clearRenameError(id);
  } catch (e) {
    const message = errText(e);
    if (message.toLowerCase().includes('name')) renameErrors[id] = message;
  }
}

async function remove(id: string) {
  try {
    await groups.remove(id);
    // Backend nulls the groupId of member terminals; resync the terminal list.
    await terminals.fetchAll();
    if (terminals.commandGroupId === id) {
      terminals.commandGroupId = null;
      if (terminals.commandMode === 'group') terminals.commandMode = 'selected';
    }
  } catch {
    /* notice shown by the groups/terminals stores */
  }
}
</script>

<template>
  <BaseModal title="Groups" size="md" @close="emit('close')">
      <form class="create" @submit.prevent="create">
        <BaseField id="group-new-name" v-slot="{ id, describedby, invalid }" class="create-name" label="New group name" :error="newNameError || undefined">
          <BaseInput
            :id="id"
            v-model="newName"
            :placeholder="t('terminals.newGroupName')"
            :invalid="invalid || undefined"
            :describedby="describedby"
            @input="clearCreateError('name')"
          />
        </BaseField>
        <BaseField id="group-new-color" v-slot="{ id, describedby, invalid }" class="create-color" label="Color" :error="newColorError || undefined">
          <div class="color-row">
            <div class="swatches">
              <button
                v-for="c in COLORS"
                :key="c"
                type="button"
                class="swatch"
                :class="{ on: newColor === c }"
                :style="{ background: c }"
                :title="c"
                @click="chooseColor(c)"
              />
            </div>
            <BaseInput
              :id="id"
              v-model="newColor"
              class="color-value"
              spellcheck="false"
              :invalid="invalid || undefined"
              :describedby="describedby"
              @input="clearCreateError('color')"
            />
          </div>
        </BaseField>
        <BaseButton type="submit" class="add-btn" variant="primary" :loading="busy" :disabled="hasCreateError">Add</BaseButton>
      </form>

      <ul class="list">
        <li v-for="g in groups.groups" :key="g.id">
          <div class="group-row">
          <span class="dot" :style="{ background: g.color || 'var(--text-faint)' }" />
          <BaseInput
            class="gname"
            :value="g.name"
            :invalid="!!renameErrors[g.id] || undefined"
            :describedby="renameErrors[g.id] ? `group-${g.id}-name-error` : undefined"
            @input="clearRenameError(g.id)"
            @change="rename(g.id, ($event.target as HTMLInputElement).value)"
          />
          <span class="n">{{ terminals.items.filter((t) => t.groupId === g.id).length }}</span>
          <button
            class="del"
            :class="{ confirm: confirmingId === g.id }"
            :title="confirmingId === g.id ? 'Click again to delete' : 'Delete group'"
            :aria-label="confirmingId === g.id ? `Confirm delete group ${g.name}` : `Delete group ${g.name}`"
            @click="onDelete(g.id)"
          >
            <template v-if="confirmingId === g.id">✓?</template>
            <IconTrash v-else />
          </button>
          </div>
          <p v-if="renameErrors[g.id]" :id="`group-${g.id}-name-error`" class="row-error" role="alert">
            {{ renameErrors[g.id] }}
          </p>
        </li>
        <li v-if="!groups.groups.length" class="empty">No groups yet.</li>
      </ul>

      <template #footer>
        <BaseButton variant="ghost" @click="emit('close')">Done</BaseButton>
      </template>
  </BaseModal>
</template>

<style scoped>
.create {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(190px, auto) auto;
  align-items: start;
  gap: 8px;
  margin-bottom: 14px;
}
.create-name {
  min-width: 0;
  margin-bottom: 0;
}
.create-color {
  min-width: 190px;
  margin-bottom: 0;
}
.color-row {
  display: flex;
  align-items: center;
  gap: 8px;
}
.color-row .color-value {
  width: 86px;
  flex: none;
  font-family: var(--font-mono);
  font-size: 12px;
}
.swatches {
  display: flex;
  gap: 4px;
}
.swatch {
  width: 18px;
  height: 18px;
  border-radius: 4px;
  border: 2px solid transparent;
}
.swatch.on {
  border-color: var(--text);
}
.add-btn {
  align-self: end;
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.list li {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.group-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
}
.dot {
  width: 10px;
  height: 10px;
  border-radius: 3px;
  flex: none;
}
.gname {
  flex: 1;
}
.gname[aria-invalid='true'] {
  border-color: var(--red);
}
.row-error {
  align-self: stretch;
  color: var(--red);
  font-size: 12px;
  line-height: 1.35;
  margin: 0 0 0 19px;
}
.n {
  font-size: 11px;
  color: var(--text-faint);
  min-width: 18px;
  text-align: center;
}
.del {
  width: 28px;
  height: 28px;
  color: var(--text-dim);
}
.del:hover,
.del.confirm {
  color: var(--red);
}
.empty {
  color: var(--text-faint);
  align-items: center;
}
</style>

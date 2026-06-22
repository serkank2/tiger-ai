<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { displayRoleName, isLeadRole, nextRoleName, uniqueRoleId } from '~/lib/teamRoles';
import { useTeamStore } from '~/stores/team';
import { useT } from '~/composables/useT';
import { useTigerStore } from '~/stores/tiger';
import type { TeamAgentType, TeamTemplate } from '~/types';
import BaseModal from '../ui/BaseModal.vue';
import BaseButton from '../ui/BaseButton.vue';
import TeamAgentBadge from './TeamAgentBadge.vue';

const props = defineProps<{ template: TeamTemplate | null }>();
const emit = defineEmits<{ saved: [TeamTemplate]; close: [] }>();

const team = useTeamStore();
const tiger = useTigerStore();
const { t } = useT();

// Efforts the CLIs accept, per tool ('' = use the CLI default). Antigravity has no effort flag.
const EFFORTS_BY_TOOL: Record<TeamAgentType, string[]> = {
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'low', 'medium', 'high', 'xhigh'],
  antigravity: [''],
};
// Default autonomous, write-capable permission per tool. Every team role needs to write
// its own turn deliverable and must not stall on an approval prompt, so this is the safe
// default; whether a role edits project source is governed by its persona, not the sandbox.
const AUTONOMOUS_PERM: Record<TeamAgentType, string> = {
  claude: 'acceptEdits',
  codex: 'workspace-write',
  antigravity: 'dangerous',
};

interface EditableRole {
  id: string;
  name: string;
  persona: string;
  responsibilities: string;
  tool: TeamAgentType;
  model: string;
  effort: string;
  permission: string;
  canWriteCode: boolean;
  requiredForSignoff: boolean;
}

const isEdit = computed(() => !!props.template && !props.template.builtin);
const title = computed(() => (props.template ? (props.template.builtin ? t('team.templateEditor.newFromBuiltin') : t('team.templateEditor.editTitle')) : t('team.templateEditor.newTitle')));

const name = ref('');
const description = ref('');
const roles = reactive<EditableRole[]>([]);
const error = ref('');
const leadCount = computed(() => roles.filter((role) => isLeadRole(role)).length);

const config = computed(() => tiger.config);
// Each option list always includes the role's current value as a fallback, so a select
// never renders blank while the Tiger config is still loading (or for an unusual value).
function withCurrent(list: string[], current: string | undefined): string[] {
  const out = [...list];
  if (current && !out.includes(current)) out.push(current);
  return out;
}
function models(tool: TeamAgentType, current?: string): string[] {
  return withCurrent(['', ...(config.value?.cli[tool].models ?? [])], current);
}
function permissions(tool: TeamAgentType, current?: string): string[] {
  const keys = Object.keys(config.value?.cli[tool].permissionModes ?? {});
  return withCurrent(keys.length ? keys : [AUTONOMOUS_PERM[tool]], current);
}
function efforts(tool: TeamAgentType, current?: string): string[] {
  return withCurrent(EFFORTS_BY_TOOL[tool], current);
}

function toEditable(r: TeamTemplate['roles'][number]): EditableRole {
  return {
    id: r.id,
    name: r.name,
    persona: r.persona,
    responsibilities: (r.responsibilities ?? []).join('\n'),
    tool: r.agent.tool,
    model: r.agent.model ?? '',
    effort: r.agent.effort ?? '',
    permission: r.agent.permission ?? '',
    canWriteCode: r.canWriteCode,
    requiredForSignoff: r.requiredForSignoff,
  };
}

function blankRoles(): EditableRole[] {
  return [
    {
      id: 'lead', name: 'Lead / Coordinator', persona: 'You direct the team, delegate work, and decide when the project is genuinely complete. You do not write code.',
      responsibilities: 'Break the goal into clear work items\nDelegate to the right role and sequence the work\nConfirm every required sign-off before completion',
      tool: 'claude', model: '', effort: 'high', permission: 'acceptEdits', canWriteCode: false, requiredForSignoff: true,
    },
    {
      id: 'developer', name: 'Developer', persona: 'You implement the agreed work as the smallest correct change that respects the existing conventions, and add or update tests for what you change.',
      responsibilities: 'Implement assigned work minimally and correctly\nFollow existing style, architecture, and tooling\nWrite or update tests for the code you change',
      tool: 'claude', model: '', effort: 'high', permission: 'acceptEdits', canWriteCode: true, requiredForSignoff: true,
    },
  ];
}

onMounted(() => {
  if (!tiger.config) void tiger.load().catch(() => {});
  name.value = props.template ? (props.template.builtin ? `${props.template.name} Copy` : props.template.name) : '';
  description.value = props.template?.description ?? '';
  const source = props.template ? props.template.roles.map(toEditable) : blankRoles();
  roles.splice(0, roles.length, ...source);
});

function onToolChange(role: EditableRole) {
  // Switching CLI: snap model/effort/permission to valid values for the new tool.
  if (!models(role.tool).includes(role.model)) role.model = '';
  if (!efforts(role.tool).includes(role.effort)) role.effort = '';
  if (!permissions(role.tool).includes(role.permission)) role.permission = AUTONOMOUS_PERM[role.tool];
}

function defaultDeveloperRole(): EditableRole {
  const d = config.value?.defaults;
  const role: EditableRole = {
    id: '',
    name: 'Developer',
    persona: 'You implement assigned work as the smallest correct change that respects the existing conventions.',
    responsibilities: 'Implement assigned work minimally and correctly\nWrite or update tests for the code you change',
    tool: 'claude',
    model: d?.claudeModel ?? '',
    effort: d?.claudeEffort ?? '',
    permission: AUTONOMOUS_PERM.claude,
    canWriteCode: true,
    requiredForSignoff: true,
  };
  role.name = nextRoleName(roles, role);
  role.id = uniqueRoleId(roles, role.name);
  return role;
}

function addRole(source?: EditableRole) {
  error.value = '';
  if (source && isLeadRole(source)) {
    error.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  const role: EditableRole = source
    ? {
        ...source,
        id: '',
        name: nextRoleName(roles, source),
      }
    : defaultDeveloperRole();
  role.id = uniqueRoleId(roles, role.name);
  roles.push(role);
}

function canRemoveRole(role: EditableRole): boolean {
  return !isLeadRole(role) || leadCount.value > 1;
}

function removeRole(i: number) {
  if (!canRemoveRole(roles[i]!)) {
    error.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  error.value = '';
  roles.splice(i, 1);
}

const busy = computed(() => team.isBusy('template'));

async function save() {
  error.value = '';
  if (!name.value.trim()) {
    error.value = t('team.templateEditor.nameRequired');
    return;
  }
  if (!roles.length) {
    error.value = t('team.templateEditor.roleRequired');
    return;
  }
  if (leadCount.value !== 1) {
    error.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  if (!roles.some((r) => r.requiredForSignoff)) {
    error.value = t('team.templateEditor.signoffRequired');
    return;
  }
  const usedRoleIds = new Set<string>();
  function payloadRoleId(role: EditableRole, index: number): string {
    const base = role.id.trim() || uniqueRoleId(roles, role.name.trim() || displayRoleName(roles, role, index), index);
    let candidate = base;
    let suffix = 2;
    while (usedRoleIds.has(candidate)) {
      candidate = `${base}-${suffix}`;
      suffix += 1;
    }
    usedRoleIds.add(candidate);
    return candidate;
  }
  const payload = {
    name: name.value.trim(),
    description: description.value.trim() || undefined,
    roles: roles.map((r, i) => ({
      id: payloadRoleId(r, i),
      name: r.name.trim() || displayRoleName(roles, r, i),
      description: '',
      persona: r.persona.trim(),
      responsibilities: r.responsibilities.split('\n').map((s) => s.trim()).filter(Boolean),
      agent: { tool: r.tool, model: r.model, effort: r.effort, permission: r.permission },
      canWriteCode: r.canWriteCode,
      requiredForSignoff: r.requiredForSignoff,
    })),
  };
  try {
    const saved = isEdit.value && props.template?.id
      ? await team.updateTemplate(props.template.id, payload)
      : await team.createTemplate(payload);
    emit('saved', saved);
  } catch (e) {
    error.value = (e as { data?: { error?: { message?: string } }; message?: string })?.data?.error?.message
      ?? (e as { message?: string })?.message ?? t('team.templateEditor.saveFailed');
  }
}
</script>

<template>
  <BaseModal :title="title" size="lg" @close="emit('close')">
    <div class="form">
      <div class="head-fields">
        <label class="field">
          <span>{{ t('team.templateEditor.name') }}</span>
          <input v-model="name" :placeholder="t('team.templateEditor.namePlaceholder')" />
        </label>
        <label class="field">
          <span>{{ t('team.templateEditor.description') }}</span>
          <input v-model="description" :placeholder="t('team.templateEditor.descriptionPlaceholder')" />
        </label>
      </div>

      <div class="roles-head">
        <h4>{{ t('team.templateEditor.roles') }}</h4>
        <BaseButton size="sm" variant="ghost" @click="addRole()">{{ t('team.templateEditor.addDeveloper') }}</BaseButton>
      </div>

      <div v-for="(role, i) in roles" :key="i" class="role-card">
        <div class="role-top">
          <TeamAgentBadge :tool="role.tool" />
          <span class="role-instance" :title="displayRoleName(roles, role, i)">{{ displayRoleName(roles, role, i) }}</span>
          <input v-model="role.name" class="role-name" :placeholder="t('team.templateEditor.roleNamePlaceholder')" />
          <BaseButton
            size="sm"
            variant="ghost"
            :disabled="isLeadRole(role)"
            :title="t('team.templateEditor.duplicateTitle')"
            @click="addRole(role)"
          >{{ t('team.launcher.duplicate') }}</BaseButton>
          <button
            type="button"
            class="rm"
            :title="t('team.templateEditor.removeRole')"
            :disabled="!canRemoveRole(role)"
            @click="removeRole(i)"
          >x</button>
        </div>

        <div class="role-grid">
          <label class="mini">
            <span>{{ t('team.templateEditor.cli') }}</span>
            <select v-model="role.tool" @change="onToolChange(role)">
              <option value="claude">claude</option>
              <option value="codex">codex</option>
              <option value="antigravity">antigravity</option>
            </select>
          </label>
          <label class="mini">
            <span>{{ t('team.roleControls.model') }}</span>
            <select v-model="role.model">
              <option v-for="m in models(role.tool, role.model)" :key="m" :value="m">{{ m || t('team.roleControls.default') }}</option>
            </select>
          </label>
          <label class="mini">
            <span>{{ t('team.roleControls.effort') }}</span>
            <select v-model="role.effort">
              <option v-for="e in efforts(role.tool, role.effort)" :key="e" :value="e">{{ e || t('team.roleControls.default') }}</option>
            </select>
          </label>
          <label class="mini">
            <span>{{ t('team.roleControls.permission') }}</span>
            <select v-model="role.permission">
              <option v-for="p in permissions(role.tool, role.permission)" :key="p" :value="p">{{ p }}</option>
            </select>
          </label>
        </div>

        <textarea v-model="role.persona" class="persona" rows="2" :placeholder="t('team.templateEditor.personaPlaceholder')" />
        <textarea v-model="role.responsibilities" class="resp" rows="2" :placeholder="t('team.templateEditor.responsibilitiesPlaceholder')" />

        <div class="flags">
          <label><input v-model="role.canWriteCode" type="checkbox" /> {{ t('team.templateEditor.mayEditSource') }}</label>
          <label><input v-model="role.requiredForSignoff" type="checkbox" /> {{ t('team.templateEditor.requiredForSignoff') }}</label>
        </div>
      </div>

      <p v-if="error" class="err">{{ error }}</p>
      <p class="hint">{{ t('team.templateEditor.permissionHint') }}</p>
    </div>

    <template #footer>
      <BaseButton variant="ghost" :disabled="busy" @click="emit('close')">{{ t('common.cancel') }}</BaseButton>
      <BaseButton variant="primary" :loading="busy" @click="save">{{ isEdit ? t('cue.editor.saveChanges') : t('team.templateEditor.createTemplate') }}</BaseButton>
    </template>
  </BaseModal>
</template>

<style scoped>
.form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  max-height: 64vh;
  overflow-y: auto;
  padding-right: var(--space-1);
}
.head-fields {
  display: grid;
  grid-template-columns: 1fr 1.4fr;
  gap: var(--space-3);
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: var(--text-xs);
  color: var(--text-dim);
}
.field input {
  width: 100%;
}
.roles-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.roles-head h4 {
  margin: 0;
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--text-dim);
}
.role-card {
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: var(--space-3);
  background: var(--bg-elev);
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}
.role-top {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}
.role-instance {
  max-width: 15ch;
  font-size: var(--text-xs);
  font-weight: 700;
  color: var(--text-dim);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: none;
}
.role-name {
  flex: 1;
  font-weight: 600;
  min-width: 12ch;
}
.rm {
  background: transparent;
  border: none;
  color: var(--text-faint);
  font-size: 13px;
  padding: 2px 6px;
}
.rm:hover {
  color: var(--red);
}
.rm:disabled {
  color: var(--text-faint);
  opacity: 0.45;
  cursor: not-allowed;
}
.role-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: var(--space-2);
}
.mini {
  display: flex;
  flex-direction: column;
  gap: 3px;
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-faint);
}
.mini select {
  width: 100%;
}
.persona,
.resp {
  width: 100%;
  resize: vertical;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2);
  line-height: var(--leading-snug);
}
.flags {
  display: flex;
  gap: var(--space-4);
  font-size: var(--text-sm);
  color: var(--text-dim);
}
.flags label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.err {
  color: var(--red);
  font-size: var(--text-sm);
  margin: 0;
}
.hint {
  font-size: var(--text-xs);
  color: var(--text-faint);
  margin: 0;
  line-height: var(--leading-snug);
}
</style>

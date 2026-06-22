<script setup lang="ts">
import { computed, onMounted, reactive, ref } from 'vue';
import { deriveTeamRoleKind, displayRoleName, isLeadRole, nextRoleName } from '~/lib/teamRoles';
import { useTeamStore } from '~/stores/team';
import { useTigerStore } from '~/stores/tiger';
import { useT } from '~/composables/useT';
import type { RoleConfigInput, RoleSnapshot, TeamAgentType } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';
import BaseButton from '~/components/ui/BaseButton.vue';

const props = defineProps<{ role: RoleSnapshot; roles: RoleSnapshot[]; displayName?: string }>();
const team = useTeamStore();
const tiger = useTigerStore();
const { t } = useT();

const TOOLS: TeamAgentType[] = ['claude', 'codex', 'antigravity'];
const EFFORTS_BY_TOOL: Record<TeamAgentType, string[]> = {
  claude: ['', 'low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['', 'low', 'medium', 'high', 'xhigh'],
  antigravity: [''],
};
const AUTONOMOUS_PERM: Record<TeamAgentType, string> = {
  claude: 'acceptEdits',
  codex: 'workspace-write',
  antigravity: 'dangerous',
};

const config = computed(() => tiger.config);
const roleLabel = computed(() => props.displayName ?? displayRoleName(props.roles, props.role));
const leadCount = computed(() => props.roles.filter((role) => isLeadRole(role)).length);
const leadRole = computed(() => isLeadRole(props.role));
const canDuplicate = computed(() => !leadRole.value);
const canRemove = computed(() => !leadRole.value || leadCount.value > 1);
const controlError = ref('');

onMounted(() => {
  if (!tiger.config) void tiger.load().catch(() => {});
});

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

// Per-role steering input.
const steerOpen = ref(false);
const steerText = ref('');
async function sendSteer(): Promise<void> {
  const body = steerText.value.trim();
  if (!body) return;
  try {
    await team.steerRole(props.role.id, body);
    steerText.value = '';
    steerOpen.value = false;
  } catch {
    /* notices surface the error */
  }
}

// Reconfigure (name / tool / capabilities).
const editOpen = ref(false);
const edit = reactive({
  name: props.role.name,
  tool: props.role.tool,
  model: props.role.model,
  effort: props.role.effort,
  permission: props.role.permission,
  canWriteCode: props.role.canWriteCode,
  requiredForSignoff: props.role.requiredForSignoff,
});
function openEdit(): void {
  controlError.value = '';
  edit.name = props.role.name;
  edit.tool = props.role.tool;
  edit.model = props.role.model;
  edit.effort = props.role.effort;
  edit.permission = props.role.permission;
  edit.canWriteCode = props.role.canWriteCode;
  edit.requiredForSignoff = props.role.requiredForSignoff;
  editOpen.value = true;
}
function onToolChange(): void {
  if (!models(edit.tool).includes(edit.model)) edit.model = '';
  if (!efforts(edit.tool).includes(edit.effort)) edit.effort = '';
  if (!permissions(edit.tool).includes(edit.permission)) edit.permission = AUTONOMOUS_PERM[edit.tool];
}
async function saveEdit(): Promise<void> {
  controlError.value = '';
  const candidate = {
    id: props.role.id,
    name: edit.name.trim() || props.role.name,
    canWriteCode: edit.canWriteCode,
    requiredForSignoff: edit.requiredForSignoff,
  };
  const candidateIsLead = deriveTeamRoleKind(candidate) === 'lead';
  const otherLeadExists = props.roles.some((role) => role.id !== props.role.id && isLeadRole(role));
  if (candidateIsLead && otherLeadExists) {
    controlError.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  if (leadRole.value && !candidateIsLead && !otherLeadExists) {
    controlError.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  try {
    await team.reconfigureRole(props.role.id, {
      name: edit.name.trim() || undefined,
      tool: edit.tool,
      model: edit.model,
      effort: edit.effort,
      permission: edit.permission,
      canWriteCode: edit.canWriteCode,
      requiredForSignoff: edit.requiredForSignoff,
    });
    editOpen.value = false;
  } catch {
    /* notices surface the error */
  }
}

async function addInstance(): Promise<void> {
  controlError.value = '';
  if (!canDuplicate.value) {
    controlError.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  const role: RoleConfigInput = {
    name: nextRoleName(props.roles, props.role),
    description: '',
    persona: '',
    tool: props.role.tool,
    model: props.role.model,
    effort: props.role.effort,
    permission: props.role.permission || AUTONOMOUS_PERM[props.role.tool],
    canWriteCode: props.role.canWriteCode,
    requiredForSignoff: props.role.requiredForSignoff,
  };
  try {
    await team.addRole(role);
  } catch {
    /* notices surface the error */
  }
}

async function remove(): Promise<void> {
  controlError.value = '';
  if (!canRemove.value) {
    controlError.value = t('team.roleControls.oneLeadRequired');
    return;
  }
  try {
    await team.removeRole(props.role.id);
  } catch {
    /* notices surface the error — Lead is protected server-side */
  }
}

const TOOL_KEY: Record<TeamAgentType, string> = { claude: 'common.providers.claude', codex: 'common.providers.codex', antigravity: 'common.providers.antigravity' };
const toolLabel = (tool: TeamAgentType) => t(TOOL_KEY[tool]) || tool;
</script>

<template>
  <div class="rc">
    <div class="rc-line">
      <TeamAgentBadge :tool="role.tool" />
      <span class="rc-name" :title="roleLabel">{{ roleLabel }}</span>
      <span class="rc-status">{{ role.status }}</span>
    </div>
    <div class="rc-btns">
      <BaseButton
        size="sm"
        variant="ghost"
        :loading="team.isBusy(`role-pause:${role.id}`)"
        :title="t('team.roleControls.pauseTitle')"
        @click="team.pauseRole(role.id)"
      >{{ t('team.controls.pause') }}</BaseButton>
      <BaseButton
        size="sm"
        variant="ghost"
        :loading="team.isBusy(`role-resume:${role.id}`)"
        @click="team.resumeRole(role.id)"
      >{{ t('team.controls.resume') }}</BaseButton>
      <BaseButton size="sm" variant="ghost" @click="steerOpen = !steerOpen">{{ t('team.roleControls.steer') }}</BaseButton>
      <BaseButton size="sm" variant="ghost" @click="openEdit">{{ t('common.edit') }}</BaseButton>
      <BaseButton
        v-if="canDuplicate"
        size="sm"
        variant="ghost"
        :loading="team.isBusy('role-add')"
        :title="t('team.roleControls.addAnotherTitle')"
        @click="addInstance"
      >{{ t('team.roleControls.addAnother') }}</BaseButton>
      <BaseButton
        size="sm"
        variant="danger"
        :disabled="!canRemove"
        :loading="team.isBusy(`role-remove:${role.id}`)"
        :title="canRemove ? t('team.roleControls.removeTitle') : t('team.roleControls.keepOneLead')"
        @click="remove"
      >{{ t('team.roleControls.remove') }}</BaseButton>
    </div>

    <div v-if="steerOpen" class="rc-form">
      <textarea v-model="steerText" rows="2" class="rc-input" :placeholder="t('team.roleControls.steerPlaceholder')" :aria-label="t('team.roleControls.steerAria')" />
      <div class="rc-form-btns">
        <BaseButton size="sm" variant="primary" :loading="team.isBusy(`role-steer:${role.id}`)" @click="sendSteer">{{ t('common.submit') }}</BaseButton>
        <BaseButton size="sm" variant="ghost" @click="steerOpen = false">{{ t('common.cancel') }}</BaseButton>
      </div>
    </div>

    <div v-if="editOpen" class="rc-form">
      <label class="fld"><span>{{ t('team.roleControls.name') }}</span><input v-model="edit.name" type="text" /></label>
      <label class="fld"><span>{{ t('team.roleControls.tool') }}</span>
        <select v-model="edit.tool" @change="onToolChange">
          <option v-for="tool in TOOLS" :key="tool" :value="tool">{{ toolLabel(tool) }}</option>
        </select>
      </label>
      <label class="fld"><span>{{ t('team.roleControls.model') }}</span>
        <select v-model="edit.model">
          <option v-for="m in models(edit.tool, edit.model)" :key="m" :value="m">{{ m || t('team.roleControls.default') }}</option>
        </select>
      </label>
      <label class="fld"><span>{{ t('team.roleControls.effort') }}</span>
        <select v-model="edit.effort">
          <option v-for="e in efforts(edit.tool, edit.effort)" :key="e" :value="e">{{ e || t('team.roleControls.default') }}</option>
        </select>
      </label>
      <label class="fld"><span>{{ t('team.roleControls.permission') }}</span>
        <select v-model="edit.permission">
          <option v-for="p in permissions(edit.tool, edit.permission)" :key="p" :value="p">{{ p }}</option>
        </select>
      </label>
      <label class="chk"><input v-model="edit.canWriteCode" type="checkbox" /> {{ t('team.roleControls.mayWriteCode') }}</label>
      <label class="chk"><input v-model="edit.requiredForSignoff" type="checkbox" /> {{ t('team.roleControls.requiredForSignoff') }}</label>
      <div class="rc-form-btns">
        <BaseButton size="sm" variant="primary" :loading="team.isBusy(`role-edit:${role.id}`)" @click="saveEdit">{{ t('common.save') }}</BaseButton>
        <BaseButton size="sm" variant="ghost" @click="editOpen = false">{{ t('common.cancel') }}</BaseButton>
      </div>
    </div>
    <p v-if="controlError" class="rc-error">{{ controlError }}</p>
  </div>
</template>

<style scoped>
.rc {
  padding: var(--space-2);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elev);
}
.rc-line { display: flex; align-items: center; gap: var(--space-2); }
.rc-name { font-weight: 600; font-size: var(--text-sm); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1; }
.rc-status { font-size: 10px; color: var(--text-faint); text-transform: uppercase; }
.rc-btns { display: flex; flex-wrap: wrap; gap: var(--space-1); margin-top: var(--space-1); }
.rc-form { margin-top: var(--space-2); display: flex; flex-direction: column; gap: var(--space-1); }
.rc-input {
  resize: vertical;
  font-family: inherit;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-1) var(--space-2);
}
.rc-form-btns { display: flex; gap: var(--space-2); }
.fld { display: flex; flex-direction: column; gap: 2px; font-size: var(--text-xs); color: var(--text-dim); }
.fld input, .fld select {
  width: 100%;
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
}
.chk { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); color: var(--text-dim); }
.rc-error {
  margin: var(--space-2) 0 0;
  color: var(--red);
  font-size: var(--text-xs);
}
</style>

<script setup lang="ts">
import { reactive, ref } from 'vue';
import { useTeamStore } from '~/stores/team';
import type { RoleSnapshot, TeamAgentType } from '~/types';
import TeamAgentBadge from './TeamAgentBadge.vue';
import BaseButton from '~/components/ui/BaseButton.vue';

const props = defineProps<{ role: RoleSnapshot }>();
const team = useTeamStore();

const TOOLS: TeamAgentType[] = ['claude', 'codex', 'antigravity'];

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
  canWriteCode: props.role.canWriteCode,
  requiredForSignoff: props.role.requiredForSignoff,
});
function openEdit(): void {
  edit.name = props.role.name;
  edit.tool = props.role.tool;
  edit.canWriteCode = props.role.canWriteCode;
  edit.requiredForSignoff = props.role.requiredForSignoff;
  editOpen.value = true;
}
async function saveEdit(): Promise<void> {
  try {
    await team.reconfigureRole(props.role.id, {
      name: edit.name.trim() || undefined,
      tool: edit.tool,
      canWriteCode: edit.canWriteCode,
      requiredForSignoff: edit.requiredForSignoff,
    });
    editOpen.value = false;
  } catch {
    /* notices surface the error */
  }
}

async function remove(): Promise<void> {
  try {
    await team.removeRole(props.role.id);
  } catch {
    /* notices surface the error — Lead is protected server-side */
  }
}

const TOOL_LABEL: Record<TeamAgentType, string> = { claude: 'Claude', codex: 'Codex', antigravity: 'Antigravity' };
const toolLabel = (t: TeamAgentType) => TOOL_LABEL[t] ?? t;
</script>

<template>
  <div class="rc">
    <div class="rc-line">
      <TeamAgentBadge :tool="role.tool" />
      <span class="rc-name" :title="role.name">{{ role.name }}</span>
      <span class="rc-status">{{ role.status }}</span>
    </div>
    <div class="rc-btns">
      <BaseButton
        size="sm"
        variant="ghost"
        :loading="team.isBusy(`role-pause:${role.id}`)"
        title="Pause this role (no further turns until resumed)"
        @click="team.pauseRole(role.id)"
      >Pause</BaseButton>
      <BaseButton
        size="sm"
        variant="ghost"
        :loading="team.isBusy(`role-resume:${role.id}`)"
        @click="team.resumeRole(role.id)"
      >Resume</BaseButton>
      <BaseButton size="sm" variant="ghost" @click="steerOpen = !steerOpen">Steer</BaseButton>
      <BaseButton size="sm" variant="ghost" @click="openEdit">Edit</BaseButton>
      <BaseButton
        size="sm"
        variant="danger"
        :loading="team.isBusy(`role-remove:${role.id}`)"
        title="Remove this role from the run (the Lead is protected)"
        @click="remove"
      >Remove</BaseButton>
    </div>

    <div v-if="steerOpen" class="rc-form">
      <textarea v-model="steerText" rows="2" class="rc-input" placeholder="Direct this role…" aria-label="Steer role" />
      <div class="rc-form-btns">
        <BaseButton size="sm" variant="primary" :loading="team.isBusy(`role-steer:${role.id}`)" @click="sendSteer">Send</BaseButton>
        <BaseButton size="sm" variant="ghost" @click="steerOpen = false">Cancel</BaseButton>
      </div>
    </div>

    <div v-if="editOpen" class="rc-form">
      <label class="fld"><span>Name</span><input v-model="edit.name" type="text" /></label>
      <label class="fld"><span>Tool</span>
        <select v-model="edit.tool">
          <option v-for="t in TOOLS" :key="t" :value="t">{{ toolLabel(t) }}</option>
        </select>
      </label>
      <label class="chk"><input v-model="edit.canWriteCode" type="checkbox" /> May write code</label>
      <label class="chk"><input v-model="edit.requiredForSignoff" type="checkbox" /> Required for sign-off</label>
      <div class="rc-form-btns">
        <BaseButton size="sm" variant="primary" :loading="team.isBusy(`role-edit:${role.id}`)" @click="saveEdit">Save</BaseButton>
        <BaseButton size="sm" variant="ghost" @click="editOpen = false">Cancel</BaseButton>
      </div>
    </div>
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
  font-size: var(--text-sm);
  color: var(--text);
  background: var(--bg);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: 2px var(--space-2);
}
.chk { display: flex; align-items: center; gap: var(--space-1); font-size: var(--text-xs); color: var(--text-dim); }
</style>

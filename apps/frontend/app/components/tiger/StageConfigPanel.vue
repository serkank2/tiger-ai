<script setup lang="ts">
import type { TigerAgentType, TigerConfig, TigerStageId, TigerStageRunConfig } from '~/types';

const props = defineProps<{
  config: TigerConfig;
  stage: TigerStageId;
  cfg: TigerStageRunConfig;
  disabled?: boolean;
}>();

const isMerge = computed(() => props.stage === 'merge-tasks');

const AGENT_COUNT_MIN = 1;
const AGENT_COUNT_MAX = 8;
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];

const EFFORT_LABEL: Record<string, string> = {
  '': 'Default',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  xhigh: 'Extra high',
  max: 'Max',
};
const effortLabel = (e: string) => EFFORT_LABEL[e] ?? e;

// Model dropdown options come from config (editable in tiger/config.json), with '' = CLI default.
const claudeModels = computed(() => ['', ...(props.config.cli.claude.models ?? ['opus', 'sonnet', 'haiku', 'fable'])]);
const codexModels = computed(() => ['', ...(props.config.cli.codex.models ?? ['gpt-5.5', 'gpt-5-codex', 'gpt-5', 'o3', 'o4-mini'])]);

const claudePerms = computed(() => Object.keys(props.config.cli.claude.permissionModes));
const codexPerms = computed(() => Object.keys(props.config.cli.codex.permissionModes));

function clampAgentCount(value: unknown): number {
  return Math.min(AGENT_COUNT_MAX, Math.max(AGENT_COUNT_MIN, Number.isInteger(value) ? Number(value) : AGENT_COUNT_MIN));
}

function setAgentCount(field: 'claudeAgents' | 'codexAgents', value: unknown) {
  props.cfg[field] = clampAgentCount(value);
}

watch(
  () => props.cfg.claudeAgents,
  (value) => {
    const next = clampAgentCount(value);
    if (value !== next) props.cfg.claudeAgents = next;
  },
  { immediate: true },
);
watch(
  () => props.cfg.codexAgents,
  (value) => {
    const next = clampAgentCount(value);
    if (value !== next) props.cfg.codexAgents = next;
  },
  { immediate: true },
);
watch(
  () => [props.cfg.claudeModel, claudeModels.value.join('\0')],
  ([model]) => {
    if (!claudeModels.value.includes(model)) props.cfg.claudeModel = '';
  },
  { immediate: true },
);
watch(
  () => [props.cfg.codexModel, codexModels.value.join('\0')],
  ([model]) => {
    if (!codexModels.value.includes(model)) props.cfg.codexModel = '';
  },
  { immediate: true },
);
watch(
  () => props.cfg.claudeEffort,
  (effort) => {
    if (!CLAUDE_EFFORTS.includes(effort)) props.cfg.claudeEffort = '';
  },
  { immediate: true },
);
watch(
  () => props.cfg.codexEffort,
  (effort) => {
    if (!CODEX_EFFORTS.includes(effort)) props.cfg.codexEffort = '';
  },
  { immediate: true },
);

function isDangerous(type: TigerAgentType, perm: string): boolean {
  const args = props.config.cli[type].permissionModes[perm] ?? [];
  return args.some(
    (a) => a === '--dangerously-skip-permissions' || a === '--dangerously-bypass-approvals-and-sandbox',
  );
}
const claudeDanger = computed(() => isDangerous('claude', props.cfg.claudePermission));
const codexDanger = computed(() => isDangerous('codex', props.cfg.codexPermission));

const PERM_LABEL: Record<string, string> = {
  default: 'Normal (asks)',
  acceptEdits: 'Auto-accept edits',
  plan: 'Plan mode',
  dangerous: 'Full access (skip permissions)',
  'read-only': 'Read-only',
  'workspace-write': 'Workspace write (auto)',
  yolo: 'Full access (YOLO)',
};
const permLabel = (k: string) => PERM_LABEL[k] ?? k;
</script>

<template>
  <div class="cfg" :class="{ disabled }">
    <!-- Merge stage: exactly one agent -->
    <template v-if="isMerge">
      <p class="note">The Merge Tasks stage runs exactly one agent. Choose which one performs the merge.</p>
      <div class="grid">
        <label class="field">
          <span>Agent</span>
          <select v-model="cfg.mergeAgent" :disabled="disabled">
            <option value="claude">Claude</option>
            <option value="codex">Codex</option>
          </select>
        </label>
        <template v-if="cfg.mergeAgent === 'codex'">
          <label class="field">
            <span>Codex model</span>
            <select v-model="cfg.codexModel" :disabled="disabled">
              <option v-for="m in codexModels" :key="m" :value="m">{{ m || 'default' }}</option>
            </select>
          </label>
          <label class="field">
            <span>Codex effort</span>
            <select v-model="cfg.codexEffort" :disabled="disabled">
              <option v-for="e in CODEX_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>Codex permission</span>
            <select v-model="cfg.codexPermission" :disabled="disabled">
              <option v-for="p in codexPerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
        </template>
        <template v-else>
          <label class="field">
            <span>Claude model</span>
            <select v-model="cfg.claudeModel" :disabled="disabled">
              <option v-for="m in claudeModels" :key="m" :value="m">{{ m || 'default' }}</option>
            </select>
          </label>
          <label class="field">
            <span>Claude effort</span>
            <select v-model="cfg.claudeEffort" :disabled="disabled">
              <option v-for="e in CLAUDE_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>Claude permission</span>
            <select v-model="cfg.claudePermission" :disabled="disabled">
              <option v-for="p in claudePerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
        </template>
      </div>
      <p v-if="(cfg.mergeAgent === 'codex' ? codexDanger : claudeDanger)" class="danger">
        ⚠ Full-access mode bypasses all safety checks for this agent. Use only when you trust the task.
      </p>
    </template>

    <!-- Standard stages: N Claude + M Codex -->
    <template v-else>
      <div class="cols">
        <fieldset>
          <legend>Claude agents</legend>
          <div class="field count-field">
            <span>Count <b class="count-badge">{{ cfg.claudeAgents }}</b></span>
            <input
              class="slider"
              type="range"
              :min="AGENT_COUNT_MIN"
              :max="AGENT_COUNT_MAX"
              step="1"
              :value="cfg.claudeAgents"
              :disabled="disabled"
              @input="setAgentCount('claudeAgents', Number(($event.target as HTMLInputElement).value))"
            />
            <div class="scale"><span>{{ AGENT_COUNT_MIN }}</span><span>{{ AGENT_COUNT_MAX }}</span></div>
          </div>
          <label class="field">
            <span>Model</span>
            <select v-model="cfg.claudeModel" :disabled="disabled">
              <option v-for="m in claudeModels" :key="m" :value="m">{{ m || 'default' }}</option>
            </select>
          </label>
          <label class="field">
            <span>Effort</span>
            <select v-model="cfg.claudeEffort" :disabled="disabled">
              <option v-for="e in CLAUDE_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>Permission</span>
            <select v-model="cfg.claudePermission" :disabled="disabled">
              <option v-for="p in claudePerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
          <p v-if="claudeDanger" class="danger">⚠ Full access bypasses all permission checks.</p>
        </fieldset>

        <fieldset>
          <legend>Codex agents</legend>
          <div class="field count-field">
            <span>Count <b class="count-badge">{{ cfg.codexAgents }}</b></span>
            <input
              class="slider"
              type="range"
              :min="AGENT_COUNT_MIN"
              :max="AGENT_COUNT_MAX"
              step="1"
              :value="cfg.codexAgents"
              :disabled="disabled"
              @input="setAgentCount('codexAgents', Number(($event.target as HTMLInputElement).value))"
            />
            <div class="scale"><span>{{ AGENT_COUNT_MIN }}</span><span>{{ AGENT_COUNT_MAX }}</span></div>
          </div>
          <label class="field">
            <span>Model</span>
            <select v-model="cfg.codexModel" :disabled="disabled">
              <option v-for="m in codexModels" :key="m" :value="m">{{ m || 'default' }}</option>
            </select>
          </label>
          <label class="field">
            <span>Effort</span>
            <select v-model="cfg.codexEffort" :disabled="disabled">
              <option v-for="e in CODEX_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>Permission</span>
            <select v-model="cfg.codexPermission" :disabled="disabled">
              <option v-for="p in codexPerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
          <p v-if="codexDanger" class="danger">⚠ YOLO bypasses sandbox + approval checks.</p>
        </fieldset>
      </div>

      <label class="parallel">
        <input v-model="cfg.parallel" type="checkbox" :disabled="disabled" />
        <span>Run agents in parallel</span>
      </label>
    </template>
  </div>
</template>

<style scoped>
.cfg.disabled {
  opacity: 0.6;
  pointer-events: none;
}
.note {
  margin: 0 0 10px;
  color: var(--text-dim);
  font-size: 13px;
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}
fieldset {
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 10px 12px 12px;
  min-width: 0;
}
legend {
  font-size: 12px;
  font-weight: 700;
  color: var(--accent);
  padding: 0 6px;
}
.grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
}
.field > span {
  font-size: 11px;
  color: var(--text-dim);
}
.parallel {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
  font-size: 13px;
  color: var(--text-dim);
}
.parallel input {
  width: auto;
}
.danger {
  margin: 6px 0 0;
  font-size: 11px;
  color: var(--amber);
}
.count-field {
  gap: 2px;
}
.count-badge {
  display: inline-grid;
  place-items: center;
  min-width: 20px;
  height: 18px;
  padding: 0 5px;
  margin-left: 6px;
  border-radius: 999px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 12px;
  font-weight: 700;
  vertical-align: middle;
}
.slider {
  width: 100%;
  height: 22px;
  margin: 2px 0 0;
  padding: 0;
  background: transparent;
  border: none;
  border-radius: 0;
  accent-color: var(--accent);
  cursor: pointer;
}
.slider:disabled {
  cursor: not-allowed;
  opacity: 0.6;
}
.scale {
  display: flex;
  justify-content: space-between;
  font-size: 10px;
  color: var(--text-faint);
  font-family: var(--font-mono);
  margin-top: -2px;
}
</style>

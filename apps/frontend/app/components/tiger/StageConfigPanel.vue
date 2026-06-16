<script setup lang="ts">
import type { TigerAgentType, TigerConfig, TigerStageId, TigerStageRunConfig } from '~/types';

const props = defineProps<{
  config: TigerConfig;
  stage: TigerStageId;
  cfg: TigerStageRunConfig;
  disabled?: boolean;
}>();

const isMerge = computed(() => props.stage === 'merge-tasks');

const CLAUDE_MODELS = ['', 'opus', 'sonnet', 'haiku', 'fable'];
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'low', 'medium', 'high'];

const claudePerms = computed(() => Object.keys(props.config.cli.claude.permissionModes));
const codexPerms = computed(() => Object.keys(props.config.cli.codex.permissionModes));

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
            <input v-model="cfg.codexModel" placeholder="default" :disabled="disabled" spellcheck="false" />
          </label>
          <label class="field">
            <span>Codex effort</span>
            <select v-model="cfg.codexEffort" :disabled="disabled">
              <option v-for="e in CODEX_EFFORTS" :key="e" :value="e">{{ e || 'default' }}</option>
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
              <option v-for="m in CLAUDE_MODELS" :key="m" :value="m">{{ m || 'default' }}</option>
            </select>
          </label>
          <label class="field">
            <span>Claude effort</span>
            <select v-model="cfg.claudeEffort" :disabled="disabled">
              <option v-for="e in CLAUDE_EFFORTS" :key="e" :value="e">{{ e || 'default' }}</option>
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
          <label class="field">
            <span>Count</span>
            <input v-model.number="cfg.claudeAgents" type="number" min="0" max="8" :disabled="disabled" />
          </label>
          <label class="field">
            <span>Model</span>
            <select v-model="cfg.claudeModel" :disabled="disabled">
              <option v-for="m in CLAUDE_MODELS" :key="m" :value="m">{{ m || 'default' }}</option>
            </select>
          </label>
          <label class="field">
            <span>Effort</span>
            <select v-model="cfg.claudeEffort" :disabled="disabled">
              <option v-for="e in CLAUDE_EFFORTS" :key="e" :value="e">{{ e || 'default' }}</option>
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
          <label class="field">
            <span>Count</span>
            <input v-model.number="cfg.codexAgents" type="number" min="0" max="8" :disabled="disabled" />
          </label>
          <label class="field">
            <span>Model</span>
            <input v-model="cfg.codexModel" placeholder="default" :disabled="disabled" spellcheck="false" />
          </label>
          <label class="field">
            <span>Effort</span>
            <select v-model="cfg.codexEffort" :disabled="disabled">
              <option v-for="e in CODEX_EFFORTS" :key="e" :value="e">{{ e || 'default' }}</option>
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
</style>

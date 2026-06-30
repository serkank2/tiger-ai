<script setup lang="ts">
import { useT } from '~/composables/useT';
import type { TigerAgentType, TigerConfig, TigerStageId, TigerStageRunConfig } from '~/types';

const props = defineProps<{
  config: TigerConfig;
  stage: TigerStageId;
  cfg: TigerStageRunConfig;
  disabled?: boolean;
}>();

// The parent owns the stage config. This panel never mutates the `cfg` prop in
// place: every edit (and the normalization below) is announced via `update:cfg`
// and the parent writes it back. Read-only (`disabled`) panels never emit.
const emit = defineEmits<{ 'update:cfg': [cfg: TigerStageRunConfig] }>();

const { t } = useT();

function patch(changes: Partial<TigerStageRunConfig>): void {
  if (props.disabled) return;
  emit('update:cfg', { ...props.cfg, ...changes });
}

// Writable computed per field: reads the prop, writes through `patch` (emit) so the
// template keeps using `v-model` without ever assigning to the prop.
function field<K extends keyof TigerStageRunConfig>(key: K) {
  return computed<TigerStageRunConfig[K]>({
    get: () => props.cfg[key],
    set: (value) => patch({ [key]: value } as Partial<TigerStageRunConfig>),
  });
}
const mergeAgent = field('mergeAgent');
const claudeModel = field('claudeModel');
const claudeEffort = field('claudeEffort');
const claudePermission = field('claudePermission');
const codexModel = field('codexModel');
const codexEffort = field('codexEffort');
const codexPermission = field('codexPermission');
const antigravityModel = field('antigravityModel');
const antigravityPermission = field('antigravityPermission');
const parallel = field('parallel');

const isMerge = computed(() => props.stage === 'merge-tasks');

const AGENT_COUNT_MIN = 0;
const AGENT_COUNT_MAX = 8;
const CLAUDE_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh', 'max'];
const CODEX_EFFORTS = ['', 'low', 'medium', 'high', 'xhigh'];
// Antigravity (`agy`) has no reasoning-effort flag; only the CLI default ('') is valid.
const ANTIGRAVITY_EFFORTS = [''];

const effortLabels = computed<Record<string, string>>(() => ({
  '': t('tiger.stageConfig.efforts.default'),
  low: t('tiger.stageConfig.efforts.low'),
  medium: t('tiger.stageConfig.efforts.medium'),
  high: t('tiger.stageConfig.efforts.high'),
  xhigh: t('tiger.stageConfig.efforts.xhigh'),
  max: t('tiger.stageConfig.efforts.max'),
}));
const effortLabel = (e: string) => effortLabels.value[e] ?? e;

// Model dropdown options come from config (editable in tiger/config.json), with '' = CLI default.
const claudeModels = computed(() => ['', ...(props.config.cli.claude.models ?? ['opus', 'sonnet', 'haiku', 'fable'])]);
const codexModels = computed(() => [
  '',
  ...(props.config.cli.codex.models ?? ['gpt-5.5', 'gpt-5-codex', 'gpt-5', 'o3', 'o4-mini']),
]);
const antigravityModels = computed(() => ['', ...(props.config.cli.antigravity?.models ?? [])]);

const claudePerms = computed(() => Object.keys(props.config.cli.claude.permissionModes));
const codexPerms = computed(() => Object.keys(props.config.cli.codex.permissionModes));
const antigravityPerms = computed(() => Object.keys(props.config.cli.antigravity?.permissionModes ?? {}));

function clampAgentCount(value: unknown): number {
  return Math.min(
    AGENT_COUNT_MAX,
    Math.max(AGENT_COUNT_MIN, Number.isInteger(value) ? Number(value) : AGENT_COUNT_MIN),
  );
}

function setAgentCount(key: 'claudeAgents' | 'codexAgents' | 'antigravityAgents', value: unknown) {
  patch({ [key]: clampAgentCount(value) } as Partial<TigerStageRunConfig>);
}

watch(
  () => props.cfg.claudeAgents,
  (value) => {
    const next = clampAgentCount(value);
    if (value !== next) patch({ claudeAgents: next });
  },
  { immediate: true },
);
watch(
  () => props.cfg.codexAgents,
  (value) => {
    const next = clampAgentCount(value);
    if (value !== next) patch({ codexAgents: next });
  },
  { immediate: true },
);
watch(
  () => [props.cfg.claudeModel, claudeModels.value.join('\0')],
  ([model]) => {
    if (!claudeModels.value.includes(model ?? '')) patch({ claudeModel: '' });
  },
  { immediate: true },
);
watch(
  () => [props.cfg.codexModel, codexModels.value.join('\0')],
  ([model]) => {
    if (!codexModels.value.includes(model ?? '')) patch({ codexModel: '' });
  },
  { immediate: true },
);
watch(
  () => props.cfg.claudeEffort,
  (effort) => {
    if (!CLAUDE_EFFORTS.includes(effort)) patch({ claudeEffort: '' });
  },
  { immediate: true },
);
watch(
  () => props.cfg.codexEffort,
  (effort) => {
    if (!CODEX_EFFORTS.includes(effort)) patch({ codexEffort: '' });
  },
  { immediate: true },
);
watch(
  () => props.cfg.antigravityAgents,
  (value) => {
    const next = clampAgentCount(value);
    if (value !== next) patch({ antigravityAgents: next });
  },
  { immediate: true },
);
watch(
  () => [props.cfg.antigravityModel, antigravityModels.value.join('\0')],
  ([model]) => {
    if (!antigravityModels.value.includes(model ?? '')) patch({ antigravityModel: '' });
  },
  { immediate: true },
);
watch(
  () => props.cfg.antigravityEffort,
  (effort) => {
    if (!ANTIGRAVITY_EFFORTS.includes(effort)) patch({ antigravityEffort: '' });
  },
  { immediate: true },
);

function isDangerous(type: TigerAgentType, perm: string): boolean {
  const args = props.config.cli[type]?.permissionModes[perm] ?? [];
  return args.some((a) => a === '--dangerously-skip-permissions' || a === '--dangerously-bypass-approvals-and-sandbox');
}
const claudeDanger = computed(() => isDangerous('claude', props.cfg.claudePermission));
const codexDanger = computed(() => isDangerous('codex', props.cfg.codexPermission));
const antigravityDanger = computed(() => isDangerous('antigravity', props.cfg.antigravityPermission));

const permLabels = computed<Record<string, string>>(() => ({
  default: t('tiger.stageConfig.permissions.default'),
  acceptEdits: t('tiger.stageConfig.permissions.acceptEdits'),
  plan: t('tiger.stageConfig.permissions.plan'),
  dangerous: t('tiger.stageConfig.permissions.dangerous'),
  'read-only': t('tiger.stageConfig.permissions.readOnly'),
  'workspace-write': t('tiger.stageConfig.permissions.workspaceWrite'),
  yolo: t('tiger.stageConfig.permissions.yolo'),
  sandbox: t('tiger.stageConfig.permissions.sandbox'),
}));
const permLabel = (k: string) => permLabels.value[k] ?? k;
</script>

<template>
  <div class="cfg" :class="{ disabled }">
    <!-- Merge stage: exactly one agent -->
    <template v-if="isMerge">
      <p class="note">{{ t('tiger.stageConfig.mergeNote') }}</p>
      <div class="grid">
        <label class="field">
          <span>{{ t('tiger.stageConfig.agent') }}</span>
          <select v-model="mergeAgent" :disabled="disabled">
            <option value="claude">{{ t('common.providers.claude') }}</option>
            <option value="codex">{{ t('common.providers.codex') }}</option>
            <option value="antigravity">{{ t('common.providers.antigravity') }}</option>
          </select>
        </label>
        <template v-if="cfg.mergeAgent === 'codex'">
          <label class="field">
            <span>{{ t('tiger.stageConfig.codexModel') }}</span>
            <select v-model="codexModel" :disabled="disabled">
              <option v-for="m in codexModels" :key="m" :value="m">
                {{ m || t('tiger.stageConfig.defaultOption') }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.codexEffort') }}</span>
            <select v-model="codexEffort" :disabled="disabled">
              <option v-for="e in CODEX_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.codexPermission') }}</span>
            <select v-model="codexPermission" :disabled="disabled">
              <option v-for="p in codexPerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
        </template>
        <template v-else-if="cfg.mergeAgent === 'antigravity'">
          <label class="field">
            <span>{{ t('tiger.stageConfig.antigravityModel') }}</span>
            <select v-model="antigravityModel" :disabled="disabled">
              <option v-for="m in antigravityModels" :key="m" :value="m">
                {{ m || t('tiger.stageConfig.defaultOption') }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.antigravityPermission') }}</span>
            <select v-model="antigravityPermission" :disabled="disabled">
              <option v-for="p in antigravityPerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
        </template>
        <template v-else>
          <label class="field">
            <span>{{ t('tiger.stageConfig.claudeModel') }}</span>
            <select v-model="claudeModel" :disabled="disabled">
              <option v-for="m in claudeModels" :key="m" :value="m">
                {{ m || t('tiger.stageConfig.defaultOption') }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.claudeEffort') }}</span>
            <select v-model="claudeEffort" :disabled="disabled">
              <option v-for="e in CLAUDE_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.claudePermission') }}</span>
            <select v-model="claudePermission" :disabled="disabled">
              <option v-for="p in claudePerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
        </template>
      </div>
      <p
        v-if="
          cfg.mergeAgent === 'codex' ? codexDanger : cfg.mergeAgent === 'antigravity' ? antigravityDanger : claudeDanger
        "
        class="danger"
      >
        {{ t('tiger.stageConfig.dangerMerge') }}
      </p>
    </template>

    <!-- Standard stages: N Claude + M Codex -->
    <template v-else>
      <div class="cols">
        <fieldset>
          <legend>{{ t('tiger.stageConfig.claudeAgents') }}</legend>
          <div class="field count-field">
            <span
              >{{ t('tiger.stageConfig.count') }} <b class="count-badge">{{ cfg.claudeAgents }}</b></span
            >
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
            <div class="scale">
              <span>{{ AGENT_COUNT_MIN }}</span
              ><span>{{ AGENT_COUNT_MAX }}</span>
            </div>
          </div>
          <label class="field">
            <span>{{ t('tiger.stageConfig.model') }}</span>
            <select v-model="claudeModel" :disabled="disabled">
              <option v-for="m in claudeModels" :key="m" :value="m">
                {{ m || t('tiger.stageConfig.defaultOption') }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.effort') }}</span>
            <select v-model="claudeEffort" :disabled="disabled">
              <option v-for="e in CLAUDE_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.permission') }}</span>
            <select v-model="claudePermission" :disabled="disabled">
              <option v-for="p in claudePerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
          <p v-if="claudeDanger" class="danger">{{ t('tiger.stageConfig.dangerClaude') }}</p>
        </fieldset>

        <fieldset>
          <legend>{{ t('tiger.stageConfig.codexAgents') }}</legend>
          <div class="field count-field">
            <span
              >{{ t('tiger.stageConfig.count') }} <b class="count-badge">{{ cfg.codexAgents }}</b></span
            >
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
            <div class="scale">
              <span>{{ AGENT_COUNT_MIN }}</span
              ><span>{{ AGENT_COUNT_MAX }}</span>
            </div>
          </div>
          <label class="field">
            <span>{{ t('tiger.stageConfig.model') }}</span>
            <select v-model="codexModel" :disabled="disabled">
              <option v-for="m in codexModels" :key="m" :value="m">
                {{ m || t('tiger.stageConfig.defaultOption') }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.effort') }}</span>
            <select v-model="codexEffort" :disabled="disabled">
              <option v-for="e in CODEX_EFFORTS" :key="e" :value="e">{{ effortLabel(e) }}</option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.permission') }}</span>
            <select v-model="codexPermission" :disabled="disabled">
              <option v-for="p in codexPerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
          <p v-if="codexDanger" class="danger">{{ t('tiger.stageConfig.dangerCodex') }}</p>
        </fieldset>

        <fieldset>
          <legend>{{ t('tiger.stageConfig.antigravityAgents') }}</legend>
          <div class="field count-field">
            <span
              >{{ t('tiger.stageConfig.count') }} <b class="count-badge">{{ cfg.antigravityAgents }}</b></span
            >
            <input
              class="slider"
              type="range"
              :min="AGENT_COUNT_MIN"
              :max="AGENT_COUNT_MAX"
              step="1"
              :value="cfg.antigravityAgents"
              :disabled="disabled"
              @input="setAgentCount('antigravityAgents', Number(($event.target as HTMLInputElement).value))"
            />
            <div class="scale">
              <span>{{ AGENT_COUNT_MIN }}</span
              ><span>{{ AGENT_COUNT_MAX }}</span>
            </div>
          </div>
          <label class="field">
            <span>{{ t('tiger.stageConfig.model') }}</span>
            <select v-model="antigravityModel" :disabled="disabled">
              <option v-for="m in antigravityModels" :key="m" :value="m">
                {{ m || t('tiger.stageConfig.defaultOption') }}
              </option>
            </select>
          </label>
          <label class="field">
            <span>{{ t('tiger.stageConfig.permission') }}</span>
            <select v-model="antigravityPermission" :disabled="disabled">
              <option v-for="p in antigravityPerms" :key="p" :value="p">{{ permLabel(p) }}</option>
            </select>
          </label>
          <p v-if="antigravityDanger" class="danger">{{ t('tiger.stageConfig.dangerAntigravity') }}</p>
        </fieldset>
      </div>

      <label class="parallel">
        <input v-model="parallel" type="checkbox" :disabled="disabled" />
        <span>{{ t('tiger.stageConfig.runParallel') }}</span>
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
  grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
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

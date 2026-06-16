import type { TigerConfig, TigerStageId, TigerStageRunConfig, TigerState } from '~/types';
import { errText } from '~/lib/apiError';

/** Client store for the Tiger orchestrator. State is kept live by the tiger.state WS push. */
export const useTigerStore = defineStore('tiger', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const state = ref<TigerState | null>(null);
  const config = ref<TigerConfig | null>(null);
  const loaded = ref(false);

  const initialized = computed(() => state.value?.initialized ?? false);
  const busy = computed(() => state.value?.busy ?? false);
  const workspace = computed(() => state.value?.workspace ?? null);

  /** Applied from the WebSocket tiger.state push (live updates during a run). */
  function applyState(s: TigerState) {
    state.value = s;
  }

  async function load() {
    try {
      const [s, c] = await Promise.all([api.getTigerState(), api.getTigerConfig()]);
      state.value = s;
      config.value = c;
      loaded.value = true;
    } catch (e) {
      notices.push(`Tiger: ${errText(e)}`, 'error');
    }
  }

  async function initWorkspace(path: string, projectPrompt: string) {
    try {
      state.value = await api.initTigerWorkspace(path, projectPrompt);
      config.value = await api.getTigerConfig();
      notices.push('Tiger workspace initialized', 'info');
    } catch (e) {
      notices.push(`Initialize failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  async function saveConfig(partial: Partial<TigerConfig>) {
    try {
      config.value = await api.updateTigerConfig(partial);
      notices.push('Configuration saved', 'info');
    } catch (e) {
      notices.push(`Save configuration failed: ${errText(e)}`, 'error');
    }
  }

  async function runStage(stage: TigerStageId, cfg: TigerStageRunConfig) {
    try {
      state.value = await api.runTigerStage(stage, cfg);
    } catch (e) {
      notices.push(`Run failed: ${errText(e)}`, 'error');
    }
  }

  async function retryStage(stage: TigerStageId) {
    try {
      state.value = await api.retryTigerStage(stage);
    } catch (e) {
      notices.push(`Retry failed: ${errText(e)}`, 'error');
    }
  }

  async function stop() {
    try {
      state.value = await api.stopTiger();
    } catch (e) {
      notices.push(`Stop failed: ${errText(e)}`, 'error');
    }
  }

  async function readFile(path: string): Promise<string> {
    const res = await api.readTigerFile(path);
    return res.content;
  }

  return {
    state,
    config,
    loaded,
    initialized,
    busy,
    workspace,
    applyState,
    load,
    initWorkspace,
    saveConfig,
    runStage,
    retryStage,
    stop,
    readFile,
  };
});

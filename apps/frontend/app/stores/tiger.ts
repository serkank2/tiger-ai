import type { TigerConfig, TigerProjectInfo, TigerStageId, TigerStageRunConfig, TigerState } from '~/types';
import { errText } from '~/lib/apiError';

/** Client store for the Tiger orchestrator. State is kept live by the tiger.state WS push. */
export const useTigerStore = defineStore('tiger', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const state = ref<TigerState | null>(null);
  const config = ref<TigerConfig | null>(null);
  const projects = ref<TigerProjectInfo[]>([]);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  const projectsLoading = ref(false);
  const projectsLoadError = ref<string | null>(null);

  const initialized = computed(() => state.value?.initialized ?? false);
  const busy = computed(() => state.value?.busy ?? false);
  const workspace = computed(() => state.value?.workspace ?? null);

  /** Applied from the WebSocket tiger.state push (live updates during a run). */
  function applyState(s: TigerState) {
    state.value = s;
  }

  async function load() {
    loading.value = true;
    try {
      const [s, c] = await Promise.all([api.getTigerState(), api.getTigerConfig()]);
      state.value = s;
      config.value = c;
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      notices.push(`Tiger: ${loadError.value}`, 'error');
    } finally {
      loading.value = false;
    }
  }

  async function loadProjects() {
    projectsLoading.value = true;
    projectsLoadError.value = null;
    try {
      projects.value = await api.listTigerProjects();
    } catch (e) {
      projectsLoadError.value = errText(e);
      notices.push(`Projects: ${projectsLoadError.value}`, 'error');
    } finally {
      projectsLoading.value = false;
    }
  }

  async function initWorkspace(path: string, projectPrompt: string) {
    try {
      state.value = await api.initTigerWorkspace(path, projectPrompt);
      config.value = await api.getTigerConfig();
      await loadProjects();
      notices.push('Project created', 'info');
    } catch (e) {
      notices.push(`Initialize failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  async function replaceProjectPrompt(projectPrompt: string) {
    try {
      state.value = await api.replaceTigerProjectPrompt(projectPrompt);
      notices.push('Project prompt updated', 'info');
    } catch (e) {
      notices.push(`Project prompt update failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  async function openProject(path: string) {
    try {
      state.value = await api.openTigerProject(path);
      config.value = await api.getTigerConfig();
    } catch (e) {
      notices.push(`Open failed: ${errText(e)}`, 'error');
    }
  }

  async function closeProject() {
    try {
      state.value = await api.closeTigerProject();
      await loadProjects();
    } catch (e) {
      notices.push(`Close failed: ${errText(e)}`, 'error');
    }
  }

  async function forgetProject(path: string) {
    try {
      projects.value = await api.forgetTigerProject(path);
    } catch (e) {
      notices.push(`Forget failed: ${errText(e)}`, 'error');
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

  async function runStage(stage: TigerStageId, cfg: TigerStageRunConfig, auto = false) {
    try {
      state.value = await api.runTigerStage(stage, cfg, auto);
    } catch (e) {
      notices.push(`Run failed: ${errText(e)}`, 'error');
    }
  }

  async function runAll(configs: Partial<Record<TigerStageId, TigerStageRunConfig>>, fromStage?: TigerStageId) {
    try {
      state.value = await api.runAllTiger(configs, fromStage);
    } catch (e) {
      notices.push(`Run all failed: ${errText(e)}`, 'error');
    }
  }

  async function retryStage(stage: TigerStageId) {
    try {
      state.value = await api.retryTigerStage(stage);
    } catch (e) {
      notices.push(`Retry failed: ${errText(e)}`, 'error');
    }
  }

  async function continueStage(stage: TigerStageId) {
    try {
      state.value = await api.continueTigerStage(stage);
      notices.push('Continuing despite failures', 'info');
    } catch (e) {
      notices.push(`Continue failed: ${errText(e)}`, 'error');
    }
  }

  async function routeCorrection(target: 'executing-plan' | 'task-review') {
    try {
      state.value = await api.routeTigerCorrection(target);
      notices.push(`Routed correction back to ${target}`, 'info');
    } catch (e) {
      notices.push(`Route failed: ${errText(e)}`, 'error');
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
    projects,
    loaded,
    loading,
    loadError,
    projectsLoading,
    projectsLoadError,
    initialized,
    busy,
    workspace,
    applyState,
    load,
    loadProjects,
    openProject,
    closeProject,
    forgetProject,
    initWorkspace,
    replaceProjectPrompt,
    saveConfig,
    runStage,
    runAll,
    retryStage,
    continueStage,
    routeCorrection,
    stop,
    readFile,
  };
});

import { computed, ref, watch } from 'vue';
import { defineStore } from 'pinia';
import { useApi } from '~/composables/useApi';
import { useSocket } from '~/composables/useSocket';
import { useConnectionStore } from '~/stores/connection';
import { useNoticesStore } from '~/stores/notices';
import { errText } from '~/lib/apiError';
import type {
  CreateTeamRunResponse,
  RoleTemplate,
  SteerResponse,
  SteeringDirective,
  TeamArtifact,
  TeamChanges,
  TeamMessage,
  TeamMessageEvent,
  TeamMessageHistoryParams,
  TeamMessagePage,
  TeamRun,
  TeamRunState,
  TeamRunStateResponse,
  TeamRunStartInput,
  TeamStateEvent,
  TeamSteeringInput,
  TeamTemplate,
  TeamTemplatePayload,
  TeamTemplatesResponse,
} from '~/types';

const DEFAULT_MESSAGE_LIMIT = 50;

function messageTime(message: TeamMessage): number {
  const ts = Date.parse(message.createdAt);
  return Number.isFinite(ts) ? ts : 0;
}

function compareMessages(a: TeamMessage, b: TeamMessage): number {
  const aSeq = typeof a.seq === 'number' ? a.seq : Number.POSITIVE_INFINITY;
  const bSeq = typeof b.seq === 'number' ? b.seq : Number.POSITIVE_INFINITY;
  if (aSeq !== bSeq) return aSeq - bSeq;
  return messageTime(a) - messageTime(b) || a.id.localeCompare(b.id);
}

function uniqueMessages(items: TeamMessage[]): TeamMessage[] {
  const byId = new Map<string, TeamMessage>();
  for (const item of items) {
    if (item.id) byId.set(item.id, item);
  }
  return [...byId.values()].sort(compareMessages);
}

type TemplateResponse = TeamTemplatesResponse | TeamTemplate[];
type StateResponse =
  | TeamRunState
  | TeamRunStateResponse
  | CreateTeamRunResponse
  | { activeRun?: TeamRunState | null };
type SteeringResponse = TeamRunState | TeamRunStateResponse | SteerResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object';
}

function stateFromRun(run: TeamRun): TeamRunState {
  return {
    id: run.id,
    name: run.name,
    goal: run.goal,
    status: run.status,
    roles: run.roles.map((role) => ({
      id: role.id,
      name: role.name,
      tool: role.agent.tool,
      status: role.status,
      canWriteCode: role.canWriteCode,
      requiredForSignoff: role.requiredForSignoff,
      signedOff: role.signedOff,
      statusNote: role.statusNote,
    })),
    doneGate: run.doneGate,
    messageCount: run.messageSeq,
    recentMessages: [],
    pendingSteering: [],
    updatedAt: run.updatedAt,
  };
}

function normalizeTemplatesResponse(response: TemplateResponse): { teams: TeamTemplate[]; roles: RoleTemplate[] } {
  return Array.isArray(response) ? { teams: response, roles: [] } : response;
}

function normalizeStateResponse(response: StateResponse | SteeringResponse | null | undefined): TeamRunState | null {
  if (!response) return null;
  if (!isRecord(response)) return null;
  const record = response as Record<string, unknown>;
  if (isRecord(record.state)) return record.state as unknown as TeamRunState;
  if (isRecord(record.run)) return stateFromRun(record.run as unknown as TeamRun);
  if (record.activeRun === null || isRecord(record.activeRun)) {
    return (record.activeRun as TeamRunState | null) ?? null;
  }
  if (typeof record.id === 'string' && typeof record.status === 'string') return record as unknown as TeamRunState;
  return null;
}

function normalizeMessagePage(response: TeamMessagePage | TeamMessage[]): TeamMessagePage {
  return Array.isArray(response) ? { items: response, nextCursor: null, hasMore: false } : response;
}

export const useTeamStore = defineStore('team', () => {
  const api = useApi();
  const notices = useNoticesStore();

  const templates = ref<TeamTemplate[]>([]);
  const roleTemplates = ref<RoleTemplate[]>([]);
  const projects = ref<string[]>([]);
  const lastWorkspace = ref<string | null>(null);
  const state = ref<TeamRunState | null>(null);
  const messages = ref<TeamMessage[]>([]);
  const artifacts = ref<TeamArtifact[]>([]);
  const changes = ref<TeamChanges | null>(null);
  const changesLoading = ref(false);
  const transcriptRunId = ref<string | null>(null);
  const nextCursor = ref<string | null>(null);
  const hasMoreMessages = ref(false);
  const loaded = ref(false);
  const templatesLoaded = ref(false);
  const loading = ref(false);
  const templatesLoading = ref(false);
  const transcriptLoading = ref(false);
  const artifactsLoading = ref(false);
  const loadError = ref<string | null>(null);
  const actionError = ref<string | null>(null);
  const busyKeys = ref<Record<string, boolean>>({});
  let unbindTeamState: (() => void) | null = null;
  let unbindTeamMessage: (() => void) | null = null;
  let unwatchConnection: (() => void) | null = null;

  const activeRun = computed(() => state.value);
  const activeRunId = computed(() => state.value?.id ?? null);
  const runs = computed(() => (state.value ? [state.value] : []));
  const roles = computed(() => state.value?.roles ?? []);
  const turns = computed(() => [] as never[]);
  const directives = computed(() => state.value?.pendingSteering ?? []);
  const verifications = computed(() => [] as never[]);
  const signOffs = computed(() => [] as never[]);
  const busy = computed(() => Object.keys(busyKeys.value).length > 0);

  function setBusy(key: string, value: boolean): void {
    const next = { ...busyKeys.value };
    if (value) next[key] = true;
    else delete next[key];
    busyKeys.value = next;
  }

  function isBusy(key: string): boolean {
    return !!busyKeys.value[key];
  }

  function resetTranscript(runId: string | null): void {
    transcriptRunId.value = runId;
    messages.value = [];
    nextCursor.value = null;
    hasMoreMessages.value = false;
  }

  function ensureTranscriptRun(runId: string): void {
    if (transcriptRunId.value !== runId) resetTranscript(runId);
  }

  function mergeMessages(runId: string, incoming: TeamMessage[]): void {
    ensureTranscriptRun(runId);
    messages.value = uniqueMessages([
      ...messages.value,
      ...incoming.filter((message) => message.runId === runId),
    ]);
  }

  function replaceMessages(runId: string, page: TeamMessagePage): void {
    transcriptRunId.value = runId;
    messages.value = uniqueMessages(page.items.filter((message) => message.runId === runId));
    nextCursor.value = page.nextCursor ?? null;
    hasMoreMessages.value = Boolean(page.hasMore || page.nextCursor);
  }

  function appendMessage(message: TeamMessage): boolean {
    if (!message?.id || !message.runId) return false;
    const currentRunId = activeRunId.value ?? transcriptRunId.value;
    if (currentRunId && message.runId !== currentRunId) return false;
    ensureTranscriptRun(message.runId);
    const before = messages.value.length;
    mergeMessages(message.runId, [message]);
    return messages.value.length > before;
  }

  function applyState(next: TeamRunState): void {
    const previousRunId = activeRunId.value;
    state.value = next;
    loaded.value = true;
    loadError.value = null;

    const nextRunId = next.id;
    if (nextRunId && transcriptRunId.value && transcriptRunId.value !== nextRunId) resetTranscript(nextRunId);
    if (nextRunId && !transcriptRunId.value) transcriptRunId.value = nextRunId;
    if (previousRunId && previousRunId !== nextRunId && transcriptRunId.value === previousRunId) resetTranscript(nextRunId);

    if (Array.isArray(next.recentMessages)) mergeMessages(nextRunId, next.recentMessages);
  }

  function recordFailure(prefix: string, error: unknown): void {
    const message = errText(error);
    actionError.value = message;
    notices.push(`${prefix}: ${message}`, 'error');
  }

  function currentRunOrThrow(runId?: string): string {
    const id = runId ?? activeRunId.value;
    if (!id) throw new Error('No active Team run');
    return id;
  }

  async function loadTemplates(force = false): Promise<void> {
    if (templatesLoading.value) return;
    if (templatesLoaded.value && !force) return;
    templatesLoading.value = true;
    try {
      const next = normalizeTemplatesResponse(await api.listTeamTemplates() as TemplateResponse);
      templates.value = next.teams;
      roleTemplates.value = next.roles;
      templatesLoaded.value = true;
      loadError.value = null;
    } catch (error) {
      loadError.value = errText(error);
      notices.push(`Team templates: ${loadError.value}`, 'error');
      throw error;
    } finally {
      templatesLoading.value = false;
    }
  }

  async function loadProjects(): Promise<void> {
    try {
      const res = await api.listTeamProjects();
      projects.value = res.projects ?? [];
      lastWorkspace.value = res.lastWorkspace ?? null;
    } catch {
      // Non-fatal: the launcher can still browse to a folder.
    }
  }

  async function createTemplate(payload: TeamTemplatePayload): Promise<TeamTemplate> {
    setBusy('template', true);
    try {
      const { template } = await api.createTeamTemplate(payload);
      await loadTemplates(true);
      notices.push('Team template created', 'info');
      return template;
    } catch (error) {
      recordFailure('Create template failed', error);
      throw error;
    } finally {
      setBusy('template', false);
    }
  }

  async function updateTemplate(id: string, payload: TeamTemplatePayload): Promise<TeamTemplate> {
    setBusy('template', true);
    try {
      const { template } = await api.updateTeamTemplate(id, payload);
      await loadTemplates(true);
      notices.push('Team template saved', 'info');
      return template;
    } catch (error) {
      recordFailure('Save template failed', error);
      throw error;
    } finally {
      setBusy('template', false);
    }
  }

  async function duplicateTemplate(id: string, name?: string): Promise<TeamTemplate> {
    setBusy('template', true);
    try {
      const { template } = await api.duplicateTeamTemplate(id, name ? { name } : {});
      await loadTemplates(true);
      notices.push('Team template duplicated', 'info');
      return template;
    } catch (error) {
      recordFailure('Duplicate template failed', error);
      throw error;
    } finally {
      setBusy('template', false);
    }
  }

  async function deleteTemplate(id: string): Promise<void> {
    setBusy('template', true);
    try {
      await api.deleteTeamTemplate(id);
      await loadTemplates(true);
      notices.push('Team template deleted', 'info');
    } catch (error) {
      recordFailure('Delete template failed', error);
      throw error;
    } finally {
      setBusy('template', false);
    }
  }

  async function loadState(): Promise<void> {
    loading.value = true;
    try {
      const next = normalizeStateResponse(await api.getTeamState() as StateResponse);
      if (next) {
        applyState(next);
      } else {
        // No active run server-side: clear any previously-shown run so the view does not keep
        // rendering a stale run (and cannot send stop/resume/steer against a dead run id).
        state.value = null;
        resetTranscript(null);
        loaded.value = true;
      }
      actionError.value = null;
    } catch (error) {
      loadError.value = errText(error);
      notices.push(`Team: ${loadError.value}`, 'error');
      throw error;
    } finally {
      loading.value = false;
    }
  }

  async function loadMessages(options: {
    runId?: string;
    cursor?: string | null;
    limit?: number;
    append?: boolean;
  } = {}): Promise<void> {
    const runId = options.runId ?? activeRunId.value ?? transcriptRunId.value;
    if (!runId) {
      resetTranscript(null);
      return;
    }

    transcriptLoading.value = true;
    try {
      const params: TeamMessageHistoryParams = { limit: options.limit ?? DEFAULT_MESSAGE_LIMIT };
      const cursor = options.cursor ?? (options.append ? nextCursor.value : null);
      if (cursor) params.cursor = cursor;
      const page = normalizeMessagePage(await api.listTeamMessages(runId, params));
      if (options.append) {
        mergeMessages(runId, page.items);
        nextCursor.value = page.nextCursor ?? null;
        hasMoreMessages.value = Boolean(page.hasMore || page.nextCursor);
      } else {
        replaceMessages(runId, page);
      }
      loadError.value = null;
    } catch (error) {
      loadError.value = errText(error);
      notices.push(`Team transcript: ${loadError.value}`, 'error');
      throw error;
    } finally {
      transcriptLoading.value = false;
    }
  }

  async function loadMoreMessages(): Promise<void> {
    if (!hasMoreMessages.value || transcriptLoading.value) return;
    await loadMessages({ append: true });
  }

  async function loadArtifacts(runId = activeRunId.value): Promise<void> {
    if (!runId) {
      artifacts.value = [];
      return;
    }
    artifactsLoading.value = true;
    try {
      artifacts.value = await api.listTeamArtifacts(runId);
    } catch (error) {
      loadError.value = errText(error);
      notices.push(`Team artifacts: ${loadError.value}`, 'error');
      throw error;
    } finally {
      artifactsLoading.value = false;
    }
  }

  /** Load the run's real product changes (git working-tree diff vs HEAD) for the Changes view. */
  async function loadChanges(runId = activeRunId.value): Promise<void> {
    if (!runId) {
      changes.value = null;
      return;
    }
    changesLoading.value = true;
    try {
      changes.value = await api.getTeamChanges(runId);
    } catch (error) {
      loadError.value = errText(error);
      notices.push(`Team changes: ${loadError.value}`, 'error');
      throw error;
    } finally {
      changesLoading.value = false;
    }
  }

  async function hydrate(options: { quiet?: boolean } = {}): Promise<void> {
    loading.value = true;
    try {
      void loadProjects();
      const [templateResponse, stateResponse] = await Promise.all([api.listTeamTemplates(), api.getTeamState()]);
      const nextTemplates = normalizeTemplatesResponse(templateResponse as TemplateResponse);
      templates.value = nextTemplates.teams;
      roleTemplates.value = nextTemplates.roles;
      templatesLoaded.value = true;
      const nextState = normalizeStateResponse(stateResponse as StateResponse);
      if (nextState) applyState(nextState);
      else state.value = null;

      const runId = activeRunId.value;
      if (runId) {
        const [pageResponse, nextArtifacts] = await Promise.all([
          api.listTeamMessages(runId, { limit: DEFAULT_MESSAGE_LIMIT }),
          api.listTeamArtifacts(runId),
        ]);
        const page = normalizeMessagePage(pageResponse);
        replaceMessages(runId, page);
        artifacts.value = nextArtifacts;
      } else {
        resetTranscript(null);
        artifacts.value = [];
      }

      loaded.value = true;
      loadError.value = null;
      actionError.value = null;
    } catch (error) {
      loadError.value = errText(error);
      if (!options.quiet) notices.push(`Team: ${loadError.value}`, 'error');
      throw error;
    } finally {
      loading.value = false;
    }
  }

  async function start(input: TeamRunStartInput): Promise<TeamRunState> {
    setBusy('start', true);
    actionError.value = null;
    try {
      const next = normalizeStateResponse(await api.startTeamRun(input) as StateResponse);
      if (!next) throw new Error('Team start did not return a run state');
      applyState(next);
      const runId = activeRunId.value;
      if (runId) {
        resetTranscript(runId);
        await Promise.all([
          loadMessages({ runId }),
          loadArtifacts(runId),
        ]);
      }
      notices.push('Team run started', 'info');
      return next;
    } catch (error) {
      recordFailure('Team start failed', error);
      throw error;
    } finally {
      setBusy('start', false);
    }
  }

  async function control(action: 'stop' | 'pause' | 'resume' | 'close', runId?: string): Promise<TeamRunState> {
    const key = `${action}:${runId ?? activeRunId.value ?? 'active'}`;
    setBusy(key, true);
    actionError.value = null;
    try {
      const id = currentRunOrThrow(runId);
      const response =
        action === 'stop'
          ? await api.stopTeamRun(id)
          : action === 'pause'
            ? await api.pauseTeamRun(id)
            : action === 'resume'
              ? await api.resumeTeamRun(id)
              : await api.closeTeamRun(id);
      const next = normalizeStateResponse(response as StateResponse);
      if (!next) throw new Error(`Team ${action} did not return a run state`);
      applyState(next);
      const verb =
        action === 'pause' ? 'paused' : action === 'resume' ? 'resumed' : action === 'close' ? 'closed' : 'stopped';
      notices.push(`Team run ${verb}`, 'info');
      return next;
    } catch (error) {
      recordFailure(`Team ${action} failed`, error);
      throw error;
    } finally {
      setBusy(key, false);
    }
  }

  async function steer(input: TeamSteeringInput | string, runId?: string): Promise<TeamRunState> {
    const key = `steer:${runId ?? activeRunId.value ?? 'active'}`;
    setBusy(key, true);
    actionError.value = null;
    try {
      const id = currentRunOrThrow(runId);
      const body = typeof input === 'string' ? { body: input } : input;
      const response = await api.steerTeamRun(id, body);
      const next = normalizeStateResponse(response as SteeringResponse);
      if (next) applyState(next);
      else if (isRecord(response) && isRecord((response as SteerResponse).directive) && state.value) {
        state.value = {
          ...state.value,
          pendingSteering: [...state.value.pendingSteering, (response as SteerResponse).directive as SteeringDirective],
        };
      }
      if (!state.value) throw new Error('Team steering did not return a run state');
      notices.push('Message sent to the Lead', 'info');
      return state.value;
    } catch (error) {
      recordFailure('Message to the Lead failed', error);
      throw error;
    } finally {
      setBusy(key, false);
    }
  }

  function bindSocket(): () => void {
    if (!unbindTeamState || !unbindTeamMessage) {
      const socket = useSocket();
      unbindTeamState = socket.onServerEvent('team.state', (msg) => {
        const next = (msg as unknown as TeamStateEvent).state;
        if (next) applyState(next);
      });
      unbindTeamMessage = socket.onServerEvent('team.message', (msg) => {
        const message = (msg as unknown as TeamMessageEvent).message;
        if (message) appendMessage(message);
      });
    }

    if (!unwatchConnection) {
      const connection = useConnectionStore();
      unwatchConnection = watch(
        () => connection.status,
        (status, previous) => {
          if (status === 'connected' && previous !== 'connected' && loaded.value) {
            void hydrate({ quiet: true }).catch(() => {});
          }
        },
      );
    }

    return () => {
      unbindTeamState?.();
      unbindTeamMessage?.();
      unwatchConnection?.();
      unbindTeamState = null;
      unbindTeamMessage = null;
      unwatchConnection = null;
    };
  }

  const stop = (runId?: string) => control('stop', runId);
  const pause = (runId?: string) => control('pause', runId);
  const resume = (runId?: string) => control('resume', runId);
  const close = (runId?: string) => control('close', runId);

  return {
    templates,
    roleTemplates,
    projects,
    lastWorkspace,
    state,
    messages,
    artifacts,
    changes,
    changesLoading,
    transcriptRunId,
    nextCursor,
    hasMoreMessages,
    loaded,
    templatesLoaded,
    loading,
    templatesLoading,
    transcriptLoading,
    artifactsLoading,
    loadError,
    actionError,
    busyKeys,
    activeRun,
    activeRunId,
    runs,
    roles,
    turns,
    directives,
    verifications,
    signOffs,
    busy,
    isBusy,
    applyState,
    appendMessage,
    loadTemplates,
    loadProjects,
    createTemplate,
    updateTemplate,
    duplicateTemplate,
    deleteTemplate,
    loadState,
    loadChanges,
    loadMessages,
    loadMoreMessages,
    loadArtifacts,
    hydrate,
    start,
    startRun: start,
    stop,
    stopRun: stop,
    pause,
    pauseRun: pause,
    resume,
    resumeRun: resume,
    close,
    closeRun: close,
    steer,
    steerRun: steer,
    bindSocket,
  };
});

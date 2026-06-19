import type { AppSettings } from '~/types';
import { errText } from '~/lib/apiError';

/**
 * Client-only auth token for the optional backend shared-token auth
 * (`KAPLAN_AUTH_TOKEN`). It is NOT part of server-backed {@link AppSettings} — it
 * is the credential used to talk to the server, so it lives in localStorage and is
 * read directly (synchronously, without a Pinia instance) by useApi/useSocket when
 * they build each request/connection.
 */
const AUTH_TOKEN_KEY = 'kaplan.authToken';

/** Read the persisted auth token (empty string when unset or unavailable). */
export function getStoredAuthToken(): string {
  if (typeof localStorage === 'undefined') return '';
  try {
    return localStorage.getItem(AUTH_TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Persist (or clear, when empty) the auth token to localStorage. */
function persistAuthToken(token: string): void {
  if (typeof localStorage === 'undefined') return;
  try {
    if (token) localStorage.setItem(AUTH_TOKEN_KEY, token);
    else localStorage.removeItem(AUTH_TOKEN_KEY);
  } catch {
    /* ignore quota / privacy-mode failures — auth just falls back to unset */
  }
}

export const useSettingsStore = defineStore('settings', () => {
  const api = useApi();
  const notices = useNoticesStore();
  const settings = ref<AppSettings | null>(null);
  const loaded = ref(false);
  const loading = ref(false);
  const loadError = ref<string | null>(null);
  // Client-persisted shared-token auth credential (see getStoredAuthToken above).
  const authToken = ref<string>(getStoredAuthToken());

  async function load() {
    loading.value = true;
    try {
      settings.value = await api.getSettings();
      loaded.value = true;
      loadError.value = null;
    } catch (e) {
      loadError.value = errText(e);
      notices.push(`Load settings failed: ${loadError.value}`, 'error');
      throw e;
    } finally {
      loading.value = false;
    }
  }
  async function update(patch: Partial<AppSettings>) {
    try {
      settings.value = await api.updateSettings(patch);
    } catch (e) {
      notices.push(`Save settings failed: ${errText(e)}`, 'error');
      throw e;
    }
  }

  /** Set (or clear) the auth token used for backend shared-token auth and persist it. */
  function setAuthToken(token: string) {
    const next = token.trim();
    if (next === authToken.value) return;
    authToken.value = next;
    persistAuthToken(next);
    // The live WS only carries its token on the handshake, so reconnect to apply the
    // new (or cleared) credential immediately — REST already picks it up per request.
    // Lazily resolve useSocket so the store stays usable without a live transport (tests).
    try {
      useSocket().reconnect();
    } catch {
      /* no socket transport available (e.g. SSR / unit tests) — skip */
    }
  }

  return { settings, loaded, loading, loadError, authToken, load, update, setAuthToken };
});

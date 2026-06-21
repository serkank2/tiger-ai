// Per-conversation TR/EN translation for the Team chat. Display-only: the team's
// agents always work in English (enforced server-side) — this only changes what the
// human READS. Nothing here ever feeds back into what is sent to the backend.
//
// Design:
//   - `chatLang` is the active reading language ('original' = raw English bodies, no
//     request; 'tr'/'en' = translate on display). Persisted to localStorage.
//   - `cache` is a reactive Map keyed by `${messageId}:${lang}` -> translated body.
//     Rendering looks up this map; a miss falls back to the original body (never blank).
//   - New/untranslated bodies are queued, debounced (~400ms), de-duplicated, and sent
//     in batched requests (≤100 texts each). `translating` is true while any batch is
//     in flight, for a subtle indicator.
//
// This is a factory (NOT an app-wide singleton composable): TeamChatPanel owns one
// instance for the lifetime of the panel, so its debounce timer/queue are scoped and
// torn down with the component.
import { computed, ref, shallowRef, triggerRef } from 'vue';
import { useApi } from '~/composables/useApi';

export type ChatLang = 'original' | 'tr' | 'en';

/** localStorage key for the persisted per-conversation reading language. */
export const CHAT_LANG_STORAGE_KEY = 'kaplan.team.chatLang';

const DEBOUNCE_MS = 400;
const MAX_BATCH = 100;

function isChatLang(value: string | null | undefined): value is ChatLang {
  return value === 'original' || value === 'tr' || value === 'en';
}

function readStoredLang(): ChatLang {
  if (typeof localStorage === 'undefined') return 'original';
  try {
    const raw = localStorage.getItem(CHAT_LANG_STORAGE_KEY);
    return isChatLang(raw) ? raw : 'original';
  } catch {
    return 'original';
  }
}

function persistLang(lang: ChatLang): void {
  if (typeof localStorage === 'undefined') return;
  try {
    localStorage.setItem(CHAT_LANG_STORAGE_KEY, lang);
  } catch {
    /* ignore quota / privacy-mode failures — choice just won't persist */
  }
}

/** A chat message as far as translation cares: a stable id + the displayed body. */
export interface TranslatableMessage {
  id: string;
  body: string;
}

export function useTeamTranslation(onError?: (message: string) => void) {
  const api = useApi();

  const chatLang = ref<ChatLang>(readStoredLang());
  // Translated bodies keyed by `${messageId}:${lang}`. shallowRef + manual trigger keeps
  // mutation cheap (no deep proxy over potentially hundreds of strings).
  const cache = shallowRef(new Map<string, string>());
  // Number of in-flight batches; >0 drives the "translating…" indicator.
  const inFlight = ref(0);
  const translating = computed(() => inFlight.value > 0);

  // Ids whose body for the active (non-original) lang still needs fetching. A Set so
  // repeated requests collapse; cleared as each batch is dispatched.
  let pending = new Map<string, string>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  function key(id: string, lang: ChatLang): string {
    return `${id}:${lang}`;
  }

  /** The body to show for a message under the active language (original on a miss). */
  function displayBody(message: TranslatableMessage): string {
    if (chatLang.value === 'original') return message.body;
    return cache.value.get(key(message.id, chatLang.value)) ?? message.body;
  }

  function hasTranslation(id: string): boolean {
    if (chatLang.value === 'original') return true;
    return cache.value.has(key(id, chatLang.value));
  }

  async function flush(lang: ChatLang): Promise<void> {
    if (lang === 'original') {
      pending = new Map();
      return;
    }
    if (!pending.size) return;
    // Snapshot + clear the queue so messages arriving mid-request re-queue for the next pass.
    const batchEntries = [...pending.entries()];
    pending = new Map();

    for (let i = 0; i < batchEntries.length; i += MAX_BATCH) {
      const slice = batchEntries.slice(i, i + MAX_BATCH);
      const ids = slice.map(([id]) => id);
      const texts = slice.map(([, body]) => body);
      inFlight.value += 1;
      try {
        const { translations } = await api.translateTeamMessages(texts, lang);
        const map = cache.value;
        ids.forEach((id, idx) => {
          const translated = translations[idx];
          // Guard against a short/blank response: only cache a real string, else leave the
          // original to show (displayBody falls back on a miss — never blank).
          if (typeof translated === 'string' && translated.length > 0) {
            map.set(key(id, lang), translated);
          }
        });
        triggerRef(cache);
      } catch (error) {
        onError?.(error instanceof Error ? error.message : 'Translation failed');
        // Leave these ids untranslated; the originals keep showing. They'll re-queue if
        // the user toggles language again or the message set is re-scanned.
      } finally {
        inFlight.value -= 1;
      }
    }
  }

  function scheduleFlush(): void {
    if (timer) clearTimeout(timer);
    const lang = chatLang.value;
    timer = setTimeout(() => {
      timer = null;
      void flush(lang);
    }, DEBOUNCE_MS);
  }

  /**
   * Ensure the given messages are translated for the active language. Cheap to call on
   * every render/arrival: already-cached or already-queued ids are skipped, and the
   * actual request is debounced + batched. No-op when the active lang is 'original'.
   */
  function ensureTranslations(items: TranslatableMessage[]): void {
    const lang = chatLang.value;
    if (lang === 'original') return;
    let queued = false;
    for (const m of items) {
      if (!m.id || !m.body) continue;
      if (cache.value.has(key(m.id, lang))) continue;
      if (pending.has(m.id)) continue;
      pending.set(m.id, m.body);
      queued = true;
    }
    if (queued) scheduleFlush();
  }

  /** Switch the active reading language. Persists the choice; 'original' is instant. */
  function setChatLang(lang: ChatLang, items: TranslatableMessage[]): void {
    if (lang === chatLang.value) return;
    chatLang.value = lang;
    persistLang(lang);
    // Drop any queue aimed at the old language; the new one re-scans below.
    pending = new Map();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    if (lang !== 'original') ensureTranslations(items);
  }

  function dispose(): void {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    pending = new Map();
  }

  return {
    chatLang,
    translating,
    displayBody,
    hasTranslation,
    ensureTranslations,
    setChatLang,
    dispose,
  };
}

import { Terminal, type IDisposable } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { WebLinksAddon } from '@xterm/addon-web-links';
import type { Ref } from 'vue';

/**
 * Manages one xterm.js instance bound to a (reactive) terminal id, in the given host
 * element: mount, attach over WS, snapshot-reset, live output, keyboard input, resize,
 * theme, and dispose. Used by both the single Focus pane and each Grid tile.
 *
 * A monotonic mount token guards overlapping async mounts when the id changes rapidly.
 * Resize is only sent to the backend when dimensions actually change (rAF-throttled),
 * so grid relayout doesn't burst resize frames. `compact` trims tiles (lower scrollback,
 * no web-links addon). The terminal recolors live when the theme changes.
 */
export function useTerminalView(
  host: Ref<HTMLElement | null>,
  termId: Ref<string | null>,
  opts: { focusOnMount?: boolean; compact?: boolean } = {},
) {
  const socket = useSocket();
  const terminals = useTerminalsStore();
  const theme = useThemeStore();

  let term: Terminal | null = null;
  let fit: FitAddon | null = null;
  let offOutput: (() => void) | null = null;
  let offSnapshot: (() => void) | null = null;
  let onData: IDisposable | null = null;
  let onResize: IDisposable | null = null;
  let ro: ResizeObserver | null = null;
  let mousedown: (() => void) | null = null;
  let mountedHost: HTMLElement | null = null;
  let mountedId: string | null = null;
  let mountToken = 0;
  let rafId: number | null = null;
  let lastCols = 0;
  let lastRows = 0;

  function teardown() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (mountedId) socket.detach(mountedId);
    if (mousedown && mountedHost) mountedHost.removeEventListener('mousedown', mousedown);
    offOutput?.();
    offSnapshot?.();
    onData?.dispose();
    onResize?.dispose();
    ro?.disconnect();
    term?.dispose();
    offOutput = offSnapshot = onData = onResize = ro = term = fit = mousedown = mountedHost = null;
    mountedId = null;
  }

  function safeFit() {
    try {
      fit?.fit();
    } catch {
      /* element not measurable yet */
    }
  }
  function scheduleFit() {
    if (rafId != null) return;
    rafId = requestAnimationFrame(() => {
      rafId = null;
      safeFit();
    });
  }
  /** Send resize to the backend only when the dimensions actually changed. */
  function sendResize(id: string) {
    if (!term) return;
    if (term.cols !== lastCols || term.rows !== lastRows) {
      lastCols = term.cols;
      lastRows = term.rows;
      socket.resize(id, term.cols, term.rows);
    }
  }
  function isTypingElsewhere(): boolean {
    const el = document.activeElement as HTMLElement | null;
    return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable);
  }

  async function mount(id: string) {
    const token = ++mountToken;
    teardown();
    await nextTick();
    if (token !== mountToken || !host.value) return;

    const t = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', ui-monospace, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: opts.compact ? 1500 : 8000,
      theme: theme.xterm,
      allowProposedApi: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    if (!opts.compact) t.loadAddon(new WebLinksAddon());
    t.open(host.value);

    term = t;
    fit = f;
    mountedId = id;
    mountedHost = host.value;
    lastCols = 0;
    lastRows = 0;

    safeFit();
    offSnapshot = socket.onSnapshot(id, (data) => {
      t.reset();
      t.write(data);
    });
    offOutput = socket.onOutput(id, (data) => t.write(data));
    onData = t.onData((data) => socket.input(id, data));
    onResize = t.onResize(() => sendResize(id));
    mousedown = () => terminals.setActive(id);
    mountedHost.addEventListener('mousedown', mousedown);
    sendResize(id); // initial size hint

    await nextTick();
    if (token !== mountToken) return;
    safeFit();
    sendResize(id); // corrected size once the element has real layout
    // Attach AFTER the pty has been told the real size, so the replayed snapshot
    // is rendered at the correct dimensions (no corruption in grid under paint latency).
    socket.attach(id);
    if (opts.focusOnMount && !isTypingElsewhere()) t.focus();

    ro = new ResizeObserver(() => {
      if (token === mountToken) scheduleFit();
    });
    ro.observe(host.value);
  }

  watch(termId, (id) => {
    if (id) void mount(id);
    else {
      mountToken++;
      teardown();
    }
  });
  // live recolor when the theme changes
  watch(
    () => theme.id,
    () => {
      if (term) term.options.theme = theme.xterm;
    },
  );

  onMounted(() => {
    if (termId.value) void mount(termId.value);
  });
  onBeforeUnmount(() => {
    mountToken++;
    teardown();
  });
}

import type { IDisposable, Terminal as XTermTerminal } from '@xterm/xterm';
import type { FitAddon as XTermFitAddon } from '@xterm/addon-fit';
import type { WebglAddon as XTermWebglAddon } from '@xterm/addon-webgl';
import type { Ref } from 'vue';

let xtermCorePromise: Promise<
  readonly [typeof import('@xterm/xterm'), typeof import('@xterm/addon-fit')]
> | null = null;
let webLinksAddonPromise: Promise<typeof import('@xterm/addon-web-links')> | null = null;
let webglAddonPromise: Promise<typeof import('@xterm/addon-webgl')> | null = null;
// Once WebGL context creation has failed (no GPU, blocklisted driver, too many live
// contexts), don't keep retrying it per terminal — fall back to the DOM renderer.
let webglUnavailable = false;

function loadXtermCore() {
  xtermCorePromise ??= Promise.all([import('@xterm/xterm'), import('@xterm/addon-fit')]);
  return xtermCorePromise;
}

function loadWebLinksAddon() {
  webLinksAddonPromise ??= import('@xterm/addon-web-links');
  return webLinksAddonPromise;
}

function loadWebglAddon() {
  webglAddonPromise ??= import('@xterm/addon-webgl');
  return webglAddonPromise;
}

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

  let term: XTermTerminal | null = null;
  let fit: XTermFitAddon | null = null;
  let webgl: XTermWebglAddon | null = null;
  let offWebglContextLoss: IDisposable | null = null;
  let offOutput: (() => void) | null = null;
  let offSnapshot: (() => void) | null = null;
  let onData: IDisposable | null = null;
  let onResize: IDisposable | null = null;
  let ro: ResizeObserver | null = null;
  let mousedown: (() => void) | null = null;
  let mountedHost: HTMLElement | null = null;
  let attachedId: string | null = null; // set only AFTER socket.attach — detach only this (correct ref-count)
  let mountToken = 0;
  let rafId: number | null = null;
  let lastCols = 0;
  let lastRows = 0;

  function teardown() {
    if (rafId != null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    if (attachedId) socket.detach(attachedId); // only detach what we actually attached
    if (mousedown && mountedHost) mountedHost.removeEventListener('mousedown', mousedown);
    offOutput?.();
    offSnapshot?.();
    onData?.dispose();
    onResize?.dispose();
    offWebglContextLoss?.dispose();
    // Dispose the WebGL addon before the terminal so its GL context is released
    // (browsers cap live contexts; leaking them breaks renderers across the grid).
    webgl?.dispose();
    ro?.disconnect();
    term?.dispose();
    offOutput = offSnapshot = onData = onResize = offWebglContextLoss = ro = term = fit = webgl = mousedown = mountedHost = null;
    attachedId = null;
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

  /**
   * Try to attach the WebGL renderer for GPU-accelerated drawing. Falls back silently
   * to xterm's default DOM renderer if the addon can't be loaded or the GL context
   * can't be created. On a later context loss (e.g. GPU reset, tab backgrounded), the
   * addon is disposed so xterm reverts to the DOM renderer instead of rendering blank.
   */
  async function attachWebgl(t: XTermTerminal): Promise<void> {
    if (webglUnavailable) return;
    let WebglAddon: typeof XTermWebglAddon;
    try {
      ({ WebglAddon } = await loadWebglAddon());
    } catch {
      webglUnavailable = true; // module failed to load — don't retry per terminal
      return;
    }
    if (t !== term) return; // superseded while loading
    try {
      const addon = new WebglAddon();
      offWebglContextLoss = addon.onContextLoss(() => {
        offWebglContextLoss?.dispose();
        offWebglContextLoss = null;
        addon.dispose(); // releases the GL context; xterm falls back to DOM renderer
        if (webgl === addon) webgl = null;
      });
      t.loadAddon(addon); // throws synchronously if the GL context can't be created
      webgl = addon;
    } catch {
      // No WebGL context available (headless, blocklisted driver, context limit).
      offWebglContextLoss?.dispose();
      offWebglContextLoss = null;
      webgl = null;
      webglUnavailable = true;
    }
  }

  async function mount(id: string) {
    const token = ++mountToken;
    teardown();
    await nextTick();
    if (token !== mountToken || !host.value) return;

    const [{ Terminal }, { FitAddon }] = await loadXtermCore();
    if (token !== mountToken || !host.value) return;

    const t = new Terminal({
      cursorBlink: true,
      fontFamily: "'Cascadia Code', 'JetBrains Mono', ui-monospace, Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      scrollback: opts.compact ? 1500 : 8000,
      theme: theme.xterm,
      allowProposedApi: true,
      // Expose terminal output to screen readers via xterm's live-region buffer.
      screenReaderMode: true,
    });
    const f = new FitAddon();
    t.loadAddon(f);
    if (!opts.compact) {
      const { WebLinksAddon } = await loadWebLinksAddon();
      if (token !== mountToken || !host.value) {
        t.dispose();
        return;
      }
      t.loadAddon(new WebLinksAddon());
    }
    t.open(host.value);

    term = t;
    fit = f;
    mountedHost = host.value;
    lastCols = 0;
    lastRows = 0;

    // Upgrade to the GPU renderer once the terminal is open (needs its screen element).
    // Awaited so the snapshot below paints on whichever renderer ends up active.
    await attachWebgl(t);
    if (token !== mountToken || !host.value) return;

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
    attachedId = id; // attach succeeded — teardown may now detach it
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

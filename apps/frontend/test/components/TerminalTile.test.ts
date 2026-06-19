import { mount } from '@vue/test-utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { nextTick, ref, computed, onMounted, onBeforeUnmount } from 'vue';
import type { Ref } from 'vue';
import type { TerminalDto } from '~/types';

// TerminalTile relies on Nuxt auto-imports for Vue APIs, the store, and the
// useTerminalView composable. The vitest harness has no Nuxt auto-import plugin,
// so we expose them as globals (mirroring what Nuxt injects) and mock the two
// app-level dependencies. We capture the id ref handed to useTerminalView so we
// can assert the virtualization gate (real id when on-screen, null when suspended).
const captured = vi.hoisted(() => ({ liveId: null as Ref<string | null> | null }));
const store = vi.hoisted(() => ({ activeId: null as string | null, setActive: vi.fn(), start: vi.fn(), stop: vi.fn(), restart: vi.fn(), layoutMode: 'grid' }));

vi.mock('~/composables/useTerminalView', () => ({
  useTerminalView: (_host: unknown, id: Ref<string | null>) => {
    captured.liveId = id;
  },
}));
vi.mock('~/stores/terminals', () => ({ useTerminalsStore: () => store }));

// Drive the IntersectionObserver manually so a test can flip a tile on/off screen.
let ioCb: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
class FakeIO {
  constructor(cb: (entries: { isIntersecting: boolean }[]) => void) {
    ioCb = cb;
  }
  observe() {}
  disconnect() {}
}

beforeEach(() => {
  // Expose the auto-imports the component expects as globals.
  Object.assign(globalThis, {
    ref,
    computed,
    onMounted,
    onBeforeUnmount,
    useTerminalsStore: () => store,
    useTerminalView: (_host: unknown, id: Ref<string | null>) => {
      captured.liveId = id;
    },
  });
  (globalThis as unknown as { IntersectionObserver: unknown }).IntersectionObserver = FakeIO;
  store.activeId = null;
  ioCb = null;
  captured.liveId = null;
});

afterEach(() => {
  document.body.innerHTML = '';
});

function term(overrides: Partial<TerminalDto> = {}): TerminalDto {
  return {
    id: 't1',
    name: 'Build',
    groupId: null,
    cwd: 'C:/x',
    shell: { kind: 'system' } as TerminalDto['shell'],
    status: { id: 't1', state: 'running', cols: 80, rows: 24, exitCode: null },
    lastOutput: 'compiling\n$ ready',
    ...overrides,
  } as TerminalDto;
}

async function mountTile(t = term()) {
  const { default: TerminalTile } = await import('~/components/TerminalTile.vue');
  const wrapper = mount(TerminalTile, {
    props: { terminal: t },
    global: { stubs: { StatusDot: true } },
  });
  await nextTick();
  return wrapper;
}

describe('TerminalTile virtualization', () => {
  it('renders a placeholder (no live xterm id) while off-screen', async () => {
    const wrapper = await mountTile();
    // Starts suspended until the IntersectionObserver reports intersection.
    expect(wrapper.find('[data-testid="tile-placeholder"]').exists()).toBe(true);
    expect(wrapper.find('[data-testid="tile-placeholder"]').text()).toContain('ready');
    expect(captured.liveId?.value).toBe(null);
  });

  it('mounts the live xterm id once the tile scrolls into view', async () => {
    const wrapper = await mountTile();
    ioCb?.([{ isIntersecting: true }]);
    await nextTick();
    expect(captured.liveId?.value).toBe('t1');
    expect(wrapper.find('[data-testid="tile-placeholder"]').exists()).toBe(false);
  });

  it('keeps the active tile live even when it scrolls off-screen', async () => {
    store.activeId = 't1';
    const wrapper = await mountTile();
    ioCb?.([{ isIntersecting: false }]);
    await nextTick();
    expect(captured.liveId?.value).toBe('t1');
    expect(wrapper.find('[data-testid="tile-placeholder"]').exists()).toBe(false);
  });
});

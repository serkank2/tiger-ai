import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { reactive } from 'vue';
import type { HandoffDependencySnapshot, RoleSnapshot, TeamTaskWorktreeSnapshot } from '~/types';
import TeamCoordinationPanel from '~/components/team/TeamCoordinationPanel.vue';

// A minimal reactive stand-in for the team store, exposing only what the panel reads.
const store = reactive({
  handoffs: [] as HandoffDependencySnapshot[],
  taskWorktrees: [] as TeamTaskWorktreeSnapshot[],
  roles: [] as RoleSnapshot[],
  readOnly: false,
  busy: {} as Record<string, boolean>,
  isBusy(key: string) {
    return !!store.busy[key];
  },
  mergeWorktree: vi.fn(async () => {}),
});

vi.mock('~/stores/team', () => ({ useTeamStore: () => store }));

const role = (id: string, name: string, inbox = 0): RoleSnapshot => ({
  id,
  name,
  tool: 'codex',
  model: 'gpt-5',
  effort: 'medium',
  permission: 'workspace-write',
  status: 'idle',
  canWriteCode: true,
  requiredForSignoff: true,
  signedOff: false,
  inbox,
});

function reset(): void {
  store.handoffs = [];
  store.taskWorktrees = [];
  store.roles = [];
  store.readOnly = false;
  store.busy = {};
  store.mergeWorktree = vi.fn(async () => {});
}

// Stub BaseButton: in the test env Nuxt auto-imports (computed, etc.) are not available, so
// rendering the real component fails. A button stub keeps clicks + slots working.
const BaseButton = {
  name: 'BaseButton',
  emits: ['click'],
  template: '<button @click="$emit(\'click\', $event)"><slot /></button>',
};
const mountOpts = { global: { stubs: { BaseButton } } } as const;

describe('TeamCoordinationPanel', () => {
  beforeEach(reset);

  it('shows an empty note when there is no coordination activity', () => {
    const wrapper = mount(TeamCoordinationPanel, mountOpts);
    expect(wrapper.text()).toContain('No handoffs');
  });

  it('renders a pending handoff dependency with the from→to flow and task id', () => {
    store.roles = [role('lead', 'Lead'), role('tester', 'Tester')];
    store.handoffs = [
      {
        id: 'h1',
        fromRoleId: 'lead',
        toRoleId: 'tester',
        taskId: 'TASK-0001',
        title: 'Verify login',
        pending: true,
        createdAt: 't0',
      },
    ];
    const wrapper = mount(TeamCoordinationPanel, mountOpts);
    const pending = wrapper.find('[data-testid="handoff-pending"]');
    expect(pending.exists()).toBe(true);
    expect(pending.text()).toContain('Lead → Tester');
    expect(pending.text()).toContain('TASK-0001');
    expect(pending.text()).toContain('blocking');
  });

  it('renders a long handoff title in a wrapping-safe title cell', () => {
    const title = 'Spec: multiple same-kind agent instances with Lead idle-routing and a deliberately long title that must not collide with the task id';
    store.roles = [role('lead', 'Lead / Coordinator'), role('business-analyst', 'Business Analyst')];
    store.handoffs = [
      {
        id: 'h1',
        fromRoleId: 'lead',
        toRoleId: 'business-analyst',
        taskId: 'TASK-0001',
        title,
        pending: true,
        createdAt: 't0',
      },
    ];
    const wrapper = mount(TeamCoordinationPanel, mountOpts);
    const pending = wrapper.find('[data-testid="handoff-pending"]');
    const titleCell = pending.find('.ttl');

    expect(titleCell.text()).toBe(title);
    expect(titleCell.classes()).toContain('ttl');
    expect(getComputedStyle(titleCell.element).whiteSpace).not.toBe('nowrap');
  });

  it('shows per-role inbox counts (sendMessage deliveries)', () => {
    store.roles = [role('lead', 'Lead'), role('dev', 'Developer', 2)];
    const wrapper = mount(TeamCoordinationPanel, mountOpts);
    const rows = wrapper.findAll('[data-testid="inbox-row"]');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.text()).toContain('Developer');
    expect(rows[0]!.text()).toContain('2');
  });

  it('offers Merge/Discard for a kept (conflict) worktree and calls the store action', async () => {
    store.roles = [role('dev', 'Developer')];
    store.taskWorktrees = [
      {
        taskId: 'TASK-0001',
        roleId: 'dev',
        branch: 'kaplan/run-1-TASK-0001',
        status: 'conflict',
        note: 'merge conflict in a.ts',
        createdAt: 't0',
      },
    ];
    const wrapper = mount(TeamCoordinationPanel, mountOpts);
    const mergeBtn = wrapper.find('[data-testid="worktree-merge"]');
    expect(mergeBtn.exists()).toBe(true);
    await mergeBtn.trigger('click');
    expect(store.mergeWorktree).toHaveBeenCalledWith('TASK-0001', false);
  });

  it('hides worktree actions in read-only (history) view', () => {
    store.readOnly = true;
    store.taskWorktrees = [
      { taskId: 'TASK-0001', roleId: 'dev', branch: 'b', status: 'conflict', createdAt: 't0' },
    ];
    const wrapper = mount(TeamCoordinationPanel, mountOpts);
    expect(wrapper.find('[data-testid="worktree-merge"]').exists()).toBe(false);
  });
});

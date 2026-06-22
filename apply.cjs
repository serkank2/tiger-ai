const fs = require('fs');
const path = require('path');

// 1. stores/tiger.ts
let tigerTs = fs.readFileSync('apps/frontend/app/stores/tiger.ts', 'utf-8');
tigerTs = tigerTs.replace(
  'const projectsLoading = ref(false);',
  'const projectsLoading = ref(false);\n  const projectsLoadError = ref<string | null>(null);'
);
tigerTs = tigerTs.replace(
  'projectsLoading.value = true;',
  'projectsLoading.value = true;\n    projectsLoadError.value = null;'
);
tigerTs = tigerTs.replace(
  'notices.push(`Projects: ${errText(e)}`, \'error\');',
  'projectsLoadError.value = errText(e);\n      notices.push(`Projects: ${projectsLoadError.value}`, \'error\');'
);
tigerTs = tigerTs.replace(
  'projectsLoading,\n    initialized,',
  'projectsLoading,\n    projectsLoadError,\n    initialized,'
);
fs.writeFileSync('apps/frontend/app/stores/tiger.ts', tigerTs);

// 2. add_tiger_locales
const EN_PATH = 'apps/frontend/app/locales/en.ts';
const TR_PATH = 'apps/frontend/app/locales/tr.ts';

const NEW_KEYS = `
    view: {
      tiger: 'Tiger',
      templates: 'Templates',
      unavailableTitle: 'Tiger is unavailable',
      retry: 'Retry',
      newProject: 'New project',
      workspaceFolder: 'Workspace folder',
      projectPrompt: 'Project prompt',
      runAllTitle: 'Configure every stage, then run them all automatically',
      correctionRouting: 'Correction routing',
      tasks: 'Tasks',
      runLog: 'Run log',
      outOfOrderTitle: 'Run out of order?',
      cancel: 'Cancel',
      runAnyway: 'Run anyway',
    },
    stages: {
      'brainstorming': { title: 'Brainstorming' },
      'writing-plan': { title: 'Writing Plan' },
      'writing-tasks': { title: 'Writing Tasks' },
      'merge-tasks': { title: 'Merge Tasks' },
      'executing-plan': { title: 'Executing Tasks' },
      'task-review': { title: 'Task Review' },
      'requesting-code-review': { title: 'Requesting Code Review' },
    },
    stageStepper: {
      ariaLabel: 'Tiger workflow stages',
      optionalTitle: 'Optional stage',
      opt: 'opt',
    },
    taskBoard: {
      loading: 'Loading tasks',
      execution: 'Execution',
      review: 'Review',
      emptyStateTitle: 'No tasks yet.',
      emptyStateDesc: 'Run the Merge Tasks stage to produce the authoritative task list.',
      errorStateTitle: 'Failed to load tasks',
      retry: 'Retry',
      executionStatus: {
        not_started: 'not started',
        in_progress: 'in progress',
        done: 'done',
        blocked: 'blocked',
      },
      reviewStatus: {
        pending: 'pending',
        reviewing: 'reviewing',
        approved: 'approved',
        needs_fix: 'needs fix',
        fixed: 'fixed',
      },
    },
    projectLauncher: {
      title: 'Projects',
      refresh: 'Refresh',
      refreshProjects: 'Refresh projects',
      lead: 'Continue a previous project, or create a new one.',
      newProject: 'New project',
      newProjectHint: 'Pick a folder & write a prompt',
      loading: 'Loading projects',
      forgetAriaLabel: 'Forget project {name} (does not delete files)',
      forgetTitle: 'Forget (does not delete files)',
      forgetDialogTitle: 'Forget project',
      forgetDialogMessage: 'Forget “{name}”? This removes it from the project list but does not delete any files on disk.',
      forgetDialogConfirm: 'Forget',
      noPromptYet: '(no prompt yet)',
      folderMissing: 'Folder is missing',
      stagesProgress: '{completed}/{total} stages',
      continueBtn: 'Continue →',
      openBtn: 'Open →',
      emptyStateTitle: 'No projects found',
      emptyStateDesc: 'Create a new project to get started.',
      errorStateTitle: 'Failed to load projects',
    },`;

for (const p of [EN_PATH, TR_PATH]) {
  let content = fs.readFileSync(p, 'utf-8');
  let newContent = '';
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    newContent += lines[i] + '\n';
    if (lines[i].includes('tiger: {')) {
      newContent += NEW_KEYS + '\n';
    }
  }
  fs.writeFileSync(p, newContent);
}

// 3. TaskBoard.vue
let taskBoard = fs.readFileSync('apps/frontend/app/components/tiger/TaskBoard.vue', 'utf-8');
taskBoard = taskBoard.replace(
  'import EmptyState from \'~/components/ui/EmptyState.vue\';',
  'import EmptyState from \'~/components/ui/EmptyState.vue\';\nimport BaseButton from \'~/components/ui/BaseButton.vue\';\nimport { useT } from \'~/composables/useT\';'
);
taskBoard = taskBoard.replace(
  'defineProps<{ tasks: TigerTaskSummary | null; loading?: boolean }>();',
  'defineProps<{ tasks: TigerTaskSummary | null; loading?: boolean; error?: string | null }>();\nconst emit = defineEmits<{ retry: [] }>();\n\nconst { t } = useT();'
);
taskBoard = taskBoard.replace(/label: '[^']+'/g, '');
taskBoard = taskBoard.replace(/, {2}},/g, ' },');
taskBoard = taskBoard.replace(
  '<Spinner :size="14" label="Loading tasks" />',
  '<Spinner :size="14" :label="t(\'tiger.taskBoard.loading\')" />'
);
taskBoard = taskBoard.replace(
  '<div v-else-if="tasks && tasks.total" class="board">',
  `<div v-else-if="error" class="board">
    <EmptyState
      tone="danger"
      icon="⚠️"
      :title="t('tiger.taskBoard.errorStateTitle')"
      :description="error"
    >
      <template #actions>
        <BaseButton variant="secondary" @click="emit('retry')">{{ t('tiger.taskBoard.retry') }}</BaseButton>
      </template>
    </EmptyState>
  </div>

  <div v-else-if="tasks && tasks.total" class="board">`
);
taskBoard = taskBoard.replace('<span class="gl">Execution</span>', `<span class="gl">{{ t('tiger.taskBoard.execution') }}</span>`);
taskBoard = taskBoard.replace('{{ e.label }}<b>', `{{ t('tiger.taskBoard.executionStatus.' + e.k) }}<b>`);
taskBoard = taskBoard.replace('<span class="gl">Review</span>', `<span class="gl">{{ t('tiger.taskBoard.review') }}</span>`);
taskBoard = taskBoard.replace('{{ r.label }}<b>', `{{ t('tiger.taskBoard.reviewStatus.' + r.k) }}<b>`);
taskBoard = taskBoard.replace('v-for="t in tasks.items" :key="t.id"', 'v-for="item in tasks.items" :key="item.id"');
taskBoard = taskBoard.replace(/t\.id/g, 'item.id');
taskBoard = taskBoard.replace(/t\.title/g, 'item.title');
taskBoard = taskBoard.replace(/t\.assignedAgent/g, 'item.assignedAgent');
taskBoard = taskBoard.replace(/t\.executionStatus/g, 'item.executionStatus');
taskBoard = taskBoard.replace(/t\.reviewStatus/g, 'item.reviewStatus');
taskBoard = taskBoard.replace(
  `{{ item.executionStatus.replace('_', ' ') }}`,
  `{{ t('tiger.taskBoard.executionStatus.' + item.executionStatus) }}`
);
taskBoard = taskBoard.replace(
  `{{ item.reviewStatus.replace('_', ' ') }}`,
  `{{ t('tiger.taskBoard.reviewStatus.' + item.reviewStatus) }}`
);
taskBoard = taskBoard.replace(
  `<EmptyState v-else title="No tasks yet." description="Run the Merge Tasks stage to produce the authoritative task list." />`,
  `<EmptyState v-else :title="t('tiger.taskBoard.emptyStateTitle')" :description="t('tiger.taskBoard.emptyStateDesc')" />`
);
fs.writeFileSync('apps/frontend/app/components/tiger/TaskBoard.vue', taskBoard);


// 4. StageStepper.vue
let stageStepper = fs.readFileSync('apps/frontend/app/components/tiger/StageStepper.vue', 'utf-8');
stageStepper = stageStepper.replace(
  `import { TIGER_STAGES } from '~/lib/tigerStages';`,
  `import { TIGER_STAGES } from '~/lib/tigerStages';\nimport { useT } from '~/composables/useT';\n\nconst { t } = useT();`
);
stageStepper = stageStepper.replace(
  `aria-label="Tiger workflow stages"`,
  `:aria-label="t('tiger.stageStepper.ariaLabel')"`
);
stageStepper = stageStepper.replace(
  `<span class="title">{{ s.title }}</span>`,
  `<span class="title">{{ t('tiger.stages.' + s.id + '.title') }}</span>`
);
stageStepper = stageStepper.replace(
  `<span v-if="s.optional" class="opt" title="Optional stage">opt</span>`,
  `<span v-if="s.optional" class="opt" :title="t('tiger.stageStepper.optionalTitle')">{{ t('tiger.stageStepper.opt') }}</span>`
);
fs.writeFileSync('apps/frontend/app/components/tiger/StageStepper.vue', stageStepper);


// 5. TigerView.vue
let tigerView = fs.readFileSync('apps/frontend/app/components/tiger/TigerView.vue', 'utf-8');
tigerView = tigerView.replace(`<b>Tiger</b>`, `<b>{{ t('tiger.view.tiger') }}</b>`);
tigerView = tigerView.replace(
  `<BaseButton variant="secondary" size="sm" @click="emit('openTemplates')">Templates</BaseButton>`,
  `<BaseButton variant="secondary" size="sm" @click="emit('openTemplates')">{{ t('tiger.view.templates') }}</BaseButton>`
);
tigerView = tigerView.replace(
  `      <EmptyState
        v-if="tiger.loadError"
        title="Tiger is unavailable"
        :description="tiger.loadError"
        tone="danger"
      >
        <template #actions>
          <BaseButton variant="secondary" @click="tiger.load()">Retry</BaseButton>
        </template>
      </EmptyState>`,
  `      <EmptyState
        v-if="tiger.loadError"
        :title="t('tiger.view.unavailableTitle')"
        :description="tiger.loadError"
        tone="danger"
      >
        <template #actions>
          <BaseButton variant="secondary" @click="tiger.load()">{{ t('tiger.view.retry') }}</BaseButton>
        </template>
      </EmptyState>`
);
tigerView = tigerView.replace(`<h2>New project</h2>`, `<h2>{{ t('tiger.view.newProject') }}</h2>`);
tigerView = tigerView.replace(`<span>Workspace folder</span>`, `<span>{{ t('tiger.view.workspaceFolder') }}</span>`);
tigerView = tigerView.replace(`<span>Project prompt</span>`, `<span>{{ t('tiger.view.projectPrompt') }}</span>`);
tigerView = tigerView.replace(
  `title="Configure every stage, then run them all automatically"`,
  `:title="t('tiger.view.runAllTitle')"`
);
tigerView = tigerView.replace(`<span class="rl">Correction routing</span>`, `<span class="rl">{{ t('tiger.view.correctionRouting') }}</span>`);
tigerView = tigerView.replace(`<summary>Tasks</summary>`, `<summary>{{ t('tiger.view.tasks') }}</summary>`);
tigerView = tigerView.replace(
  `<TaskBoard :tasks="tiger.state?.tasks ?? null" :loading="tiger.loading && !tiger.loaded" />`,
  `<TaskBoard :tasks="tiger.state?.tasks ?? null" :loading="tiger.loading && !tiger.loaded" :error="tiger.state?.error ?? tiger.loadError" @retry="tiger.load()" />`
);
tigerView = tigerView.replace(`<summary>Run log</summary>`, `<summary>{{ t('tiger.view.runLog') }}</summary>`);
tigerView = tigerView.replace(
  `    <BaseModal v-if="pendingRun" title="Run out of order?" size="sm" @close="cancelOutOfOrder">
      <p class="confirm-text">
        Stage “{{ prevIncomplete }}” is not completed yet. Run “{{ stageMeta.title }}” anyway?
      </p>
      <template #footer>
        <BaseButton variant="ghost" @click="cancelOutOfOrder">Cancel</BaseButton>
        <BaseButton variant="primary" @click="confirmOutOfOrder">Run anyway</BaseButton>
      </template>
    </BaseModal>`,
  `    <BaseModal v-if="pendingRun" :title="t('tiger.view.outOfOrderTitle')" size="sm" @close="cancelOutOfOrder">
      <p class="confirm-text">
        {{ t('tiger.runAll.skippedBefore') }}
      </p>
      <template #footer>
        <BaseButton variant="ghost" @click="cancelOutOfOrder">{{ t('tiger.view.cancel') }}</BaseButton>
        <BaseButton variant="primary" @click="confirmOutOfOrder">{{ t('tiger.view.runAnyway') }}</BaseButton>
      </template>
    </BaseModal>`
);
fs.writeFileSync('apps/frontend/app/components/tiger/TigerView.vue', tigerView);


// 6. ProjectLauncher.vue
let projectLauncher = fs.readFileSync('apps/frontend/app/components/tiger/ProjectLauncher.vue', 'utf-8');
projectLauncher = projectLauncher.replace(
  `import Skeleton from '~/components/ui/Skeleton.vue';`,
  `import Skeleton from '~/components/ui/Skeleton.vue';\nimport EmptyState from '~/components/ui/EmptyState.vue';\nimport { useT } from '~/composables/useT';\n\nconst { t } = useT();`
);
projectLauncher = projectLauncher.replace(
  `    title: 'Forget project',
    message: \`Forget “\${p.name}”? This removes it from the project list but does not delete any files on disk.\`,
    confirmText: 'Forget',`,
  `    title: t('tiger.projectLauncher.forgetDialogTitle'),
    message: t('tiger.projectLauncher.forgetDialogMessage', { name: p.name }),
    confirmText: t('tiger.projectLauncher.forgetDialogConfirm'),`
);
projectLauncher = projectLauncher.replace(`<h2>Projects</h2>`, `<h2>{{ t('tiger.projectLauncher.title') }}</h2>`);
projectLauncher = projectLauncher.replace(
  `        aria-label="Refresh projects"
        title="Refresh"`,
  `        :aria-label="t('tiger.projectLauncher.refreshProjects')"
        :title="t('tiger.projectLauncher.refresh')"`
);
projectLauncher = projectLauncher.replace(
  `<p class="lead">Continue a previous project, or create a new one.</p>`,
  `<p class="lead">{{ t('tiger.projectLauncher.lead') }}</p>`
);
projectLauncher = projectLauncher.replace(
  `        <span class="newlabel">New project</span>
        <span class="newhint">Pick a folder &amp; write a prompt</span>`,
  `        <span class="newlabel">{{ t('tiger.projectLauncher.newProject') }}</span>
        <span class="newhint">{{ t('tiger.projectLauncher.newProjectHint') }}</span>`
);
projectLauncher = projectLauncher.replace(
  `<Spinner :size="14" label="Loading projects" />`,
  `<Spinner :size="14" :label="t('tiger.projectLauncher.loading')" />`
);
projectLauncher = projectLauncher.replace(
  `      <div v-if="tiger.projectsLoading && !tiger.projects.length" class="card skeleton-card">
        <Spinner :size="14" :label="t('tiger.projectLauncher.loading')" />
        <Skeleton :lines="4" />
      </div>`,
  `      <div v-if="tiger.projectsLoading && !tiger.projects.length" class="card skeleton-card">
        <Spinner :size="14" :label="t('tiger.projectLauncher.loading')" />
        <Skeleton :lines="4" />
      </div>

      <div v-else-if="tiger.projectsLoadError && !tiger.projects.length" class="card skeleton-card">
        <EmptyState
          tone="danger"
          icon="⚠️"
          :title="t('tiger.projectLauncher.errorStateTitle')"
          :description="tiger.projectsLoadError"
        >
          <template #actions>
            <BaseButton variant="secondary" @click="refresh">{{ t('tiger.projectLauncher.refresh') }}</BaseButton>
          </template>
        </EmptyState>
      </div>

      <div v-else-if="!tiger.projectsLoading && !tiger.projects.length" class="card skeleton-card">
        <EmptyState
          :title="t('tiger.projectLauncher.emptyStateTitle')"
          :description="t('tiger.projectLauncher.emptyStateDesc')"
        />
      </div>`
);
projectLauncher = projectLauncher.replace(
  `            title="Forget (does not delete files)"
            :aria-label="\`Forget project \${p.name} (does not delete files)\`"`,
  `            :title="t('tiger.projectLauncher.forgetTitle')"
            :aria-label="t('tiger.projectLauncher.forgetAriaLabel', { name: p.name })"`
);
projectLauncher = projectLauncher.replace(
  `<p class="cprompt">{{ p.promptPreview || (p.exists ? '(no prompt yet)' : 'Folder is missing') }}</p>`,
  `<p class="cprompt">{{ p.promptPreview || (p.exists ? t('tiger.projectLauncher.noPromptYet') : t('tiger.projectLauncher.folderMissing')) }}</p>`
);
projectLauncher = projectLauncher.replace(
  `<span class="pn">{{ p.completedStages }}/{{ p.totalStages }} stages</span>`,
  `<span class="pn">{{ t('tiger.projectLauncher.stagesProgress', { completed: p.completedStages, total: p.totalStages }) }}</span>`
);
projectLauncher = projectLauncher.replace(
  `{{ p.completedStages > 0 ? 'Continue →' : 'Open →' }}`,
  `{{ p.completedStages > 0 ? t('tiger.projectLauncher.continueBtn') : t('tiger.projectLauncher.openBtn') }}`
);
fs.writeFileSync('apps/frontend/app/components/tiger/ProjectLauncher.vue', projectLauncher);

console.log('DONE!');

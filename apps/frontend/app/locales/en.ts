// English locale — the source-of-truth message catalogue.
//
// HOW TO ADD STRINGS
//   1. Add a key here under the relevant namespace (nav, common, terminals, …).
//      Keep keys hierarchical and stable; the key is the contract, the value is just
//      the English copy.
//   2. In a component, pull in the translator: `const { t } = useT();` then render
//      `{{ t('common.save') }}` (or `:title="t('terminals.newTerminal')"`).
//   3. Interpolation uses named params: `t('terminals.sendTo', { n: 3 })` against a
//      message like `"Send command to {n} terminal(s)…"`.
//
// HOW TO ADD A LOCALE
//   1. Copy this file to `./<code>.ts` (e.g. `de.ts`) and translate the values.
//   2. Register it in `./index.ts` (add to `messages` and `AVAILABLE_LOCALES`).
//   3. The i18n plugin (app/plugins/i18n.ts) falls back to `en` for any missing key,
//      so partial translations never render a blank string.
export default {
  nav: {
    terminals: 'Terminals',
    projects: 'Projects',
    team: 'Team',
    queue: 'Queue',
    cue: 'Cue',
    prompts: 'Prompts',
    templates: 'Templates',
    limits: 'Limits',
    settings: 'Settings',
    primary: 'Primary',
    home: 'Kaplan home',
  },
  common: {
    save: 'Save',
    cancel: 'Cancel',
    close: 'Close',
    confirm: 'Confirm',
    delete: 'Delete',
    discard: 'Discard',
    keepEditing: 'Keep editing',
    retry: 'Retry',
    loading: 'Loading',
    create: 'Create',
    ok: 'OK',
  },
  connection: {
    live: 'Live',
    connecting: 'Connecting…',
    offline: 'Offline',
    backendStatus: 'Backend {status}',
  },
  terminals: {
    title: 'Terminals',
    newTerminal: '+ New Terminal',
    newShort: '+ New',
    createFirst: '+ Create your first terminal',
    none: 'No terminals yet.',
    selectAll: 'Select all',
    selected: '{n} selected',
    clear: 'clear',
    manageGroups: 'Manage groups',
    openComposer: 'Open prompt composer',
    openPrompts: 'Open Prompts',
    openTemplates: 'Open template manager',
    openTiger: 'Open the Tiger AI orchestrator',
    focusView: 'Focus view',
    gridView: 'Grid view',
    send: 'Send ⏎',
    sendPlaceholder: 'Send command to {n} terminal(s)…',
    commandInput: 'Broadcast command',
    targetSelected: 'Selected',
    targetGroup: 'Group',
    targetAll: 'All',
    chooseGroup: 'Choose group…',
    cantReachBackend: "Can't reach the backend",
    discardChanges: 'Discard unsaved changes?',
  },
};

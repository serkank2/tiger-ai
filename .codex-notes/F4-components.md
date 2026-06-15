## Findings

| Severity | File:line | Issue | Concrete fix |
|---|---|---|---|
| LOW | [TerminalListItem.vue:21](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/TerminalListItem.vue:21) | Delete-confirm timeout is never cleared on unmount. If the row is removed while confirmation is pending, the timer retains the old component closure and mutates `confirming` after unmount. | Add `onBeforeUnmount(() => { if (resetTimer) clearTimeout(resetTimer) })`, and set `resetTimer = null` after clearing/firing. |
| LOW | [StatusDot.vue:13](/C:/Users/serkan/Desktop/Kaplan/apps/frontend/app/components/StatusDot.vue:13) | `META[props.state]` assumes runtime state is always valid. The frontend casts WS JSON elsewhere, so an unexpected backend state would make `meta` undefined and break the template at `meta.cls`. | Use a fallback: `const meta = computed(() => META[props.state] ?? { cls: 'slate', text: String(props.state) })`, or validate states before writing them into the store. |

## Checked OK

No serious Nuxt/Pinia/template problems found.

- Nuxt 4 auto-imports are correct: generated declarations include the requested components, `useApi`, `useSocket`, and all Pinia stores from `app/`.
- `~/types` resolves correctly to `apps/frontend/app/types.ts`.
- Direct assignment / `v-model` on Pinia setup-store state (`commandMode`, `commandGroupId`) is valid here; Pinia unwraps returned refs on the store proxy and supports direct mutation.
- `v-for` keys are stable and correctly placed.
- `defineProps` / `defineEmits` typing is valid for Vue 3.5 named-tuple emits.
import { mount } from '@vue/test-utils';
import { beforeEach, describe, expect, it } from 'vitest';
import { computed } from 'vue';
import PromptEditor, { type PromptDraft } from '~/components/prompt/PromptEditor.vue';
import { createTestI18n } from '../support/i18n';

// Minimal stand-ins for the design-system controls: they implement the v-model
// contract (modelValue + update:modelValue) so we can drive the editor without
// pulling in BaseInput/BaseSelect's own auto-imports.
const BaseInput = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `<input :value="modelValue" @input="$emit('update:modelValue', $event.target.value)" />`,
};
const BaseSelect = {
  props: ['modelValue'],
  emits: ['update:modelValue'],
  template: `<select :value="modelValue" @change="$emit('update:modelValue', $event.target.value)"><slot /></select>`,
};

beforeEach(() => {
  // PromptEditor relies on Nuxt auto-imports; the vitest harness has none, so expose
  // the few it needs as globals (mirrors the other component tests).
  Object.assign(globalThis, {
    computed,
    useGroupsStore: () => ({ groups: [] }),
  });
});

function makeDraft(overrides: Partial<PromptDraft> = {}): PromptDraft {
  return { title: '', description: '', tagsText: '', target: '', run: false, body: '', ...overrides };
}

function mountEditor(draft: PromptDraft) {
  return mount(PromptEditor, {
    props: { draft, values: {}, targetShellKinds: [] },
    global: {
      plugins: [createTestI18n()],
      stubs: { BaseInput, BaseSelect },
    },
  });
}

describe('PromptEditor', () => {
  it('emits update:draft on text edits without mutating the draft prop', async () => {
    const draft = makeDraft({ title: 'Original' });
    const wrapper = mountEditor(draft);

    await wrapper.find('input.title').setValue('Renamed');

    const events = wrapper.emitted('update:draft');
    expect(events).toBeTruthy();
    expect(events!.at(-1)![0]).toMatchObject({ title: 'Renamed' });
    // The parent owns the source of truth: the prop object must stay untouched.
    expect(draft.title).toBe('Original');
  });

  it('emits run-mode changes via update:draft instead of mutating the prop', async () => {
    const draft = makeDraft({ run: false });
    const wrapper = mountEditor(draft);

    // The mode toggle has two buttons: [0] Paste, [1] Run.
    await wrapper.findAll('.mode button')[1]!.trigger('click');

    const events = wrapper.emitted('update:draft');
    expect(events).toBeTruthy();
    expect(events!.at(-1)![0]).toMatchObject({ run: true });
    expect(draft.run).toBe(false);
  });

  it('emits variable values via update:value rather than mutating the values prop', async () => {
    const draft = makeDraft({ body: 'Hello {{name}}' });
    const values: Record<string, string> = {};
    const wrapper = mount(PromptEditor, {
      props: { draft, values, targetShellKinds: [] },
      global: { plugins: [createTestI18n()], stubs: { BaseInput, BaseSelect } },
    });

    await wrapper.find('#var-name').setValue('World');

    const events = wrapper.emitted('update:value');
    expect(events).toBeTruthy();
    expect(events!.at(-1)).toEqual(['name', 'World']);
    expect(values.name).toBeUndefined();
  });
});

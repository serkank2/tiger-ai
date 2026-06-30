import { mount } from '@vue/test-utils';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, useSlots } from 'vue';
import BaseModal from '~/components/ui/BaseModal.vue';

// ui/BaseModal.vue relies on Nuxt auto-imports (Vue Composition API helpers exposed
// globally at runtime). vitest has no Nuxt auto-import layer, so expose them as
// globals from the real `vue` package — equivalent to what Nuxt injects.
beforeAll(() => {
  vi.stubGlobal('computed', computed);
  vi.stubGlobal('ref', ref);
  vi.stubGlobal('nextTick', nextTick);
  vi.stubGlobal('onMounted', onMounted);
  vi.stubGlobal('onBeforeUnmount', onBeforeUnmount);
  vi.stubGlobal('useId', useId);
  vi.stubGlobal('useSlots', useSlots);
});

// Accessible dialog primitive (app/components/ui/BaseModal.vue). Covers the a11y
// contract: role/aria-modal wiring, Escape-to-close (opt-out), backdrop-close
// (opt-out), focus-into-dialog on open, focus restore on unmount, and that Tab is
// trapped inside the dialog.
//
// Teleport is disabled so the dialog renders inline and Testing Library queries can
// reach it without a real document.body portal.
function mountModal(props: Record<string, unknown> = {}, slots: Record<string, string> = {}) {
  return mount(BaseModal, {
    attachTo: document.body,
    props,
    slots,
    global: { stubs: { teleport: true } },
  });
}

afterEach(() => {
  document.body.innerHTML = '';
});

describe('ui/BaseModal', () => {
  it('renders a dialog with aria-modal and links the title via aria-labelledby', () => {
    const wrapper = mountModal({ title: 'Confirm' });
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes('aria-modal')).toBe('true');
    const labelledby = dialog.attributes('aria-labelledby');
    expect(labelledby).toBeTruthy();
    expect(wrapper.find(`#${labelledby}`).text()).toBe('Confirm');
  });

  it('falls back to aria-label when there is no visible title', () => {
    const wrapper = mountModal({ ariaLabel: 'Discard changes?' });
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.attributes('aria-label')).toBe('Discard changes?');
    expect(dialog.attributes('aria-labelledby')).toBeUndefined();
  });

  it('emits close on Escape by default', async () => {
    const wrapper = mountModal({ title: 'X' });
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not close on Escape when closeOnEscape is false', async () => {
    const wrapper = mountModal({ title: 'X', closeOnEscape: false });
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Escape' });
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('closes on backdrop click by default and not when disabled', async () => {
    const open = mountModal({ title: 'X' });
    await open.find('.backdrop').trigger('mousedown');
    expect(open.emitted('close')).toHaveLength(1);

    const locked = mountModal({ title: 'X', closeOnBackdrop: false });
    await locked.find('.backdrop').trigger('mousedown');
    expect(locked.emitted('close')).toBeUndefined();
  });

  it('moves focus into the dialog on open and restores it to the opener on close', async () => {
    const opener = document.createElement('button');
    document.body.appendChild(opener);
    opener.focus();
    expect(document.activeElement).toBe(opener);

    const wrapper = mountModal({ title: 'X' }, { default: '<button class="inner">Go</button>' });
    await wrapper.vm.$nextTick();
    await wrapper.vm.$nextTick();
    // Focus is pulled out of the opener and into the dialog subtree. (happy-dom
    // reports no layout, so we assert containment rather than the exact element.)
    const dialog = wrapper.find('[role="dialog"]').element;
    expect(document.activeElement === dialog || dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(opener);

    wrapper.unmount();
    // Focus returns to the element that opened the dialog.
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });

  it('keeps Tab focus within the dialog (does not escape to the document)', async () => {
    const outside = document.createElement('button');
    document.body.appendChild(outside);

    const wrapper = mountModal({ title: 'X' }, { default: '<button class="a">A</button><button class="b">B</button>' });
    await wrapper.vm.$nextTick();

    // From the last focusable, Tab must wrap back inside the dialog, never to `outside`.
    const dialog = wrapper.find('[role="dialog"]').element;
    (wrapper.find('button.b').element as HTMLElement).focus();
    await wrapper.find('[role="dialog"]').trigger('keydown', { key: 'Tab' });
    expect(document.activeElement === dialog || dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(outside);
    outside.remove();
  });
});

import { mount } from '@vue/test-utils';
import { describe, expect, it } from 'vitest';
import BaseModal from '~/components/BaseModal.vue';

// NOTE: this exercises the CURRENT BaseModal (app/components/BaseModal.vue). The
// focus-trap / Escape-to-close / return-focus / scroll-lock behaviors specified for
// the TASK-002 accessible primitive (app/components/ui/BaseModal.vue) are not yet in
// the codebase, so those assertions are deferred — see the execution log.
describe('BaseModal', () => {
  it('renders a labelled dialog with body content when open', () => {
    const wrapper = mount(BaseModal, {
      props: { open: true, title: 'Settings' },
      slots: { default: '<p class="body">hello</p>' },
    });
    const dialog = wrapper.find('[role="dialog"]');
    expect(dialog.exists()).toBe(true);
    expect(dialog.attributes('aria-modal')).toBe('true');
    expect(wrapper.find('.modal-head b').text()).toBe('Settings');
    expect(wrapper.find('p.body').text()).toBe('hello');
  });

  it('renders nothing when closed', () => {
    const wrapper = mount(BaseModal, { props: { open: false }, slots: { default: '<p>x</p>' } });
    expect(wrapper.find('.modal-backdrop').exists()).toBe(false);
    expect(wrapper.find('[role="dialog"]').exists()).toBe(false);
  });

  it('shows a labelled close button only when dismissible, and emits close on click', async () => {
    const wrapper = mount(BaseModal, { props: { open: true, dismissible: true } });
    const close = wrapper.find('button.close');
    expect(close.exists()).toBe(true);
    expect(close.attributes('aria-label')).toBe('Close');
    await close.trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('omits the close button when not dismissible', () => {
    const wrapper = mount(BaseModal, { props: { open: true, title: 'No close' } });
    expect(wrapper.find('button.close').exists()).toBe(false);
  });

  it('emits close on backdrop click when dismissible', async () => {
    const wrapper = mount(BaseModal, { props: { open: true, dismissible: true } });
    await wrapper.find('.modal-backdrop').trigger('click');
    expect(wrapper.emitted('close')).toHaveLength(1);
  });

  it('does not emit close on backdrop click when not dismissible', async () => {
    const wrapper = mount(BaseModal, { props: { open: true } });
    await wrapper.find('.modal-backdrop').trigger('click');
    expect(wrapper.emitted('close')).toBeUndefined();
  });

  it('applies a custom panel class', () => {
    const wrapper = mount(BaseModal, { props: { open: true, panelClass: 'wide' } });
    expect(wrapper.find('.modal-panel').classes()).toContain('wide');
  });
});

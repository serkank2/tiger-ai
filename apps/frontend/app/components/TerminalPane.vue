<script setup lang="ts">
import BaseButton from '~/components/ui/BaseButton.vue';
import Spinner from '~/components/ui/Spinner.vue';

const { t } = useT();
const terminals = useTerminalsStore();

const host = ref<HTMLElement | null>(null);
const active = computed(() => terminals.active);
const activeId = computed(() => terminals.activeId);
const running = computed(() => active.value?.status.state === 'running' || active.value?.status.state === 'starting');

useTerminalView(host, activeId, { focusOnMount: true });

// Local pending guard so the lifecycle controls show feedback and can't be
// double-clicked during the async start/stop/restart transition.
const pending = ref(false);
async function runLifecycle(action: () => unknown | Promise<unknown>) {
  if (pending.value) return;
  pending.value = true;
  try {
    await action();
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <section class="pane">
    <div v-if="active" class="phead">
      <StatusDot :state="active.status.state" label />
      <span class="pname">{{ active.name }}</span>
      <span class="pcwd" :title="active.cwd">{{ active.cwd }}</span>
      <span v-if="active.status.pid" class="ppid">pid {{ active.status.pid }}</span>
      <span
        v-if="active.status.state === 'exited' && active.status.exitCode !== null"
        class="pexit"
        :class="{ bad: active.status.exitCode !== 0 }"
      >
        {{ t('terminals.pane.exit', { code: active.status.exitCode }) }}
      </span>
      <span v-else-if="active.status.state === 'failed'" class="pexit bad" :title="active.status.error?.message">
        {{ t('terminals.pane.failed') }}{{ active.status.error?.message ? ': ' + active.status.error.message : '' }}
      </span>
      <span class="spacer" />
      <BaseButton
        v-if="!running"
        size="sm"
        variant="primary"
        :loading="pending"
        @click="runLifecycle(() => terminals.start(active!.id))"
        >{{ t('terminals.pane.start') }}</BaseButton
      >
      <BaseButton v-else size="sm" :loading="pending" @click="runLifecycle(() => terminals.stop(active!.id))">{{
        t('terminals.pane.stop')
      }}</BaseButton>
      <BaseButton size="sm" :loading="pending" @click="runLifecycle(() => terminals.restart(active!.id))">{{
        t('terminals.pane.restart')
      }}</BaseButton>
    </div>

    <div class="term-wrap">
      <div ref="host" class="term" />
      <div v-if="active && !running" class="stopped-hint">
        {{ active.status.state }} — {{ t('terminals.pane.pressPrefix') }} <b>{{ t('terminals.pane.start') }}</b>
        {{ t('terminals.pane.pressSuffix') }}
      </div>
    </div>

    <div v-if="terminals.loading && !terminals.loaded" class="noactive">
      <Spinner :label="t('terminals.loadingTerminals')" />
    </div>

    <div v-else-if="!active" class="noactive">
      <p>{{ t('terminals.pane.noActiveLine1') }}<br />{{ t('terminals.pane.noActiveLine2') }}</p>
    </div>
  </section>
</template>

<style scoped>
.pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg-term);
}
.phead {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 9px 14px;
  background: var(--bg-elev);
  border-bottom: 1px solid var(--border);
}
.pname {
  font-weight: 700;
}
.pcwd {
  font-family: var(--font-mono);
  font-size: 12px;
  color: var(--text-faint);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 40%;
}
.ppid,
.pexit {
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--text-faint);
  padding: 2px 7px;
  border: 1px solid var(--border);
  border-radius: 999px;
}
.pexit.bad {
  color: var(--red);
  border-color: var(--red);
}
.spacer {
  flex: 1;
}
.term-wrap {
  flex: 1;
  min-height: 0;
  padding: 8px 4px 8px 10px;
  position: relative;
}
.stopped-hint {
  position: absolute;
  top: 14px;
  left: 50%;
  transform: translateX(-50%);
  padding: 5px 14px;
  font-size: 12px;
  color: var(--text-dim);
  background: var(--bg-elev-2);
  border: 1px solid var(--border-strong);
  border-radius: 999px;
  pointer-events: none;
}
.term {
  width: 100%;
  height: 100%;
}
.noactive {
  position: absolute;
  inset: var(--bar-h) 0 0 var(--sidebar-w);
  display: grid;
  place-items: center;
  color: var(--text-faint);
  text-align: center;
  pointer-events: none;
}
</style>

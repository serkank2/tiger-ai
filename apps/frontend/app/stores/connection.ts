import { ref } from 'vue';
import { defineStore } from 'pinia';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected';

export const useConnectionStore = defineStore('connection', () => {
  const status = ref<ConnectionStatus>('disconnected');
  const setStatus = (s: ConnectionStatus) => {
    status.value = s;
  };
  return { status, setStatus };
});

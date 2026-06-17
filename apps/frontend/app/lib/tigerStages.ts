import type { TigerStageId } from '~/types';

export interface TigerStageMeta {
  id: TigerStageId;
  order: number;
  number: string;
  title: string;
  optional: boolean;
}

export const TIGER_STAGES: readonly TigerStageMeta[] = [
  { id: 'brainstorming', order: 1, number: '1', title: 'Brainstorming', optional: true },
  { id: 'writing-plan', order: 2, number: '2', title: 'Writing Plan', optional: false },
  { id: 'writing-tasks', order: 3, number: '3', title: 'Writing Tasks', optional: false },
  { id: 'merge-tasks', order: 4, number: '4', title: 'Merge Tasks', optional: false },
  { id: 'executing-plan', order: 5, number: '5', title: 'Executing Tasks', optional: false },
  { id: 'task-review', order: 6, number: '6A', title: 'Task Review', optional: false },
  {
    id: 'requesting-code-review',
    order: 7,
    number: '6B',
    title: 'Requesting Code Review',
    optional: false,
  },
];

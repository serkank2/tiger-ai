// ---------------------------------------------------------------------------
// Planner output contract. A plan turn ends with THIS structured object (the
// CLI enforces it where supported): the task list that seeds/extends the
// WorkGraph. Anthropic's core multi-agent lesson is baked into the prompt the
// engine sends with it: each task description must be SELF-CONTAINED enough
// to execute without reading the other tasks.
// ---------------------------------------------------------------------------

export interface PlannedTask {
  /** Optional stable id ("T1"); engine assigns one when absent/duplicated. */
  id?: string;
  title: string;
  description: string;
  acceptanceCriteria?: string[];
  /** Ids of tasks (existing or in this plan) that must land first. */
  dependsOn?: string[];
}

export interface PlanResult {
  status: 'done' | 'blocked';
  summary: string;
  tasks: PlannedTask[];
  /** Existing pending task ids this re-plan cancels (steering may cut scope). */
  cancelTaskIds?: string[];
  /**
   * Staged planning: short description of the goal scope NOT covered by this
   * batch. Non-empty ⇒ the engine schedules another plan turn when the batch
   * drains, instead of finalizing.
   */
  remainingScope?: string;
}

export const PLAN_RESULT_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'summary', 'tasks'],
  properties: {
    status: { type: 'string', enum: ['done', 'blocked'] },
    summary: { type: 'string' },
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['title', 'description'],
        properties: {
          id: { type: 'string' },
          title: { type: 'string' },
          description: { type: 'string' },
          acceptanceCriteria: { type: 'array', items: { type: 'string' } },
          dependsOn: { type: 'array', items: { type: 'string' } },
        },
      },
    },
    cancelTaskIds: { type: 'array', items: { type: 'string' } },
    remainingScope: { type: 'string' },
  },
} as const;

/** Tolerant narrowing of a parsed JSON value into a PlanResult. */
export function coercePlanResult(value: unknown): PlanResult | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.status !== 'done' && record.status !== 'blocked') return null;
  if (typeof record.summary !== 'string' || !record.summary.trim()) return null;
  if (!Array.isArray(record.tasks)) return null;

  const tasks: PlannedTask[] = [];
  for (const entry of record.tasks) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;
    if (typeof raw.title !== 'string' || !raw.title.trim()) continue;
    if (typeof raw.description !== 'string' || !raw.description.trim()) continue;
    const task: PlannedTask = { title: raw.title.trim(), description: raw.description.trim() };
    if (typeof raw.id === 'string' && raw.id.trim()) task.id = raw.id.trim();
    if (Array.isArray(raw.acceptanceCriteria)) {
      const criteria = raw.acceptanceCriteria.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
      if (criteria.length) task.acceptanceCriteria = criteria;
    }
    if (Array.isArray(raw.dependsOn)) {
      const deps = raw.dependsOn.filter((d): d is string => typeof d === 'string' && d.trim().length > 0);
      if (deps.length) task.dependsOn = deps;
    }
    tasks.push(task);
  }

  const out: PlanResult = { status: record.status, summary: record.summary.trim(), tasks };
  if (Array.isArray(record.cancelTaskIds)) {
    const cancels = record.cancelTaskIds.filter((c): c is string => typeof c === 'string' && c.trim().length > 0);
    if (cancels.length) out.cancelTaskIds = cancels;
  }
  if (typeof record.remainingScope === 'string' && record.remainingScope.trim()) {
    out.remainingScope = record.remainingScope.trim();
  }
  return out;
}

/** Extract a PlanResult from the turn's final text (direct/fenced/trailing JSON). */
export function parsePlanResult(text: string | undefined | null): PlanResult | null {
  if (!text) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  const candidates: string[] = [trimmed];
  for (const match of trimmed.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)) candidates.push((match[1] ?? '').trim());
  const last = lastObject(trimmed);
  if (last) candidates.push(last);
  for (const candidate of candidates) {
    if (!candidate.startsWith('{')) continue;
    try {
      const coerced = coercePlanResult(JSON.parse(candidate));
      if (coerced) return coerced;
    } catch {
      /* try the next candidate */
    }
  }
  return null;
}

function lastObject(text: string): string | null {
  const end = text.lastIndexOf('}');
  if (end < 0) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = text[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return text.slice(i, end + 1);
    }
  }
  return null;
}

/**
 * Tiny dependency-free metrics registry — counters and gauges only.
 *
 * Counters monotonically increase (e.g. requests served by status class). Gauges hold a
 * point-in-time value that is recomputed on scrape from the live app context (queue depth,
 * pty count, WS peers, memory). Render is available as Prometheus text exposition or JSON so
 * `/api/metrics` can serve either without pulling in a client library.
 */

export type Labels = Record<string, string>;
export type MetricType = 'counter' | 'gauge';

/**
 * Escape a label value per the Prometheus text exposition format: backslash, double-quote and
 * newline are escaped. Shared by `seriesKey` and `renderText` so the two never diverge.
 */
function escapeLabelValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
}

/** Render the `{a="x",b="y"}` label block (sorted, escaped) or '' when there are no labels. */
function renderLabels(labels?: Labels): string {
  if (!labels) return '';
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}="${escapeLabelValue(String(labels[k] ?? ''))}"`);
  return parts.length ? `{${parts.join(',')}}` : '';
}

/** Stable key for a metric series: `name` plus sorted `label="value"` pairs. */
function seriesKey(name: string, labels?: Labels): string {
  return `${name}${renderLabels(labels)}`;
}

interface Series {
  name: string;
  labels?: Labels;
  value: number;
  type: MetricType;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Series>();
  /** Lazily-evaluated gauges; recomputed every scrape so values are never stale. */
  private readonly gauges = new Map<string, () => number>();
  /** Optional per-metric HELP text (keyed by metric name, not series key). */
  private readonly help = new Map<string, string>();

  /** Increment (or create) a counter series by `delta` (default 1). */
  inc(name: string, labels?: Labels, delta = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) existing.value += delta;
    else this.counters.set(key, { name, labels, value: delta, type: 'counter' });
  }

  /** Register a gauge whose value is computed on demand at scrape time. */
  setGauge(name: string, compute: () => number): void {
    this.gauges.set(name, compute);
  }

  /** Attach an optional `# HELP` description for a metric name (rendered once per metric). */
  setHelp(name: string, help: string): void {
    this.help.set(name, help);
  }

  /** Snapshot every series (counters + freshly-computed gauges) as JSON. */
  collect(): Series[] {
    const out: Series[] = [];
    for (const s of this.counters.values())
      out.push({ name: s.name, labels: s.labels, value: s.value, type: 'counter' });
    for (const [name, compute] of this.gauges) {
      let value = 0;
      try {
        value = compute();
      } catch {
        value = 0; // a failing gauge must never break the scrape
      }
      out.push({ name, value, type: 'gauge' });
    }
    return out;
  }

  /**
   * Prometheus text exposition format. Emits a `# HELP` (when registered) and a `# TYPE`
   * line once per metric name, followed by each of its series. Counters and gauges are
   * declared with their real type so scrapers treat them correctly.
   */
  renderText(): string {
    const series = this.collect();
    // Group series by metric name, preserving first-seen order, so HELP/TYPE precede samples.
    const byName = new Map<string, Series[]>();
    for (const s of series) {
      const group = byName.get(s.name);
      if (group) group.push(s);
      else byName.set(s.name, [s]);
    }
    const lines: string[] = [];
    for (const [name, group] of byName) {
      const help = this.help.get(name);
      if (help) lines.push(`# HELP ${name} ${help.replace(/\\/g, '\\\\').replace(/\n/g, '\\n')}`);
      lines.push(`# TYPE ${name} ${group[0]!.type}`);
      for (const s of group) lines.push(`${s.name}${renderLabels(s.labels)} ${s.value}`);
    }
    return lines.join('\n') + '\n';
  }

  /** Flat JSON view keyed by series key. */
  renderJson(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const s of this.collect()) out[seriesKey(s.name, s.labels)] = s.value;
    return out;
  }
}

/** Process-wide registry. */
export const metrics = new MetricsRegistry();

/** Bucket an HTTP status into a Prometheus-friendly class label (2xx, 4xx, …). */
export function statusClass(status: number): string {
  return `${Math.floor(status / 100)}xx`;
}

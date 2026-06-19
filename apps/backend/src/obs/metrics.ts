/**
 * Tiny dependency-free metrics registry — counters and gauges only.
 *
 * Counters monotonically increase (e.g. requests served by status class). Gauges hold a
 * point-in-time value that is recomputed on scrape from the live app context (queue depth,
 * pty count, WS peers, memory). Render is available as Prometheus text exposition or JSON so
 * `/api/metrics` can serve either without pulling in a client library.
 */

export type Labels = Record<string, string>;

/** Stable key for a metric series: `name` plus sorted `label="value"` pairs. */
function seriesKey(name: string, labels?: Labels): string {
  if (!labels) return name;
  const parts = Object.keys(labels)
    .sort()
    .map((k) => `${k}=${JSON.stringify(labels[k] ?? '')}`);
  return parts.length ? `${name}{${parts.join(',')}}` : name;
}

interface Series {
  name: string;
  labels?: Labels;
  value: number;
}

export class MetricsRegistry {
  private readonly counters = new Map<string, Series>();
  /** Lazily-evaluated gauges; recomputed every scrape so values are never stale. */
  private readonly gauges = new Map<string, () => number>();

  /** Increment (or create) a counter series by `delta` (default 1). */
  inc(name: string, labels?: Labels, delta = 1): void {
    const key = seriesKey(name, labels);
    const existing = this.counters.get(key);
    if (existing) existing.value += delta;
    else this.counters.set(key, { name, labels, value: delta });
  }

  /** Register a gauge whose value is computed on demand at scrape time. */
  setGauge(name: string, compute: () => number): void {
    this.gauges.set(name, compute);
  }

  /** Snapshot every series (counters + freshly-computed gauges) as JSON. */
  collect(): Series[] {
    const out: Series[] = [];
    for (const s of this.counters.values()) out.push({ name: s.name, labels: s.labels, value: s.value });
    for (const [name, compute] of this.gauges) {
      let value = 0;
      try {
        value = compute();
      } catch {
        value = 0; // a failing gauge must never break the scrape
      }
      out.push({ name, value });
    }
    return out;
  }

  /** Prometheus text exposition format. */
  renderText(): string {
    const lines: string[] = [];
    for (const s of this.collect()) {
      const labelStr = s.labels
        ? `{${Object.keys(s.labels)
            .sort()
            .map((k) => `${k}="${String(s.labels![k]).replace(/"/g, '\\"')}"`)
            .join(',')}}`
        : '';
      lines.push(`${s.name}${labelStr} ${s.value}`);
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

import test from 'node:test';
import assert from 'node:assert/strict';
import { MetricsRegistry } from './metrics.js';

test('renderText emits one # TYPE line per metric with the correct type', () => {
  const m = new MetricsRegistry();
  m.inc('http_requests_total', { class: '2xx' });
  m.inc('http_requests_total', { class: '5xx' });
  m.setGauge('queue_depth', () => 7);

  const text = m.renderText();
  // Counter declared as counter (once), gauge declared as gauge.
  assert.match(text, /^# TYPE http_requests_total counter$/m);
  assert.match(text, /^# TYPE queue_depth gauge$/m);
  assert.equal((text.match(/# TYPE http_requests_total /g) ?? []).length, 1);

  // Both label series render under the single TYPE line.
  assert.match(text, /http_requests_total\{class="2xx"\} 1/);
  assert.match(text, /http_requests_total\{class="5xx"\} 1/);
  assert.match(text, /queue_depth 7/);
});

test('renderText includes # HELP when registered', () => {
  const m = new MetricsRegistry();
  m.setHelp('queue_depth', 'jobs not yet terminal');
  m.setGauge('queue_depth', () => 0);
  assert.match(m.renderText(), /^# HELP queue_depth jobs not yet terminal$/m);
});

test('label escaping is consistent and Prometheus-correct in text and json keys', () => {
  const m = new MetricsRegistry();
  // A value with a quote and a backslash exercises the escape rules.
  m.inc('weird_total', { label: 'a"b\\c' });

  const text = m.renderText();
  assert.match(text, /weird_total\{label="a\\"b\\\\c"\} 1/);

  // The JSON key uses the same escaped rendering (seriesKey shares renderLabels now).
  const json = m.renderJson();
  assert.ok(Object.keys(json).some((k) => k === 'weird_total{label="a\\"b\\\\c"}'));
});

test('a throwing gauge renders as 0 and never breaks the scrape', () => {
  const m = new MetricsRegistry();
  m.setGauge('boom', () => {
    throw new Error('nope');
  });
  const text = m.renderText();
  assert.match(text, /^# TYPE boom gauge$/m);
  assert.match(text, /^boom 0$/m);
});

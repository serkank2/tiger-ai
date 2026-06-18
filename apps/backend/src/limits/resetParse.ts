import type { LimitParseConfidence } from './types.js';

export type ResetParseKind = 'relative' | 'clock' | 'date' | 'unknown';

export interface ResetParseResult {
  resetAt: string | null;
  parseConfidence: LimitParseConfidence;
  kind: ResetParseKind;
  timeZone: string;
  source: string | null;
}

export interface ResetParseOptions {
  now?: Date;
  defaultTimeZone?: string;
}

const MONTHS: Record<string, number> = {
  jan: 0,
  january: 0,
  feb: 1,
  february: 1,
  mar: 2,
  march: 2,
  apr: 3,
  april: 3,
  may: 4,
  jun: 5,
  june: 5,
  jul: 6,
  july: 6,
  aug: 7,
  august: 7,
  sep: 8,
  sept: 8,
  september: 8,
  oct: 9,
  october: 9,
  nov: 10,
  november: 10,
  dec: 11,
  december: 11,
};

const MONTH_PATTERN = Object.keys(MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

function systemTimeZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function safeTimeZone(timeZone: string | undefined): string {
  const candidate = timeZone && timeZone.trim() ? timeZone.trim() : systemTimeZone();
  return isValidTimeZone(candidate) ? candidate : 'UTC';
}

function extractTimeZone(text: string, fallback: string): { text: string; timeZone: string } {
  const match = text.match(/\(([A-Za-z][A-Za-z0-9_+\-]*(?:\/[A-Za-z0-9_+\-]+)+|UTC|Etc\/UTC)\)/);
  if (!match?.[1]) return { text, timeZone: fallback };
  const candidate = safeTimeZone(match[1]);
  return { text: text.replace(match[0], ' '), timeZone: candidate };
}

function cleanResetText(text: string): string {
  return text
    .replace(/^\s*\(|\)\s*$/g, ' ')
    .replace(/\bapprox(?:imately)?\b/gi, ' ')
    .replace(/\babout\b/gi, ' ')
    .replace(/\bresets?\b/gi, ' ')
    .replace(/\breset\s+at\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

interface ZonedParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

function getZonedParts(date: Date, timeZone: string): ZonedParts {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  const parts = dtf.formatToParts(date);
  const read = (type: Intl.DateTimeFormatPartTypes): number => {
    const part = parts.find((entry) => entry.type === type);
    if (!part) throw new Error(`missing ${type} in formatted date`);
    return Number(part.value);
  };
  const hour = read('hour');
  return {
    year: read('year'),
    month: read('month'),
    day: read('day'),
    hour: hour === 24 ? 0 : hour,
    minute: read('minute'),
    second: read('second'),
  };
}

function zonedTimeToUtc(parts: ZonedParts, timeZone: string): Date {
  const targetAsUtc = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second, 0);
  let utc = targetAsUtc;
  for (let i = 0; i < 3; i += 1) {
    const actual = getZonedParts(new Date(utc), timeZone);
    const actualAsUtc = Date.UTC(
      actual.year,
      actual.month - 1,
      actual.day,
      actual.hour,
      actual.minute,
      actual.second,
      0,
    );
    const delta = actualAsUtc - targetAsUtc;
    if (delta === 0) break;
    utc -= delta;
  }
  return new Date(utc);
}

function parseTime(hourText: string | undefined, minuteText: string | undefined, meridiem: string | undefined): { hour: number; minute: number } | null {
  if (!hourText) return null;
  let hour = Number(hourText);
  const minute = minuteText === undefined || minuteText === '' ? 0 : Number(minuteText);
  if (!Number.isInteger(hour) || !Number.isInteger(minute) || minute < 0 || minute > 59) return null;
  if (meridiem) {
    const suffix = meridiem.toLowerCase();
    if (hour < 1 || hour > 12) return null;
    if (suffix === 'pm' && hour !== 12) hour += 12;
    if (suffix === 'am' && hour === 12) hour = 0;
  } else if (hour < 0 || hour > 23) {
    return null;
  }
  return { hour, minute };
}

function parseRelativeMs(text: string): number | null {
  const candidate =
    text.match(/\bin\s+((?:\d+\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\s*)+)/i)?.[1] ??
    (text.match(/^\s*((?:\d+\s*(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)\s*)+)\s*$/i)?.[1] ?? null);
  if (!candidate) return null;
  let total = 0;
  const units = candidate.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)/gi);
  for (const match of units) {
    const amount = Number(match[1]);
    const unit = (match[2] ?? '').toLowerCase();
    if (!Number.isFinite(amount)) continue;
    if (unit === 'd' || unit.startsWith('day')) total += amount * 24 * 60 * 60 * 1000;
    else if (unit === 'h' || unit.startsWith('hour') || unit.startsWith('hr')) total += amount * 60 * 60 * 1000;
    else if (unit === 'm' || unit.startsWith('min')) total += amount * 60 * 1000;
    else if (unit === 's' || unit.startsWith('sec')) total += amount * 1000;
  }
  return total > 0 ? total : null;
}

function futureDate(
  parts: Omit<ZonedParts, 'second'> & { second?: number },
  timeZone: string,
  now: Date,
  explicitYear: boolean,
): Date {
  let result = zonedTimeToUtc({ ...parts, second: parts.second ?? 0 }, timeZone);
  if (!explicitYear && result.getTime() <= now.getTime() - 60_000) {
    result = zonedTimeToUtc({ ...parts, year: parts.year + 1, second: parts.second ?? 0 }, timeZone);
  }
  return result;
}

function parseIsoDate(text: string, timeZone: string, now: Date): Date | null {
  const match = text.match(/\b(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T,]+(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)?)?/i);
  if (!match) return null;
  const time = parseTime(match[4] ?? '0', match[5] ?? '0', match[6]);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (!time || !Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  return futureDate({ year, month, day, hour: time.hour, minute: time.minute }, timeZone, now, true);
}

function parseMonthFirstDate(text: string, timeZone: string, now: Date): Date | null {
  const match = text.match(
    new RegExp(`\\b(${MONTH_PATTERN})\\.?\\s+(\\d{1,2})(?:,?\\s+(\\d{4}))?(?:,?\\s*(?:at\\s*)?(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?`, 'i'),
  );
  if (!match?.[1] || !match[2]) return null;
  const month = MONTHS[match[1].toLowerCase()];
  if (month === undefined) return null;
  const nowParts = getZonedParts(now, timeZone);
  const explicitYear = !!match[3];
  const year = explicitYear ? Number(match[3]) : nowParts.year;
  const day = Number(match[2]);
  const time = parseTime(match[4] ?? '0', match[5] ?? '0', match[6]);
  if (!time || !Number.isInteger(year) || !Number.isInteger(day)) return null;
  return futureDate({ year, month: month + 1, day, hour: time.hour, minute: time.minute }, timeZone, now, explicitYear);
}

function parseTimeOnDayMonth(text: string, timeZone: string, now: Date): Date | null {
  const match = text.match(new RegExp(`\\b(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?\\s+on\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?\\b`, 'i'));
  if (!match?.[4] || !match[5]) return null;
  const month = MONTHS[match[5].toLowerCase()];
  const time = parseTime(match[1], match[2], match[3]);
  if (month === undefined || !time) return null;
  const nowParts = getZonedParts(now, timeZone);
  const explicitYear = !!match[6];
  const year = explicitYear ? Number(match[6]) : nowParts.year;
  const day = Number(match[4]);
  return futureDate({ year, month: month + 1, day, hour: time.hour, minute: time.minute }, timeZone, now, explicitYear);
}

function parseDayMonthAtTime(text: string, timeZone: string, now: Date): Date | null {
  const match = text.match(new RegExp(`\\bon\\s+(\\d{1,2})\\s+(${MONTH_PATTERN})(?:\\s+(\\d{4}))?(?:\\s+at\\s+(\\d{1,2})(?::(\\d{2}))?\\s*(am|pm)?)?`, 'i'));
  if (!match?.[1] || !match[2]) return null;
  const month = MONTHS[match[2].toLowerCase()];
  if (month === undefined) return null;
  const nowParts = getZonedParts(now, timeZone);
  const explicitYear = !!match[3];
  const year = explicitYear ? Number(match[3]) : nowParts.year;
  const day = Number(match[1]);
  const time = parseTime(match[4] ?? '0', match[5] ?? '0', match[6]);
  if (!time) return null;
  return futureDate({ year, month: month + 1, day, hour: time.hour, minute: time.minute }, timeZone, now, explicitYear);
}

function parseClock(text: string, timeZone: string, now: Date): Date | null {
  const meridiem = text.match(/\b(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)\b/i);
  const twentyFour = text.match(/\b(?:at\s*)?([01]?\d|2[0-3]):([0-5]\d)\b/i);
  const match = meridiem ?? twentyFour;
  if (!match) return null;
  const time = parseTime(match[1], match[2], match[3]);
  if (!time) return null;
  const nowParts = getZonedParts(now, timeZone);
  let result = zonedTimeToUtc(
    {
      year: nowParts.year,
      month: nowParts.month,
      day: nowParts.day,
      hour: time.hour,
      minute: time.minute,
      second: 0,
    },
    timeZone,
  );
  if (result.getTime() <= now.getTime() + 30_000) {
    result = zonedTimeToUtc(
      {
        year: nowParts.year,
        month: nowParts.month,
        day: nowParts.day + 1,
        hour: time.hour,
        minute: time.minute,
        second: 0,
      },
      timeZone,
    );
  }
  return result;
}

function trusted(date: Date, kind: ResetParseKind, timeZone: string, source: string | null): ResetParseResult {
  return { resetAt: date.toISOString(), parseConfidence: 'trusted', kind, timeZone, source };
}

/**
 * Parse CLI reset text to an absolute UTC ISO timestamp.
 *
 * Conservative fallback: when text cannot be parsed, resetAt is null and parseConfidence is
 * "unknown". Rule evaluation treats an over-threshold window with unknown reset time as blocked
 * without a resumeAfter value rather than guessing.
 */
export function parseResetText(text: string | null | undefined, options: ResetParseOptions = {}): ResetParseResult {
  const source = typeof text === 'string' && text.trim() ? text.trim() : null;
  const fallbackZone = safeTimeZone(options.defaultTimeZone);
  if (!source) return { resetAt: null, parseConfidence: 'unknown', kind: 'unknown', timeZone: fallbackZone, source };

  const now = options.now ?? new Date();
  const extracted = extractTimeZone(source, fallbackZone);
  const timeZone = extracted.timeZone;
  const clean = cleanResetText(extracted.text);
  if (!clean) return { resetAt: null, parseConfidence: 'unknown', kind: 'unknown', timeZone, source };

  const relativeMs = parseRelativeMs(clean);
  if (relativeMs !== null) return trusted(new Date(now.getTime() + relativeMs), 'relative', timeZone, source);

  const date =
    parseIsoDate(clean, timeZone, now) ??
    parseTimeOnDayMonth(clean, timeZone, now) ??
    parseDayMonthAtTime(clean, timeZone, now) ??
    parseMonthFirstDate(clean, timeZone, now);
  if (date) return trusted(date, 'date', timeZone, source);

  const clock = parseClock(clean, timeZone, now);
  if (clock) return trusted(clock, 'clock', timeZone, source);

  return { resetAt: null, parseConfidence: 'unknown', kind: 'unknown', timeZone, source };
}

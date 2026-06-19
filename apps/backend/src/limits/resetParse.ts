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

// --- Non-English fallback tables -------------------------------------------
// Localized provider/limit panels render reset text in the OS language. The
// primary parsers above are English-only; when they all fail we fall back to
// these multilingual tables (and to language-neutral numeric forms) so a German,
// French, Spanish, etc. panel still yields a reset time instead of `unknown`.
//
// Keys are lowercased and accent-stripped (see foldAccents) so "März"/"marz" and
// "décembre"/"decembre" both match. Values are 0-based month indices.
const LOCALE_MONTHS: Record<string, number> = {
  // German
  januar: 0, februar: 1, marz: 2, mai: 4, juni: 5, juli: 6, oktober: 9, dezember: 11,
  // French
  janvier: 0, fevrier: 1, mars: 2, avril: 3, juin: 5, juillet: 6, aout: 7, septembre: 8, octobre: 9, novembre: 10, decembre: 11,
  // Spanish / Portuguese / Italian
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6, agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
  janeiro: 0, fevereiro: 1, marco: 2, maio: 4, junho: 5, julho: 6, setembro: 8, outubro: 9, novembro: 10, dezembro: 11,
  gennaio: 0, febbraio: 1, aprile: 3, maggio: 4, giugno: 5, luglio: 6, settembre: 8, ottobre: 9, dicembre: 11,
};

const LOCALE_MONTH_PATTERN = Object.keys(LOCALE_MONTHS)
  .sort((a, b) => b.length - a.length)
  .join('|');

// Localized duration units → multiplier in ms. Matched as a prefix of the word so
// inflected forms ("heures", "Stunden", "minutos") still resolve. English units are
// already handled by parseRelativeMs; these cover the common Latin-script locales.
const LOCALE_UNITS: { re: RegExp; ms: number }[] = [
  // days: jour(s)/Tag(e)/día(s)/dia(s)/giorno/giorni
  { re: /(?:jour|tag|tage|dia|día|giorn)/i, ms: 24 * 60 * 60 * 1000 },
  // hours: heure(s)/Stunde(n)/hora(s)/ora/ore
  { re: /(?:heure|stunde|hora|\bore?\b|\bora\b)/i, ms: 60 * 60 * 1000 },
  // minutes: minute(n)/minuto(s)/minut
  { re: /(?:minut|minuto)/i, ms: 60 * 1000 },
  // seconds: seconde(s)/Sekunde(n)/segundo(s)/secondo
  { re: /(?:second|sekunde|segund)/i, ms: 1000 },
];

/** Lowercase and strip diacritics so localized month/unit tables match accented text. */
function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

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

// English duration unit, anchored with a trailing (?![a-z]) so a single-letter unit
// like `s`/`m`/`h` doesn't match the FIRST letter of a localized word (e.g. the "s"
// in German "Stunden"), which would otherwise let the English parser mis-claim
// non-English text. The localized fallback handles those words separately.
const EN_UNIT = '(?:days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?![a-z])';

function parseRelativeMs(text: string): number | null {
  const candidate =
    text.match(new RegExp(`\\bin\\s+((?:\\d+\\s*${EN_UNIT}\\s*)+)`, 'i'))?.[1] ??
    (text.match(new RegExp(`^\\s*((?:\\d+\\s*${EN_UNIT}\\s*)+)\\s*$`, 'i'))?.[1] ?? null);
  if (!candidate) return null;
  let total = 0;
  // Capturing variant of EN_UNIT (group 2 = the matched unit token).
  const units = candidate.matchAll(/(\d+)\s*(days?|d|hours?|hrs?|hr|h|minutes?|mins?|min|m|seconds?|secs?|sec|s)(?![a-z])/gi);
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

/**
 * Relative duration with localized unit words (e.g. "in 2 Stunden", "dans 3 heures",
 * "em 5 minutos"). Sums every "<number> <localized-unit>" pair found anywhere in the
 * text; the connector word ("in"/"dans"/"em"/…) is irrelevant since we key off the
 * unit, not the preposition.
 */
function parseLocaleRelativeMs(text: string): number | null {
  const folded = foldAccents(text);
  const pairs = folded.matchAll(/(\d+)\s*([a-zà-ÿ]+)/gi);
  let total = 0;
  for (const pair of pairs) {
    const amount = Number(pair[1]);
    const word = pair[2] ?? '';
    if (!Number.isFinite(amount)) continue;
    const unit = LOCALE_UNITS.find((u) => u.re.test(word));
    if (unit) total += amount * unit.ms;
  }
  return total > 0 ? total : null;
}

/** Numeric day/month/year date in EU order: DD.MM.YYYY, DD/MM/YYYY, DD-MM-YYYY (year optional). */
function parseNumericDmyDate(text: string, timeZone: string, now: Date): Date | null {
  const match = text.match(/\b(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?:[ ,]+(?:\D{0,4})?(\d{1,2}):(\d{2}))?/);
  if (!match?.[1] || !match[2]) return null;
  const day = Number(match[1]);
  const month = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const nowParts = getZonedParts(now, timeZone);
  const explicitYear = match[3] !== undefined;
  let year = explicitYear ? Number(match[3]) : nowParts.year;
  if (explicitYear && year < 100) year += 2000; // 2-digit year
  const time = parseTime(match[4] ?? '0', match[5] ?? '0', undefined);
  if (!time) return null;
  return futureDate({ year, month, day, hour: time.hour, minute: time.minute }, timeZone, now, explicitYear);
}

/** "<day> <localized-month> [year] [time]" e.g. "19 juin 2026 14:30", "5 März". */
function parseLocaleMonthDate(text: string, timeZone: string, now: Date): Date | null {
  const folded = foldAccents(text);
  const match = folded.match(
    new RegExp(`\\b(\\d{1,2})\\.?\\s+(${LOCALE_MONTH_PATTERN})\\.?(?:\\s+(\\d{4}))?(?:[ ,]+(\\d{1,2}):(\\d{2}))?`, 'i'),
  );
  if (!match?.[1] || !match[2]) return null;
  const month = LOCALE_MONTHS[match[2]];
  if (month === undefined) return null;
  const nowParts = getZonedParts(now, timeZone);
  const explicitYear = match[3] !== undefined;
  const year = explicitYear ? Number(match[3]) : nowParts.year;
  const day = Number(match[1]);
  const time = parseTime(match[4] ?? '0', match[5] ?? '0', undefined);
  if (!time) return null;
  return futureDate({ year, month: month + 1, day, hour: time.hour, minute: time.minute }, timeZone, now, explicitYear);
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
    parseMonthFirstDate(clean, timeZone, now) ??
    // Localized/numeric dates carry an explicit day+month, so they're more specific
    // than a bare clock — try them before parseClock can claim a lone "14:30".
    parseLocaleMonthDate(clean, timeZone, now) ??
    parseNumericDmyDate(clean, timeZone, now);
  if (date) return trusted(date, 'date', timeZone, source);

  const clock = parseClock(clean, timeZone, now);
  if (clock) return trusted(clock, 'clock', timeZone, source);

  // Non-English relative fallback: the English keyword paths above all failed. Try
  // localized duration units so a non-English provider panel ("in 3 Stunden") still
  // resolves a reset time instead of degrading to `unknown`.
  const localeRelativeMs = parseLocaleRelativeMs(clean);
  if (localeRelativeMs !== null) return trusted(new Date(now.getTime() + localeRelativeMs), 'relative', timeZone, source);

  return { resetAt: null, parseConfidence: 'unknown', kind: 'unknown', timeZone, source };
}

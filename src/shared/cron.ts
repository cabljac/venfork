const FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

const MONTH_NAMES = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
];
const WEEKDAY_NAMES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

/**
 * Splits into 5 fields and replaces month and weekday names with numbers.
 * Names are replaced only in list items and range ends, never in the step or
 * as the lone base of a step, and are matched case-insensitively.
 */
function splitCron(cron: string): string[] {
  const fields = cron.trim().split(/\s+/);
  const names: Record<number, { list: string[]; offset: number }> = {
    3: { list: MONTH_NAMES, offset: 1 },
    4: { list: WEEKDAY_NAMES, offset: 0 },
  };
  return fields.map((field, index) => {
    const table = names[index];
    if (!table) return field;
    const toNumber = (name: string) => {
      const at = table.list.indexOf(name.toUpperCase());
      return at === -1 ? name : String(at + table.offset);
    };
    const [base, ...step] = field.split('/');
    const items = base.split(',').map((item) => {
      if (item.includes('-')) {
        return item.split('-').map(toNumber).join('-');
      }
      return step.length > 0 ? item : toNumber(item);
    });
    return [items.join(','), ...step].join('/');
  });
}

function isValidCronField(field: string, min: number, max: number): boolean {
  if (field === '*') {
    return true;
  }

  const isValidNumber = (value: string): boolean => {
    if (!/^\d+$/.test(value)) {
      return false;
    }
    const parsed = Number.parseInt(value, 10);
    return parsed >= min && parsed <= max;
  };

  const isValidRange = (value: string): boolean => {
    const [start, end] = value.split('-');
    if (!start || !end || !isValidNumber(start) || !isValidNumber(end)) {
      return false;
    }
    return Number.parseInt(start, 10) <= Number.parseInt(end, 10);
  };

  const stepParts = field.split('/');
  if (stepParts.length > 2) {
    return false;
  }
  if (stepParts.length === 2) {
    const [base, step] = stepParts;
    if (
      !base ||
      !step ||
      !isValidNumber(step) ||
      Number.parseInt(step, 10) <= 0
    ) {
      return false;
    }
    if (base === '*') {
      return true;
    }
    if (base.includes(',')) {
      return false;
    }
    return base.includes('-') ? isValidRange(base) : isValidNumber(base);
  }

  if (field.includes(',')) {
    return field
      .split(',')
      .every((part) =>
        part.includes('-') ? isValidRange(part) : isValidNumber(part)
      );
  }
  if (field.includes('-')) {
    return isValidRange(field);
  }
  return isValidNumber(field);
}

/**
 * True when `cron` is a 5-field cron expression GitHub Actions accepts:
 * numbers, ranges, lists and `/step` (step >= 1) within each field's
 * bounds, plus three-letter month and weekday names in lists and ranges.
 * Macros such as `@hourly` are rejected.
 */
export function isValidCronExpression(cron: string): boolean {
  const parts = splitCron(cron);
  if (parts.length !== 5) {
    return false;
  }

  return parts.every((part, index) => {
    const range = FIELD_RANGES[index];
    return isValidCronField(part, range.min, range.max);
  });
}

function expandField(field: string, min: number, max: number): Set<number> {
  const values = new Set<number>();
  for (const part of field.split(',')) {
    const [rangePart, stepPart] = part.split('/');
    const step = stepPart ? Number.parseInt(stepPart, 10) : 1;
    let start = min;
    let end = max;
    if (rangePart !== '*') {
      const [a, b] = rangePart.split('-');
      start = Number.parseInt(a, 10);
      end = b === undefined ? (stepPart ? max : start) : Number.parseInt(b, 10);
    }
    for (let v = start; v <= end; v += step) {
      values.add(v);
    }
  }
  return values;
}

/**
 * Longest gap in minutes between two consecutive fire times of a 5-field
 * cron expression (UTC, as GitHub Actions evaluates it), measured over the
 * coming 800 days, so yearly schedules are covered. Returns null when the
 * expression is invalid or fires fewer than twice in that window.
 */
export function cronMaxIntervalMinutes(
  cron: string,
  from: Date = new Date()
): number | null {
  if (!isValidCronExpression(cron)) return null;
  const fields = splitCron(cron);
  const [minutes, hours, days, months, weekdays] = fields.map((field, i) =>
    expandField(field, FIELD_RANGES[i].min, FIELD_RANGES[i].max)
  );
  if (weekdays.has(7)) weekdays.add(0);
  const domRestricted = fields[2] !== '*';
  const dowRestricted = fields[4] !== '*';

  const sortedHours = [...hours].sort((a, b) => a - b);
  const sortedMinutes = [...minutes].sort((a, b) => a - b);
  const startDay = Date.UTC(
    from.getUTCFullYear(),
    from.getUTCMonth(),
    from.getUTCDate()
  );
  let previous: number | null = null;
  let maxGap: number | null = null;
  for (let day = 0; day < 800; day++) {
    const date = new Date(startDay + day * 86_400_000);
    if (!months.has(date.getUTCMonth() + 1)) continue;
    const domMatch = days.has(date.getUTCDate());
    const dowMatch = weekdays.has(date.getUTCDay());
    const dayMatch =
      domRestricted && dowRestricted
        ? domMatch || dowMatch
        : domMatch && dowMatch;
    if (!dayMatch) continue;
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const at = day * 1440 + hour * 60 + minute;
        if (previous !== null) {
          const gap = at - previous;
          maxGap = maxGap === null ? gap : Math.max(maxGap, gap);
        }
        previous = at;
      }
    }
  }
  return maxGap;
}

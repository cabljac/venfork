const FIELD_RANGES = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12 },
  { min: 0, max: 7 },
] as const;

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
 * coming 400 days. Returns null when the expression fires fewer than twice
 * in that window. Assumes the expression is already valid.
 */
export function cronMaxIntervalMinutes(
  cron: string,
  from: Date = new Date()
): number | null {
  const fields = cron.trim().split(/\s+/);
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
  for (let day = 0; day < 400; day++) {
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

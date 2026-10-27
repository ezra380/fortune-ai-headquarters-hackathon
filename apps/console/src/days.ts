// Company days. The company's day is the New York date (docs/wave2.md), so "the last seven days" is counted in that
// calendar, whatever time zone this computer is in.

const NEW_YORK_DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Today's date in New York, YYYY-MM-DD. */
export const newYorkDay = (now: Date): string => NEW_YORK_DAY.format(now);

/** A YYYY-MM-DD day moved by whole days (noon UTC, so no daylight-saving hour can move it to another date). */
export function addDays(day: string, days: number): string {
  const moved = new Date(`${day}T12:00:00Z`);
  moved.setUTCDate(moved.getUTCDate() + days);
  return moved.toISOString().slice(0, 10);
}

/** The first of the last seven company days: today and the six before it. */
export const weekStart = (now: Date): string => addDays(newYorkDay(now), -6);

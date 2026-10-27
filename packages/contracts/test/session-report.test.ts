import { describe, expect, it } from 'vitest';
import { SESSION_REPORT_MAX_BYTES, SessionReport } from '../src/index.ts';

// The report an outside AI tool files at a door. The database (door_file_report) enforces the same limits.

const base = { tool: 'claude-code', summary: 'Checked the finance numbers.' };

describe('SessionReport', () => {
  it('takes a summary and a tool, and the three optional lists', () => {
    expect(SessionReport.parse(base)).toEqual(base);
    const full = {
      ...base, key: 'abcd1234:efgh.5678',
      steps: [{ step: 'Read the metrics' }], suggestions: [{ text: 'Add ad spend' }], lessons: [{ text: 'Ask for the period' }],
    };
    expect(SessionReport.parse(full)).toEqual(full);
  });

  it('keeps the limits the database checks', () => {
    const bad = (over: Record<string, unknown>) => SessionReport.safeParse({ ...base, ...over }).success;
    expect(bad({ tool: '' })).toBe(false);
    expect(bad({ tool: 'x'.repeat(61) })).toBe(false);
    expect(bad({ tool: 'x'.repeat(60) })).toBe(true);
    expect(bad({ summary: '' })).toBe(false);
    expect(bad({ summary: 'x'.repeat(2001) })).toBe(false);
    expect(bad({ summary: 'x'.repeat(2000) })).toBe(true);
    expect(bad({ steps: Array.from({ length: 31 }, () => ({ step: 'a' })) })).toBe(false);
    expect(bad({ steps: [{ step: 'x'.repeat(81) }] })).toBe(false);
    expect(bad({ suggestions: Array.from({ length: 11 }, () => ({ text: 'a' })) })).toBe(false);
    expect(bad({ suggestions: [{ text: 'x'.repeat(301) }] })).toBe(false);
    expect(bad({ lessons: [{ text: 'x'.repeat(301) }] })).toBe(false);
    expect(bad({ lessons: [{ text: '' }] })).toBe(false);
  });

  it('keeps the key to the characters the database accepts, and refuses a field it does not know', () => {
    const key = (k: string) => SessionReport.safeParse({ ...base, key: k }).success;
    expect(key('short')).toBe(false);
    expect(key('has a space in it')).toBe(false);
    expect(key('x'.repeat(81))).toBe(false);
    expect(key('ok-key_1.2:3')).toBe(true);
    expect(SessionReport.safeParse({ ...base, assistant: 'owner' }).success).toBe(false);
    expect(SessionReport.safeParse({ ...base, steps: [{ step: 'a', outcome: 'ok' }] }).success).toBe(false);
  });

  it('caps a report at 30 KB, inside the database\'s 32 KB', () => {
    expect(SESSION_REPORT_MAX_BYTES).toBe(30 * 1024);
    expect(SESSION_REPORT_MAX_BYTES).toBeLessThan(32 * 1024);
  });
});

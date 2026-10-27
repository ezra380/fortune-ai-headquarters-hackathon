import { describe, expect, it } from 'vitest';
import { codePattern, hasCode, hasPhone, maskPhonesAndCodes, phonePattern } from '../src/index.ts';
import { REDACT_SAMPLES } from './redact-samples.ts';

// What counts as a phone number or a one-time code: one definition for the database, the lesson rules and the read tools.

describe('maskPhonesAndCodes', () => {
  it.each(REDACT_SAMPLES)('turns %j into %j', (input, expected) => {
    expect(maskPhonesAndCodes(input)).toBe(expected);
  });

  it('says what it found, the same way', () => {
    for (const [input, expected] of REDACT_SAMPLES) {
      expect(hasPhone(input) || hasCode(input), input).toBe(expected !== input);
    }
    expect(hasPhone('Texted (718)555-1234')).toBe(true);
    expect(hasPhone('the code is 482-913')).toBe(false);
    expect(hasCode('the code is 482-913')).toBe(true);
  });

  it('never carries state from one call to the next', () => {
    for (let i = 0; i < 3; i++) {
      expect(hasPhone('call 718-5551234')).toBe(true);
      expect(hasCode('code 482913')).toBe(true);
    }
    expect(phonePattern()).not.toBe(phonePattern());
    expect(codePattern().lastIndex).toBe(0);
  });
});

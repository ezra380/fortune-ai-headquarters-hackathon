// Strings with the answer both maskers must give: maskPhonesAndCodes (packages/contracts/src/redact.ts, used by the lesson
// rules and the read tools) and public.redact_text (the database, which masks every report an outside tool files). The
// contracts test runs them through the first, supabase/tests/profiles.test.ts through the second; one list keeps them equal.

/** [input, what both must return]. */
export const REDACT_SAMPLES: readonly (readonly [string, string])[] = [
  // A United States number in every spacing people write it.
  ['(718)555-1234', '[phone]'],
  ['718 5551234', '[phone]'],
  ['call 718-5551234', 'call [phone]'],
  ['718-555-1234', '[phone]'],
  ['(917) 555-0123', '[phone]'],
  ['917.555.0123', '[phone]'],
  ['9175550123', '[phone]'],
  ['1 718 555 1234', '[phone]'],
  ['1-718-555-1234', '[phone]'],
  ['17185551234', '[phone]'],
  ['+1 (718) 555-1234', '[phone]'],
  ['+15551234567', '[phone]'],
  ['Called 718-555-1234, then (212) 555 0100.', 'Called [phone], then [phone].'],
  // A number with another country code.
  ['+44 20 7946 0958', '[phone]'],
  // A one-time code, whole or in two groups.
  ['the code was 123456', 'the code was [code]'],
  ['code 482-913', 'code [code]'],
  ['code 482 913 now', 'code [code] now'],
  ['SEND 2 482913', 'SEND 2 [code]'],
  // Ordinary figures stay: money, counts, dates, times, decimals, versions and ids.
  ['Cost $120000, 1,234,567 tokens, 12345 and 1234567.', 'Cost $120000, 1,234,567 tokens, 12345 and 1234567.'],
  ['2026-10-27 at 09:15', '2026-10-27 at 09:15'],
  ['12400 and 18600', '12400 and 18600'],
  ['1500 tokens in 3000 out', '1500 tokens in 3000 out'],
  ['revenue 1,200.50 dollars', 'revenue 1,200.50 dollars'],
  ['$482913', '$482913'],
  ['482913.5 percent', '482913.5 percent'],
  ['v1.2.3 and 12,400,000', 'v1.2.3 and 12,400,000'],
  ['task 3f2a1b4c-1234-5678-9abc-def012345678', 'task 3f2a1b4c-1234-5678-9abc-def012345678'],
];

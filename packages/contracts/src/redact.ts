// What counts as a phone number or a one-time code, in ONE place. The database (public.redact_text), the text rules
// for a lesson or a review (packages/profiles) and the read tools' scrub (apps/worker) all use these two shapes, so a
// format one of them misses is missed by none: a test runs the same sample strings through the database function
// and through maskPhonesAndCodes and requires the same answer (supabase/tests/profiles.test.ts).
//
// Over-masking is the safe side: any ten-digit number, any phone written with spaces, dots, dashes or brackets, and
// any lone six-digit group (also written 482-913 or 482 913) is replaced.
//
// An email address is a third shape, masked only by the report path (maskContactDetails, and public.redact_text from
// migration 20261027130020): a contract carries its parties' notice addresses, and an outside session must not file them.
// maskPhonesAndCodes, which the lesson rules and the read tools use, is unchanged.

/** A phone number: +<country code> with its digits, or a US/Canada number in any spacing, with or without a leading 1 or +1. */
export const PHONE_SOURCE = String.raw`\+\d[\d ().-]{7,18}\d|(?<!\d)(?:\+?1[ .-]?)?\(?\d{3}\)?[ .-]?\d{3}[ .-]?\d{4}(?!\d)`;

/** A one-time code: six digits on their own, or two groups of three split by a space or a dash. Not part of an amount. */
export const CODE_SOURCE = String.raw`(?<![\d.,$])\d{3}[ -]?\d{3}(?!\d)(?!\.\d)`;

/** Fresh expressions on every call, so a caller can never trip over the state of a shared global one. */
export const phonePattern = () => new RegExp(PHONE_SOURCE, 'g');
export const codePattern = () => new RegExp(CODE_SOURCE, 'g');

export const hasPhone = (text: string): boolean => new RegExp(PHONE_SOURCE).test(text);
export const hasCode = (text: string): boolean => new RegExp(CODE_SOURCE).test(text);

/** The text with every phone number replaced by [phone] and every code by [code] (the same masks the database writes). */
export function maskPhonesAndCodes(text: string): string {
  return text.replace(phonePattern(), '[phone]').replace(codePattern(), '[code]');
}

/**
 * An email address: letters, digits and . _ % + - before the @, then a domain with at least one dot. An address is
 * masked before a phone or a code, so the digits inside one never turn into [code]. Same text as public.redact_text.
 */
export const EMAIL_SOURCE = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+`;
export const emailPattern = () => new RegExp(EMAIL_SOURCE, 'g');
export const hasEmail = (text: string): boolean => new RegExp(EMAIL_SOURCE).test(text);

/** The text with every email replaced by [email], every phone by [phone] and every code by [code]: exactly what public.redact_text writes. */
export function maskContactDetails(text: string): string {
  return text.replace(emailPattern(), '[email]').replace(phonePattern(), '[phone]').replace(codePattern(), '[code]');
}

import { maskPhonesAndCodes } from '@fahq/contracts';

const EMAIL = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;

/**
 * What a person may read in a report, a PDF or an email: no address, no phone number, no one-time code. The words
 * of a report come from a model and from data, so this is the last line of defence before they leave the program.
 */
export const scrub = (text: string): string => maskPhonesAndCodes(text.replace(EMAIL, '[email]'));

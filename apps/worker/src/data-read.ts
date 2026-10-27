import { maskPhonesAndCodes } from '@fahq/contracts';

// One read of the business data, wherever the worker makes it: the read tools, a plan round, the plan writer and a
// division's brief. A provider's own text (an HTTP body, SQL, a host name) never reaches a script, a receipt, a task's
// error or a person: they get one fixed sentence with a code, and the log gets the detail with any phone number, code
// or email masked (Law 7). Tests: read-tools.test.ts "keeps the provider's text away from the script", units.test.ts
// "keeps the data source's own text out of its failure", chain.test.ts "says plainly when business data ... cannot be
// read", brief.test.ts and brief-flow.test.ts (the numbers cannot be read).

/** What a person, a receipt or a script is told when a read of the business data fails. */
export const DATA_READ_FAILED = 'Business data could not be read (ZETARIS_READ).';

const EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g;

export async function readData<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (error) {
    const detail = maskPhonesAndCodes(error instanceof Error ? `${error.name}: ${error.message}` : 'unknown').replace(EMAIL, '[email]');
    console.error(`worker.zetaris_read_failed ${detail.slice(0, 300)}`);
    throw new Error(DATA_READ_FAILED);
  }
}

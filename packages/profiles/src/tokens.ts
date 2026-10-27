import { createHash, randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AssistantId } from '@fahq/contracts';
import type { Queryable } from './seed.ts';

// Door tokens: the secret an outside AI tool presents to read one assistant's profile and file its report.
// The database keeps only the SHA-256 of a token (public.door_tokens), so a leaked table gives nobody a token.
// A token is 256 random bits, so a plain hash is enough; there is nothing to guess and nothing to salt.

/** The hash the database compares against: the SHA-256 of the token's UTF-8 bytes, as lowercase hex. */
export const tokenHash = (token: string): string => createHash('sha256').update(token, 'utf8').digest('hex');

/** `fahq_` and 43 URL-safe characters (48 in all), which is what the database accepts (32 to 128 of A-Z a-z 0-9 _ -). */
export const newDoorToken = (): string => `fahq_${randomBytes(32).toString('base64url')}`;

/** Registers a new token for an assistant (only its hash is stored) and returns it once. */
export async function issueDoorToken(db: Queryable, assistant: AssistantId, label: string, token: string = newDoorToken()): Promise<{ id: string; token: string }> {
  const { rows } = await db.query(
    'insert into public.door_tokens (assistant_id, token_hash, label) values ($1, $2, $3) returning id',
    [assistant, tokenHash(token), label],
  );
  return { id: String(rows[0]?.id), token };
}

/**
 * Writes the token to `<dir>/<assistant>.token`, readable by its owner only, and returns the path. An existing
 * file is never overwritten unless `replace` is set (the old token then stays valid until it is revoked).
 */
export function writeTokenFile(dir: string, assistant: AssistantId, token: string, options: { replace?: boolean } = {}): string {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${assistant}.token`);
  if (fs.existsSync(file) && !options.replace) {
    throw new Error(`a token file already exists at ${file}; remove it, or pass --replace (the old token stays valid until it is revoked)`);
  }
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600); // the mode above only applies when the file is new
  return file;
}

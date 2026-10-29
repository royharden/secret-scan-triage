// Eval-only private identity state. Fresh leak-guard salts remain session-only and are never persisted.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
export async function evalIdentitySalt(root: string): Promise<Uint8Array> {
  const directory = join(root, '.eval-local'); const path = join(directory, 'identity-salt.bin');
  await mkdir(directory, { recursive: true });
  const validate = (bytes: Uint8Array) => { if (bytes.length !== 32) throw new Error(''); return new Uint8Array(bytes); };
  try { return validate(await readFile(path)); }
  catch (error) { if ((error as { code?: string }).code !== 'ENOENT') throw new Error(''); }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(32));
  try { await writeFile(path, salt, { flag: 'wx', mode: 0o600 }); return salt; }
  catch (error) { if ((error as { code?: string }).code !== 'EEXIST') throw new Error(''); return validate(await readFile(path)); }
}

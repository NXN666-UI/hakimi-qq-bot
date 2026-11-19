import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export function prepareLocalPaths() {
  const data = path.join(ROOT, 'data'), temp = path.join(data, 'tmp'), cache = path.join(data, 'cache');
  for (const folder of [data, temp, cache, path.join(ROOT, 'logs')]) fs.mkdirSync(folder, { recursive: true });
  // These also apply when a diagnostic is invoked directly rather than via launcher.cmd.
  process.env.TEMP = temp;
  process.env.TMP = temp;
  process.env.TMPDIR = temp;
  process.env.XDG_CACHE_HOME = cache;
  process.env.NODE_REPL_HISTORY = path.join(cache, 'node-repl-history');
  return { data, temp, cache, logs: path.join(ROOT, 'logs') };
}

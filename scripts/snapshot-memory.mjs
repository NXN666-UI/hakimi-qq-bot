import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ROOT, prepareLocalPaths } from '../src/paths.mjs';
prepareLocalPaths();
const source = path.join(ROOT, 'data', 'memory', 'memories.sqlite');
if (!fs.existsSync(source)) process.exit(0);
const destination = path.resolve(process.argv[2] ?? '');
const temporaryRoot = path.join(ROOT, 'data', 'tmp') + path.sep;
if (!destination.toLowerCase().startsWith(temporaryRoot.toLowerCase()) || path.extname(destination) !== '.sqlite' || fs.existsSync(destination)) throw Error('记忆快照目标必须是项目临时目录中的新sqlite文件');
const db = new DatabaseSync(source, { readOnly: true });
try {
  db.exec('PRAGMA busy_timeout=5000; PRAGMA temp_store=MEMORY;');
  db.prepare('VACUUM INTO ?').run(destination);
  const check = new DatabaseSync(destination, { readOnly: true });
  try { if (check.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('记忆快照校验失败'); } finally { check.close(); }
  console.log('已生成一致的本地记忆快照');
} finally { db.close(); }

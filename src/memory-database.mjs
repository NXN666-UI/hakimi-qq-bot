import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';

const pools = new Map();
export class MemoryDatabase {
  constructor(file, maxBytes) {
    this.file = file;
    let shared = pools.get(file);
    if (!shared) {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      const db = new DatabaseSync(file);
      try {
        db.exec('PRAGMA busy_timeout=5000; PRAGMA journal_mode=DELETE; PRAGMA temp_store=MEMORY; PRAGMA secure_delete=ON; PRAGMA auto_vacuum=FULL;');
        const pageSize = db.prepare('PRAGMA page_size').get().page_size;
        if (db.prepare('PRAGMA page_count').get().page_count * pageSize > maxBytes) throw Error('记忆库已超过配置空间');
        db.exec(`PRAGMA max_page_count=${Math.floor(maxBytes / pageSize)};`);
        if (db.prepare('PRAGMA quick_check').get().quick_check !== 'ok') throw Error('记忆数据库校验失败');
        db.exec('CREATE TABLE IF NOT EXISTS memory_buckets (namespace TEXT NOT NULL, scope TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace,scope)); CREATE TABLE IF NOT EXISTS memory_migrations(namespace TEXT PRIMARY KEY, source_hash TEXT NOT NULL);');
      } catch (error) { db.close(); throw error; }
      shared = { db, users: 0, maxBytes }; pools.set(file, shared);
    }
    if (shared.maxBytes !== maxBytes) throw Error('群聊与私聊记忆空间配置不一致');
    this.shared = shared; shared.users++;
  }
  get db() { return this.shared.db; }
  get(namespace, scope) {
    const row = this.db.prepare('SELECT payload FROM memory_buckets WHERE namespace=? AND scope=?').get(namespace, scope);
    return row ? JSON.parse(row.payload) : { records: [], handover: [] };
  }
  entries(namespace) { return this.db.prepare('SELECT scope,payload FROM memory_buckets WHERE namespace=?').all(namespace).map(r => [r.scope, JSON.parse(r.payload)]); }
  set(namespace, scope, bucket) {
    if (!bucket.records.length && !bucket.handover.length) this.db.prepare('DELETE FROM memory_buckets WHERE namespace=? AND scope=?').run(namespace, scope);
    else this.db.prepare('INSERT INTO memory_buckets VALUES(?,?,?) ON CONFLICT(namespace,scope) DO UPDATE SET payload=excluded.payload').run(namespace, scope, JSON.stringify(bucket));
  }
  setMany(namespace, entries) {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [scope, bucket] of entries) this.set(namespace, scope, bucket);
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  migrate(namespace, source, validate) {
    const done = this.db.prepare('SELECT source_hash FROM memory_migrations WHERE namespace=?').get(namespace);
    if (done) {
      if (fs.existsSync(source)) {
        const hash = createHash('sha256').update(fs.readFileSync(source)).digest('hex');
        if (hash !== done.source_hash) throw Error('迁移后旧记忆文件另有修改，未删除，请检查');
        fs.unlinkSync(source);
      }
      return;
    }
    const raw = fs.existsSync(source) ? fs.readFileSync(source) : null;
    if (raw && raw.length > 2 * 1024 * 1024) throw Error('旧记忆文件过大，未迁移');
    const state = raw ? JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')) : { version: 1, groups: {} };
    validate(state);
    if (this.entries(namespace).length) throw Error('记忆命名空间已有数据但无迁移标记，拒绝覆盖');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [scope, bucket] of Object.entries(state.groups)) this.set(namespace, scope, bucket);
      for (const [scope, bucket] of Object.entries(state.groups)) {
        if (JSON.stringify(this.get(namespace, scope)) !== JSON.stringify(bucket)) throw Error('记忆迁移逐条核对失败');
      }
      this.db.prepare('INSERT INTO memory_migrations VALUES(?,?)').run(namespace, raw ? createHash('sha256').update(raw).digest('hex') : 'no-legacy-file');
      this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
    // Delete only after transaction commit and exact comparison. Never back up
    // the legacy file, or re-import it after explicit forget/clear operations.
    if (raw) fs.unlinkSync(source);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    if (--this.shared.users === 0) { this.db.close(); pools.delete(this.file); }
  }
}

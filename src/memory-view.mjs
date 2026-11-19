import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { MemoryStore } from './memory.mjs';

// Read only. Never instantiate an enabled MemoryStore here: viewing must not
// migrate, prune, reinforce, create a missing database or rewrite a memory.
export function memoryView(root, config, { scope = '', now = Date.now(), scrub = String } = {}) {
  const choices = [...config.allowedGroups.map(id => ({ key: `group/${id}`, kind: 'group', id, namespace: 'memory', label: `群 ${id}` })), { key: `private/${config.ownerQQ}`, kind: 'private', id: config.ownerQQ, namespace: 'private-memory', label: '管理员 私聊（独立）' }];
  const selected = scope ? choices.find(c => c.key === scope) : null;
  if (scope && !selected) throw Error('只能查看已配置的群或管理员私聊');
  const policy = new MemoryStore('', { ...config.memory, enabled: false }, config.ownerQQ, { clock: () => now });
  const file = path.join(root, 'data', 'memory', 'memories.sqlite');
  const result = { readAt: now, storage: config.memory.storage, bytes: fs.existsSync(file) ? fs.statSync(file).size : 0, limits: { mode: config.memory.mode, maxPeople: config.memory.maxPeople, perGroup: config.memory.maxRecordsPerGroup, perUser: config.memory.maxRecordsPerUser, bytes: config.memory.storageMaxBytes, forgettingDays: config.memory.forgettingDays }, groupUsage: { people: 0, records: 0 }, scopes: [], selected: scope || null, records: [], snippets: [] };
  let db;
  try {
    if (config.memory.storage === 'sqlite' && fs.existsSync(file)) {
      db = new DatabaseSync(file, { readOnly: true });
      db.exec('PRAGMA query_only=ON; PRAGMA busy_timeout=1500; PRAGMA temp_store=MEMORY; BEGIN');
    }
    let groupBuckets = [];
    if (db) groupBuckets = db.prepare('SELECT payload FROM memory_buckets WHERE namespace=?').all('memory').map(row => JSON.parse(row.payload));
    else if (config.memory.storage === 'json') {
      const source = path.join(root, 'data', 'memory.json');
      if (fs.existsSync(source) && fs.statSync(source).size <= 2 * 1024 * 1024) groupBuckets = Object.values(JSON.parse(fs.readFileSync(source, 'utf8')).groups ?? {});
    }
    const groupRecords = groupBuckets.flatMap(b => b.records).filter(r => policy.active(r));
    result.groupUsage = { people: new Set(groupRecords.map(r => r.user)).size, records: groupRecords.length };
    for (const choice of choices) {
      let bucket = { records: [], handover: [] };
      if (db) {
        const row = db.prepare('SELECT payload FROM memory_buckets WHERE namespace=? AND scope=?').get(choice.namespace, choice.id);
        if (row) bucket = JSON.parse(row.payload);
      } else if (config.memory.storage === 'json') {
        const source = path.join(root, 'data', choice.namespace + '.json');
        if (fs.existsSync(source)) {
          if (fs.statSync(source).size > 2 * 1024 * 1024) throw Error('旧记忆文件过大，未读取');
          bucket = JSON.parse(fs.readFileSync(source, 'utf8')).groups?.[choice.id] ?? bucket;
        }
      }
      const active = bucket.records.filter(r => policy.active(r));
      result.scopes.push({ key: choice.key, kind: choice.kind, id: choice.id, label: choice.label, activeRecords: active.length, people: new Set(active.map(r => r.user)).size, pendingExpired: bucket.records.length - active.length });
      if (choice !== selected) continue;
      result.records = bucket.records.map(r => ({ id: r.id, qq: r.user, name: scrub(r.name || '群友'), text: scrub(r.text), kind: r.kind, strength: r.strength ?? 1, updatedAt: r.updatedAt, expiresAt: r.kind === 'manual' ? null : r.updatedAt + policy.retentionDays(r) * 86400000, active: policy.active(r), weight: policy.salience(r) })).sort((a, b) => Number(b.active) - Number(a.active) || b.updatedAt - a.updatedAt);
      result.snippets = bucket.handover.map(r => ({ qq: r.user, name: scrub(r.isSelf ? '哈基米' : r.name || '群友'), text: scrub(r.text), time: r.time, expiresAt: r.time + config.memory.handoverTtlDays * 86400000, active: now - r.time <= config.memory.handoverTtlDays * 86400000 }));
    }
    if (db) db.exec('COMMIT');
  } finally { db?.close(); }
  return result;
}

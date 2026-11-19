import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/paths.mjs';
import { Lifecycle } from '../src/lifecycle.mjs';
import { PersonaFile } from '../src/persona-file.mjs';
import { atomicJson } from '../src/storage.mjs';

test('本地关闭绑定进程启动时间；旧PID请求、坏JSON均不会关闭新实例', t => {
  fs.mkdirSync(path.join(ROOT, 'test-output'), { recursive: true });
  const root = fs.mkdtempSync(path.join(ROOT, 'test-output', 'lifecycle-'));
  let stopped = 0, connected = false;
  const lifecycle = new Lifecycle(root, { pid: 42, startedAt: '2026-11-12T00:00:00Z', state: () => ({ connected }), stop: () => { stopped++; lifecycle.close(); } });
  t.after(() => lifecycle.close());
  const file = path.join(root, 'data', 'stop-request.json');
  atomicJson(file, { pid: 42, startedAt: '2026-11-11T00:00:00Z' });
  lifecycle.poll(); assert.equal(stopped, 0);
  fs.writeFileSync(file, '{'); lifecycle.poll(); assert.equal(stopped, 0);
  connected = true; fs.unlinkSync(file); lifecycle.poll();
  assert.equal(JSON.parse(fs.readFileSync(lifecycle.file)).connected, true);
  atomicJson(file, { pid: 42, startedAt: lifecycle.startedAt }); lifecycle.poll();
  assert.equal(stopped, 1); assert.equal(fs.existsSync(file), false);
  assert.equal(JSON.parse(fs.readFileSync(lifecycle.file)).stopped, true);
});

test('人设文件保存后读新版本，空白或过大编辑保留上一份而不重复刷错误日志', () => {
  const parent = path.join(ROOT, 'test-output'); fs.mkdirSync(parent, { recursive: true });
  const directory = fs.mkdtempSync(path.join(parent, 'persona-')), file = path.join(directory, 'persona.md'), logs = [];
  fs.writeFileSync(file, '旧人设'); const source = new PersonaFile(file, '旧人设', value => logs.push(value));
  fs.writeFileSync(file, '新的人设'); assert.equal(source.read(), '新的人设');
  fs.writeFileSync(file, ''); assert.equal(source.read(), '新的人设'); assert.equal(source.read(), '新的人设');
  assert.equal(logs.filter(line => line.includes('暂不可读')).length, 1);
  fs.writeFileSync(file, '字'.repeat(30000)); assert.equal(source.read(), '新的人设');
  fs.writeFileSync(file, '恢复的完整人设'); assert.equal(source.read(), '恢复的完整人设');
});

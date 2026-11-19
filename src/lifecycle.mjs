import fs from 'node:fs';
import path from 'node:path';
import { atomicJson } from './storage.mjs';

// A stop request belongs to one process instance, never to a reused PID.
export class Lifecycle {
  constructor(root, { pid = process.pid, startedAt = new Date().toISOString(), state, stop, control, intervalMs = 500 } = {}) {
    this.file = path.join(root, 'data', 'runtime-status.json');
    this.requestFile = path.join(root, 'data', 'stop-request.json');
    this.uiRequest = path.join(root, 'data', 'ui-command.json'); this.uiResult = path.join(root, 'data', 'ui-command-result.json');
    Object.assign(this, { pid, startedAt, state, stop, control });
    this.publish();
    this.timer = setInterval(() => this.poll(), intervalMs);
  }
  publish(stopped = false) {
    const value = { version: 1, pid: this.pid, startedAt: this.startedAt, ...this.state(), stopped };
    const signature = JSON.stringify(value);
    if (signature === this.signature) return;
    atomicJson(this.file, value); this.signature = signature;
  }
  poll() {
    try {
      if (fs.existsSync(this.requestFile)) {
        const request = JSON.parse(fs.readFileSync(this.requestFile, 'utf8'));
        if (request.pid === this.pid && request.startedAt === this.startedAt) {
          fs.unlinkSync(this.requestFile); this.stop(); return;
        }
      }
      if (this.control && fs.existsSync(this.uiRequest)) {
        const request = JSON.parse(fs.readFileSync(this.uiRequest, 'utf8'));
        fs.unlinkSync(this.uiRequest);
        if (request.pid === this.pid && request.startedAt === this.startedAt && /^[a-f0-9]{32}$/.test(request.id) && ['pause', 'resume', 'refresh'].includes(request.action)) {
          let success = false; try { this.control(request.action); success = true; } catch {}
          atomicJson(this.uiResult, { id: request.id, success });
        }
      }
      this.publish();
    } catch { /* A transient external edit must not crash the chat process. */ }
  }
  close() { clearInterval(this.timer); try { this.publish(true); } catch {} }
}

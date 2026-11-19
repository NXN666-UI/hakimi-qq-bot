import fs from 'node:fs';

// Read only the configured persona file on a new reply; editing the persona
// must not require dropping active conversations by restarting the bot.
export class PersonaFile {
  constructor(file, initial, log = () => {}) { Object.assign(this, { file, text: initial, log }); this.failed = false; }
  read() {
    try {
      const stat = fs.lstatSync(this.file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) throw Error();
      const next = fs.readFileSync(this.file, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!next) throw Error();
      if (next !== this.text.trim()) { this.text = next; this.log('已载入人设修改，当前聊天窗口保留'); }
      this.failed = false;
    } catch {
      if (!this.failed) this.log('新的人设文件暂不可读，继续使用上一份完整人设');
      this.failed = true;
    }
    return this.text;
  }
}

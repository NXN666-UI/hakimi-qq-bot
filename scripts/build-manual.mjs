import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../src/paths.mjs';

const escape = s => s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const inline = s => escape(s).replace(/`([^`]+)`/g, '<code>$1</code>');
const markdown = fs.readFileSync(path.join(ROOT, 'docs', '操作手册.md'), 'utf8');
const toc = [], output = []; let list = false, table = false, section = 0;
function close() { if (list) { output.push('</ul>'); list = false; } if (table) { output.push('</tbody></table></div>'); table = false; } }
for (const line of markdown.split(/\r?\n/)) {
  if (!line.trim()) { close(); continue; }
  const heading = line.match(/^(#{1,3}) (.+)$/);
  if (heading) {
    close(); const level = heading[1].length, id = `s${section++}`;
    output.push(`<h${level} id="${id}">${inline(heading[2])}</h${level}>`);
    if (level === 2) toc.push(`<a href="#${id}">${inline(heading[2])}</a>`);
    continue;
  }
  if (line.startsWith('|')) {
    const cells = line.split('|').slice(1, -1).map(x => x.trim());
    if (cells.every(x => /^:?-+:?$/.test(x))) continue;
    if (!table) { close(); output.push('<div class="table"><table><thead><tr>' + cells.map(x => `<th>${inline(x)}</th>`).join('') + '</tr></thead><tbody>'); table = true; }
    else output.push('<tr>' + cells.map(x => `<td>${inline(x)}</td>`).join('') + '</tr>');
    continue;
  }
  if (/^(?:- |\d+\. )/.test(line)) {
    if (!list) { close(); output.push('<ul>'); list = true; }
    output.push(`<li>${inline(line.replace(/^- /, ''))}</li>`); continue;
  }
  close(); output.push(`<p>${inline(line)}</p>`);
}
close();
const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>哈基米操作手册</title><style>
*{box-sizing:border-box}html{scroll-behavior:smooth}body{margin:0;background:#f5f4fa;color:#282334;font:16px/1.85 "Microsoft YaHei",system-ui,sans-serif}aside{position:fixed;inset:0 auto 0 0;width:260px;padding:28px 20px;background:#30253f;color:white;overflow:auto}aside b{font-size:24px}aside a{display:block;color:#e8dff3;text-decoration:none;padding:8px;border-radius:6px;font-size:14px}aside a:hover{background:#4d3b65}main{margin-left:260px;padding:35px 5vw 80px;max-width:1380px}h1{font-size:34px}h2{margin-top:48px;padding-top:16px;border-top:2px solid #dcd4e9;color:#6a378b}h3{font-size:20px}p,li{overflow-wrap:anywhere}.table{overflow:auto;margin:20px 0}table{width:100%;border-collapse:collapse;background:white;font-size:14px}td,th{text-align:left;border:1px solid #ded9e7;padding:10px 14px;min-width:100px;overflow-wrap:anywhere}th{background:#eae2f2}tr:nth-child(even){background:#faf8fc}code{background:#e9e3ef;padding:2px 5px;border-radius:4px;font-family:Consolas,monospace}.notice{padding:18px;background:#e8f3ec;border-left:5px solid #48835d}button{border:0;border-radius:6px;background:#764393;color:white;padding:10px 18px;cursor:pointer}@media(max-width:900px){aside{position:static;width:auto}aside nav{display:grid;grid-template-columns:1fr 1fr}main{margin:0;padding:24px}}@media print{aside,button{display:none}main{margin:0;padding:0}body{background:white}h2{break-after:avoid}tr{break-inside:avoid}}
</style><aside><b>哈基米 · 操作手册</b><p>本机离线文档 · 2026-11-19</p><nav>${toc.join('')}</nav></aside><main><div class="notice">推荐入口：打开哈基米设置.cmd；查看记忆可双击查看哈基米记忆.cmd，也可用哈基米控制台的12。QQ与本机OneBot桥接需自行准备，本项目只控制聊天进程。</div><p><button onclick="window.print()">打印 / 保存PDF</button>　浏览器按 Ctrl+F 搜索参数或问题。</p>${output.join('\n')}</main></html>`;
fs.writeFileSync(path.join(ROOT, 'docs', '操作手册.html'), html);
console.log(`已生成离线手册：${toc.length}个章节，${markdown.length}字符。`);

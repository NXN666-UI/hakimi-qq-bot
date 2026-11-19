// Attributed quotes from this conversation's bounded RAM history; no LLM call.
export function earlierContext(history, { recentCount, ownerQQ, userQQ, excludeIds = [], maxChars = 900 }) {
  const excluded = new Set(excludeIds), candidates = [];
  for (const [index, row] of history.slice(0, -recentCount).entries()) {
    if (row.role !== 'user' || excluded.has(row.messageId)) continue;
    try {
      const data = JSON.parse(row.content);
      if (typeof data.text !== 'string' || !data.text.trim() || (!row.direct && data.qq !== ownerQQ && data.qq !== userQQ)) continue;
      if (/sk-[\w-]{6,}|Bearer\s|验证码|密码|身份证|住址|手机号|api.?key/i.test(data.text)) continue;
      const score = (row.direct ? 20 : 0) + (data.qq === userQQ ? 10 : 0) + (data.qq === ownerQQ ? 10 : 0);
      candidates.push({ index, score, line: JSON.stringify({ qq: data.qq, name: data.name, time: row.time, '稍早原话': Array.from(data.text).slice(0, 160).join('') }) });
    } catch { /* Never reinterpret malformed data. */ }
  }
  const chosen = []; let size = 0;
  for (const row of candidates.sort((a, b) => b.score - a.score || b.index - a.index)) {
    if (chosen.length >= 4) break;
    if (size + row.line.length + 1 <= maxChars) { chosen.push(row); size += row.line.length + 1; }
  }
  return chosen.sort((a, b) => a.index - b.index).map(row => row.line).join('\n');
}

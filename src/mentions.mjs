export function validMentionQQ(value) { return /^[1-9]\d{4,15}$/.test(String(value)) && Number.isSafeInteger(Number(value)); }

// Only accepted events in this group's bounded history and a verified quote
// supply candidates. Model text, names and QQ numbers inside message text don't.
export function mentionTargets(history, quoted, config) {
  const targets = new Set();
  const add = qq => { const value = String(qq); if (validMentionQQ(value) && value !== config.botQQ && !config.ignoredUsers.includes(value)) targets.add(value); };
  for (const row of history) {
    if (row.role !== 'user') continue;
    try { const data = JSON.parse(row.content); add(data.qq); if (Array.isArray(data.mentions)) data.mentions.slice(0, 10).forEach(add); } catch { /* not a group event */ }
  }
  if (quoted) add(quoted.qq);
  return targets;
}

// One optional routing marker, never an executable CQ fragment. Remove even
// invalid/unfinished markers so internal routing syntax cannot leak into QQ.
export function splitReplyMention(output, allowed = new Set()) {
  let mentionQQ = '';
  const body = output.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/\[CQ:[^\]]*\]/g, '').replace(/\[AT:([^\]]*)(\]|$)/giu, (_, value, close) => {
    if (close === ']' && !mentionQQ && validMentionQQ(value) && allowed.has(value)) mentionQQ = value;
    return '';
  });
  return { body, mentionQQ };
}

export function splitReplyStyle(output) {
  let style = '';
  const body = output.replace(/\[MODE:([^\]]*)(\]|$)/giu, (_, value, close) => {
    if (!style && close === ']' && ['plain', 'quote'].includes(value)) style = value;
    return '';
  });
  return { body, style };
}

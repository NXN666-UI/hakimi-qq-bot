export function validMessageId(value) { return /^-?\d{1,16}$/.test(String(value)) && Number.isSafeInteger(Number(value)); }

// Only this account's accepted group events, with a bounded in-memory cache.
export class QuoteStore {
  constructor({ clock = Date.now, ttlMs = 900000, maxEntries = 1000, parse }) { Object.assign(this, { clock, ttlMs, maxEntries, parse }); this.rows = new Map(); }
  trim() {
    for (const [key, row] of this.rows) if (this.clock() - row.seen > this.ttlMs || this.rows.size > this.maxEntries) this.rows.delete(key);
  }
  remember(event, parsed) {
    if (!validMessageId(event.message_id)) return;
    const group = String(event.group_id), id = String(event.message_id);
    const row = { id, group, qq: String(event.user_id), name: String(event.sender?.card || event.sender?.nickname || event.user_id).slice(0, 40), text: parsed.text.slice(0, 1200), seen: this.clock() };
    this.rows.set(`${group}:${id}`, row); this.trim();
    return row;
  }
  async resolve(group, id, bot, botQQ) {
    this.trim(); if (!validMessageId(id)) return null;
    const cached = this.rows.get(`${group}:${id}`);
    if (cached) return cached;
    try {
      const event = await bot.call('get_msg', { message_id: Number(id) });
      // get_msg may also return private messages or messages from other groups.
      if (event?.message_type !== 'group' || String(event.group_id) !== group || String(event.message_id ?? event.real_id) !== String(id) || !/^\d+$/.test(String(event.user_id))) return null;
      return this.remember(event, this.parse(event.message, botQQ));
    } catch { return null; }
  }
}

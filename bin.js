'use strict';
/** سلة الاستعادة: آخر 50 روم/رتبة محذوفة قابلة للاسترجاع من لوحة التحكم. */
module.exports = (ctx) => {
  const { client, app, auth, cfg, save, rid, chanSnap, chanOpts, discord: { ChannelType: T } } = ctx;
  const KINDS = [T.GuildText, T.GuildVoice, T.GuildCategory];

  function add(g, kind, d) {
    const c = cfg(g.id);
    (c.bin ??= []).unshift({ id: rid().slice(0, 8), kind, at: Date.now(), d });
    c.bin.length = Math.min(c.bin.length, 50);
    save();
  }
  client.on('channelDelete', (c) => {
    if (c.guild && KINDS.includes(c.type) && !ctx.tvGone?.has(c.id)) add(c.guild, 'ch', chanSnap(c.guild, c));
  });
  client.on('roleDelete', (r) => {
    if (!r.managed) add(r.guild, 'role', { name: r.name, color: r.color, hoist: r.hoist, perms: r.permissions.bitfield.toString() });
  });

  app.post('/api/bin/restore', auth, async (req, res) => {
    const g = req.g, c = cfg(g.id), e = (c.bin || []).find((x) => x.id === req.body.id);
    if (!e) return res.json({ ok: false, msg: 'غير موجود' });
    try {
      if (e.kind === 'ch') {
        const parent = e.d.parent && g.channels.cache.find((y) => y.name === e.d.parent && y.type === T.GuildCategory);
        await g.channels.create(chanOpts(g, e.d, parent));
      } else await g.roles.create({ name: e.d.name, color: e.d.color, hoist: e.d.hoist, permissions: BigInt(e.d.perms) });
      c.bin = c.bin.filter((x) => x.id !== e.id);
      save();
      ctx.addDlog?.(g, ctx.who(req), `استعادة ${e.kind === 'ch' ? 'روم' : 'رتبة'} من السلة: ${e.d.name}`);
      res.json({ ok: true });
    } catch { res.json({ ok: false, msg: 'فشل الاسترجاع: تأكد من صلاحيات البوت' }); }
  });
  app.post('/api/bin/delete', auth, (req, res) => { const c = cfg(req.g.id); c.bin = (c.bin || []).filter((x) => x.id !== req.body.id); save(); res.json({ ok: true }); });
  app.post('/api/bin/clear', auth, (req, res) => { cfg(req.g.id).bin = []; save(); res.json({ ok: true }); });
};

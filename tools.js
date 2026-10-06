'use strict';
/** أدوات لوحة التحكم: سجل الإجراءات، سجل اللوحة، الإمبد، المتصدرين، اسم البوت. */
module.exports = (ctx) => {
  const { app, auth, cfg, save, discord: { EmbedBuilder } } = ctx;
  const keep = (arr, n) => { if (arr.length > n) arr.length = n; };

  ctx.addAct = (g, type, uid, text) => {
    const c = cfg(g.id);
    (c.acts ??= []).unshift({ t: Date.now(), type: String(type).slice(0, 60), uid: uid || null, text: String(text || '').replace(/\*/g, '').slice(0, 300) });
    keep(c.acts, 200);
    save();
  };
  ctx.addDlog = (g, who, text) => {
    const c = cfg(g.id);
    (c.dlog ??= []).unshift({ t: Date.now(), who: String(who).slice(0, 60), text: String(text).slice(0, 300) });
    keep(c.dlog, 200);
    save();
  };

  app.post('/api/embed', auth, async (req, res) => {
    const b = req.body || {}, ch = req.g.channels.cache.get(b.channel);
    if (!ch?.isTextBased?.()) return res.json({ ok: false, msg: 'اختر قناة نصية' });
    const url = (u) => (/^https?:\/\//i.test(u || '') ? u : null);
    if (!b.title && !b.desc && !url(b.image)) return res.json({ ok: false, msg: 'اكتب عنواناً أو نصاً' });
    const e = new EmbedBuilder().setColor(ctx.color(b.color, 0x8b2fe8));
    if (b.title) e.setTitle(String(b.title).slice(0, 250));
    if (b.desc) e.setDescription(String(b.desc).slice(0, 4000));
    if (url(b.image)) e.setImage(url(b.image));
    if (url(b.thumb)) e.setThumbnail(url(b.thumb));
    if (b.footer) e.setFooter({ text: String(b.footer).slice(0, 200) });
    const sent = await ch.send({ embeds: [e] }).catch(() => null);
    if (sent) ctx.addDlog(req.g, ctx.who(req), `إرسال إمبد إلى #${ch.name}`);
    res.json({ ok: !!sent, msg: sent ? '' : 'فشل الإرسال: تأكد من صلاحيات البوت' });
  });

  app.get('/api/leaderboard', auth, async (req, res) => {
    const g = req.g, top = Object.entries(cfg(g.id).xp || {}).sort((a, b) => b[1] - a[1]).slice(0, 25);
    const mem = await g.members.fetch({ user: top.map(([id]) => id) }).catch(() => null);
    res.json(top.map(([id, xp]) => {
      const m = mem?.get?.(id) || g.members.cache.get(id);
      return { id, xp, level: Math.floor(0.1 * Math.sqrt(xp)), name: m?.displayName || m?.user?.username || id, avatar: m?.displayAvatarURL?.({ size: 64 }) || null };
    }));
  });

  app.post('/api/botnick', auth, async (req, res) => {
    try {
      await req.g.members.me.setNickname(String(req.body.nick || '').slice(0, 32) || null);
      ctx.addDlog(req.g, ctx.who(req), 'تغيير اسم البوت في السيرفر');
      res.json({ ok: true });
    } catch { res.json({ ok: false, msg: 'فشل: تأكد أن للبوت صلاحية تغيير الاسم' }); }
  });
};

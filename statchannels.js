'use strict';
/** رومات الإحصائيات: روم صوتي اسمه صيغة فيها متغيرات ({members} ...) ويتحدث كل 10 دقايق (ui.stats). */
module.exports = (ctx) => {
  const { client, app, auth, cfg, isActive, discord: { ChannelType: T, PermissionFlagsBits: P } } = ctx;

  const vars = (g) => ({
    members: g.memberCount, humans: g.members.cache.filter((m) => !m.user.bot).size, bots: g.members.cache.filter((m) => m.user.bot).size,
    channels: g.channels.cache.size, roles: g.roles.cache.size, boosts: g.premiumSubscriptionCount || 0,
  });

  async function update(g) {
    const list = cfg(g.id).ui?.stats;
    if (!Array.isArray(list)) return 0;
    const v = vars(g);
    let n = 0;
    for (const s of list.slice(0, 10)) {
      const ch = g.channels.cache.get(s.ch);
      if (!ch || !s.tpl) continue;
      const name = String(s.tpl).replace(/{(\w+)}/g, (m, k) => (k in v ? v[k] : m)).slice(0, 100);
      if (ch.name !== name) await ch.setName(name).then(() => n++, () => {});
    }
    return n;
  }
  ctx.updateStats = update;

  setInterval(() => client.guilds.cache.forEach((g) => { if (isActive(g) && !ctx.off(g, '_')) update(g); }), 10 * 60 * 1000).unref();

  app.post('/api/stats/update', auth, async (req, res) => res.json({ ok: true, n: await update(req.g) }));
  app.post('/api/stats/create', auth, async (req, res) => {
    const name = String(req.body.tpl || '👥 الأعضاء: {members}').replace(/{(\w+)}/g, (m, k) => (k in vars(req.g) ? vars(req.g)[k] : m)).slice(0, 100);
    const ch = await req.g.channels.create({ name, type: T.GuildVoice, permissionOverwrites: [{ id: req.g.id, deny: [P.Connect] }] }).catch(() => null);
    res.json(ch ? { ok: true, id: ch.id } : { ok: false, msg: 'فشل الإنشاء: تأكد من صلاحيات البوت' });
  });
};

'use strict';
/** رومات صوتية مؤقتة: دخول "روم الإنشاء" يُنشئ روماً خاصاً بالعضو ويُحذف عندما يفضى (ui.tv). */
module.exports = (ctx) => {
  const { client, cfg, save, discord: { ChannelType: T, PermissionFlagsBits: P } } = ctx;
  ctx.tvGone = new Set(); // رومات حذفها البوت نفسه (حتى لا تدخل سلة الاستعادة)

  client.on('voiceStateUpdate', async (o, n) => {
    const g = n.guild;
    if (!g || ctx.off(g, '_')) return;
    const c = cfg(g.id), tv = c.ui?.tv;

    if (tv?.on && tv.ch && n.channelId === tv.ch && n.member && !n.member.user.bot) {
      const name = String(tv.name || '🔊 {user}').replace(/{user}/g, n.member.displayName).slice(0, 90);
      const ch = await g.channels.create({
        name, type: T.GuildVoice, parent: tv.cat || n.channel?.parentId || undefined, userLimit: Math.max(0, +tv.limit || 0),
        permissionOverwrites: [{ id: n.member.id, allow: [P.ManageChannels, P.MoveMembers] }],
      }).catch(() => null);
      if (ch) {
        (c.tvc ??= []).push(ch.id);
        save();
        await n.member.voice.setChannel(ch).catch(() => {});
      }
    }

    if (o.channelId && c.tvc?.includes(o.channelId)) {
      const ch = g.channels.cache.get(o.channelId);
      if (!ch || ch.members.size === 0) {
        ctx.tvGone.add(o.channelId);
        c.tvc = c.tvc.filter((x) => x !== o.channelId);
        save();
        await ch?.delete('temp voice empty').catch(() => {});
      }
    }
  });
};

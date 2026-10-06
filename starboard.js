'use strict';
/** لوحة النجوم: الرسالة اللي تجمع عدد معين من التفاعلات تُنشر في قناة مخصصة (ui.star). */
module.exports = (ctx) => {
  const { client, cfg, save, discord: { EmbedBuilder } } = ctx;

  client.on('messageReactionAdd', async (reaction, user) => {
    try {
      if (user.bot) return;
      if (reaction.partial) reaction = await reaction.fetch();
      const m = reaction.message.partial ? await reaction.message.fetch() : reaction.message;
      const g = m.guild;
      if (!g || ctx.off(g, '_')) return;
      const st = cfg(g.id).ui?.star;
      const emoji = st?.emoji || '⭐';
      if (!st?.on || !st.ch || m.channelId === st.ch || reaction.emoji.name !== emoji) return;

      const users = await reaction.users.fetch();
      const n = users.filter((u) => !u.bot && (st.self || u.id !== m.author?.id)).size;
      if (n < (+st.n || 3)) return;
      const ch = g.channels.cache.get(st.ch);
      if (!ch) return;

      const posts = (cfg(g.id).starPosts ??= {});
      const text = `${emoji} **${n}** | <#${m.channelId}>`;
      if (posts[m.id]) {
        const p = await ch.messages.fetch(posts[m.id]).catch(() => null);
        if (p) return void p.edit({ content: text }).catch(() => {});
      }
      const e = new EmbedBuilder().setColor(0xf1c40f).setTimestamp(m.createdAt)
        .setAuthor({ name: m.author?.username || 'مجهول', iconURL: m.author?.displayAvatarURL?.() })
        .setDescription(`${(m.content || '').slice(0, 3500)}\n\n[الانتقال للرسالة](${m.url})`);
      const img = m.attachments?.find((a) => a.contentType?.startsWith('image/'));
      if (img) e.setImage(img.url);
      const sent = await ch.send({ content: text, embeds: [e] });
      posts[m.id] = sent.id;
      const keys = Object.keys(posts);
      if (keys.length > 1000) delete posts[keys[0]];
      save();
    } catch { /* رسالة غير متاحة أو صلاحيات ناقصة */ }
  });
};

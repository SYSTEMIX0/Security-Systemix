'use strict';
/**
 * سجلات الأحداث (اللوقات).
 * كل حدث له مفتاح ويُضبط من لوحة التحكم عبر ui.lg[key] = { on, ch, t, d, c }:
 *   on = تشغيل، ch = قناة خاصة بالحدث، t/d/c = عنوان/نص/لون مخصص ({details} = تفاصيل الحدث).
 */
module.exports = (ctx) => {
  const { client, cfg, discord: { EmbedBuilder } } = ctx;

  function logE(g, key, title, desc, dflt = 0x7f8c8d) {
    const ui = cfg(g.id).ui || {}, e = ui.lg?.[key];
    if (ui.on === false || e?.on !== true) return;
    const id = e.ch || ui.evCh || cfg(g.id).log, ch = id && g.channels.cache.get(id);
    if (!ch) return;
    const text = e.d ? String(e.d).replace(/{details}/g, desc) : desc;
    ch.send({ embeds: [new EmbedBuilder().setTitle(String(e.t || title).slice(0, 250)).setDescription(String(text).slice(0, 3500)).setColor(ctx.color(e.c, dflt)).setTimestamp()] }).catch(() => {});
  }
  ctx.logE = logE;

  const names = (c) => c.map((r) => r.name).join('، ') || '—';
  const G = 0x2ecc71, R = 0xe74c3c, Y = 0xf1c40f, O = 0xe67e22, B = 0x3498db;

  // الرسائل
  client.on('messageDelete', (m) => {
    if (!m.guild || m.author?.bot) return;
    logE(m.guild, 'msgdel', '🗑️ رسالة محذوفة', `<#${m.channelId}> — ${m.author ? `<@${m.author.id}>` : 'غير معروف'}\n${m.content || '(غير محفوظة)'}`, R);
  });
  client.on('messageUpdate', (o, n) => {
    if (!n.guild || n.partial || o.partial || n.author?.bot || o.content === n.content) return;
    logE(n.guild, 'msgedit', '✏️ تعديل رسالة', `<#${n.channelId}> — <@${n.author.id}>\nقبل: ${o.content}\nبعد: ${n.content}`, Y);
  });

  // الأعضاء
  client.on('guildMemberAdd', (m) => logE(m.guild, 'join', '📥 دخول عضو', `<@${m.id}> (${m.user.username})`, G));
  client.on('guildMemberRemove', (m) => logE(m.guild, 'leave', '📤 خروج عضو', `${m.user.username} (${m.id})`, O));
  client.on('guildBanAdd', (b) => logE(b.guild, 'ban', '🔨 حظر', `${b.user.username} (${b.user.id})`, R));
  client.on('guildBanRemove', (b) => logE(b.guild, 'unban', '♻️ فك حظر', `${b.user.username} (${b.user.id})`, B));
  client.on('guildMemberUpdate', (o, n) => {
    if (o.partial) return;
    const g = n.guild;
    if (o.nickname !== n.nickname) logE(g, 'nick', '🏷️ تغيير لقب', `<@${n.id}>: ${o.nickname || '—'} ← ${n.nickname || '—'}`);
    const add = n.roles.cache.filter((r) => !o.roles.cache.has(r.id)), rem = o.roles.cache.filter((r) => !n.roles.cache.has(r.id));
    if (add.size || rem.size) logE(g, 'mrole', '🎭 تغيير رتب عضو', `<@${n.id}>\n➕ ${names(add)}\n➖ ${names(rem)}`, B);
    if (o.communicationDisabledUntilTimestamp !== n.communicationDisabledUntilTimestamp) {
      const until = n.communicationDisabledUntilTimestamp;
      logE(g, 'timeout', '🔇 كتم مؤقت', `<@${n.id}>: ${until > Date.now() ? 'حتى ' + new Date(until).toLocaleString('ar-SA') : 'تم فك الكتم'}`, O);
    }
  });

  // الرومات
  client.on('channelCreate', (c) => c.guild && logE(c.guild, 'chcreate', '📁 إنشاء روم', `<#${c.id}> (${c.name})`, G));
  client.on('channelDelete', (c) => c.guild && logE(c.guild, 'chdelete', '🗑️ حذف روم', c.name, R));
  client.on('channelUpdate', (o, n) => {
    if (!n.guild) return;
    const d = [];
    if (o.name !== n.name) d.push(`الاسم: ${o.name} ← ${n.name}`);
    if (o.topic !== n.topic) d.push('تم تغيير الوصف');
    if ((o.rateLimitPerUser || 0) !== (n.rateLimitPerUser || 0)) d.push(`سلو مود: ${o.rateLimitPerUser || 0} ← ${n.rateLimitPerUser || 0}`);
    if (o.parentId !== n.parentId) d.push('تم نقل الروم لفئة أخرى');
    if (o.permissionOverwrites?.cache.size !== n.permissionOverwrites?.cache.size) d.push('تم تعديل الصلاحيات');
    if (d.length) logE(n.guild, 'chupdate', '🛠️ تعديل روم', `<#${n.id}>\n${d.join('\n')}`, Y);
  });

  // الرتب
  client.on('roleCreate', (r) => logE(r.guild, 'rolecreate', '🎭 إنشاء رتبة', r.name, G));
  client.on('roleDelete', (r) => logE(r.guild, 'roledelete', '🗑️ حذف رتبة', r.name, R));
  client.on('roleUpdate', (o, n) => {
    const d = [];
    if (o.name !== n.name) d.push(`الاسم: ${o.name} ← ${n.name}`);
    if (o.color !== n.color) d.push('تم تغيير اللون');
    if (o.permissions.bitfield !== n.permissions.bitfield) d.push('تم تعديل الصلاحيات');
    if (d.length) logE(n.guild, 'roleupdate', '🛠️ تعديل رتبة', `${n.name}\n${d.join('\n')}`, Y);
  });

  // الصوت
  client.on('voiceStateUpdate', (o, n) => {
    if (!n.guild || o.channelId === n.channelId) return;
    if (!o.channelId) logE(n.guild, 'vjoin', '🔊 دخول روم صوتي', `<@${n.id}> ← <#${n.channelId}>`, G);
    else if (!n.channelId) logE(n.guild, 'vleave', '🔇 خروج من روم صوتي', `<@${n.id}> ← <#${o.channelId}>`, O);
    else logE(n.guild, 'vmove', '🔀 انتقال بين الرومات', `<@${n.id}>: <#${o.channelId}> ← <#${n.channelId}>`, B);
  });

  // السيرفر
  client.on('guildUpdate', (o, n) => {
    const d = [];
    if (o.name !== n.name) d.push(`الاسم: ${o.name} ← ${n.name}`);
    if (o.icon !== n.icon) d.push('تم تغيير الشعار');
    if (o.verificationLevel !== n.verificationLevel) d.push('تغيّر مستوى التحقق');
    if (d.length) logE(n, 'gupdate', '⚙️ تعديل إعدادات السيرفر', d.join('\n'), Y);
  });
  client.on('emojiCreate', (e) => logE(e.guild, 'emojiadd', '😀 إضافة إيموجي', `${e} (${e.name})`, G));
  client.on('emojiDelete', (e) => logE(e.guild, 'emojidel', '🗑️ حذف إيموجي', e.name, R));
  client.on('inviteCreate', (i) => i.guild && logE(i.guild, 'invcreate', '🔗 إنشاء دعوة', `${i.code} — ${i.inviter ? `<@${i.inviter.id}>` : 'غير معروف'}`, G));
  client.on('inviteDelete', (i) => i.guild && logE(i.guild, 'invdelete', '🔗 حذف دعوة', i.code, R));
};

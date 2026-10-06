'use strict';
/**
 * Systemix — بوت ديسكورد للحماية والإدارة + لوحة تحكم ويب + نظام اشتراكات.
 * ترتيب الملف: تخزين ← اشتراكات ← أدوات ← حماية ← أحداث ← أوامر ← ويب ← ميزات (src/features/*).
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const discord = require('discord.js');
const {
  Client, GatewayIntentBits: I, Partials, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle,
  SlashCommandBuilder: S, PermissionFlagsBits: P, AuditLogEvent: A, ChannelType: T,
} = discord;

const PUBLIC = path.join(__dirname, '..', 'public');
const read = (f) => fs.readFileSync(path.join(PUBLIC, f), 'utf8');
const ctx = {}; // سياق مشترك يُمرَّر لوحدات الميزات في src/features

const client = new Client({
  intents: [I.Guilds, I.GuildMembers, I.GuildModeration, I.GuildMessages, I.MessageContent, I.GuildWebhooks, I.GuildIntegrations, I.GuildVoiceStates,
    I.GuildInvites, I.GuildMessageReactions, I.GuildExpressions ?? I.GuildEmojisAndStickers],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction],
});

// ---------- التخزين (ملف JSON بسيط) ----------
const DATA_DIR = process.env.DATA_DIR || path.join(process.cwd(), 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const FILE = path.join(DATA_DIR, 'data.json');
const LEGACY = path.join(process.cwd(), 'data.json'); // ترحيل بيانات الإصدارات القديمة
if (!fs.existsSync(FILE) && fs.existsSync(LEGACY)) fs.copyFileSync(LEGACY, FILE);
let db = {};
try { db = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { /* أول تشغيل */ }
let saveTimer = null;
const flush = () => { clearTimeout(saveTimer); saveTimer = null; fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); };
const save = () => { saveTimer ??= setTimeout(flush, 300); }; // حفظ مؤجل لتقليل الكتابة على القرص
process.on('exit', () => { if (saveTimer) flush(); });
for (const sg of ['SIGINT', 'SIGTERM']) process.on(sg, () => process.exit(0));
const cfg = (id) => (db[id] ??= { wl: [], log: null, welcome: null, nuke: true, lock: false, xp: {}, backup: null });

// ---------- نظام الاشتراكات (للمالك) ----------
// OWNER_ID يقبل ايدي واحد أو عدة ايديات مفصولة بفاصلة (كلهم مالكين)
const OWNERS = () => (process.env.OWNER_ID || '').split(/[\s,;]+/).filter(Boolean);
const isOwnerId = (id) => !!id && OWNERS().includes(String(id));
const OWNER = () => OWNERS().length > 0; // هل نظام المالكين/الاشتراكات مفعّل؟
const lic = () => (db.lic ??= { on: true, trialDays: 3, newServers: 'suspended', contact: '', msg: '', notifyDays: 3, leaveDays: 0 });
function subOf(g) {
  db.subs ??= {};
  let s = db.subs[g.id];
  if (!s) {
    const L = lic(), now = Date.now(), susp = L.newServers !== 'trial';
    s = db.subs[g.id] = { name: g.name, ownerId: g.ownerId, added: now, status: susp ? 'suspended' : 'active', until: !susp && L.trialDays ? now + L.trialDays * 864e5 : null,
      plan: !susp && L.trialDays ? 'تجريبي' : '—', note: '', hist: [{ t: now, a: susp ? 'أُضيف (بانتظار التفعيل)' : 'أُضيف (تجربة)' }] };
    save();
  }
  return s;
}
function isActive(g) {
  if (!g || !OWNER() || !lic().on || isOwnerId(g.ownerId)) return true;
  const s = subOf(g);
  return s.status === 'active' && (!s.until || s.until > Date.now());
}
function subInfo(g) {
  const L = lic();
  if (!OWNER() || !L.on || isOwnerId(g.ownerId)) return { active: true, free: true, days: null, status: 'free' };
  const s = subOf(g), act = isActive(g);
  return { active: act, free: false, status: act ? 'active' : s.status === 'suspended' ? 'suspended' : 'expired', until: s.until, plan: s.plan,
    days: s.until ? Math.max(0, Math.ceil((s.until - Date.now()) / 864e5)) : null, contact: L.contact, msg: L.msg };
}
const guildOf = (a) => { for (const x of a) { if (x && x.guild) return x.guild; if (x && x.ownerId && x.channels) return x; } return null; };
function denyInteraction(i) {
  const L = lic();
  if (!i?.isRepliable?.()) return;
  return i.reply({ content: `⛔ اشتراك البوت متوقف أو منتهي في هذا السيرفر.\n${L.msg || 'للتجديد تواصل مع مالك البوت.'}${L.contact ? '\n📩 ' + L.contact : ''}`, flags: 64 }).catch(() => {});
}
const _on = client.on.bind(client);
client.on = (ev, fn) => _on(ev, (...a) => {
  let g = null;
  try { g = guildOf(a); } catch {}
  if (g && !isActive(g)) return ev === 'interactionCreate' ? denyInteraction(a[0]) : undefined;
  return fn(...a);
});
const notifyOwner = (txt) => OWNERS().forEach((id) => client.users.fetch(id).then((u) => u.send(txt)).catch(() => {}));
async function notifyGuild(g, kind, extra = '') {
  const L = lic();
  const K = { suspended: ['⛔ تم إيقاف اشتراك البوت', 'البوت موجود في السيرفر لكنه متوقف عن العمل.'], pending: ['👋 تمت إضافة البوت', 'البوت بانتظار التفعيل من المالك قبل أن يبدأ العمل.'],
    expired: ['⌛ انتهى اشتراك البوت', 'البوت موجود لكنه متوقف عن العمل حتى التجديد.'], activated: ['✅ تم تفعيل اشتراك البوت', 'البوت يعمل الآن بكامل ميزاته.'],
    reminder: ['⏰ اشتراك البوت قارب على الانتهاء', 'جدّد قبل الانتهاء حتى لا يتوقف البوت.'], custom: ['📢 رسالة من مالك البوت', ''] }[kind];
  const tail = kind === 'activated' || kind === 'custom' ? '' : `\n\n${L.msg || 'للتجديد أو التفعيل تواصل مع مالك البوت.'}${L.contact ? '\n📩 ' + L.contact : ''}`;
  const e = new EmbedBuilder().setTitle(K[0]).setDescription(`${K[1]}${extra ? '\n' + extra : ''}${tail}`.trim()).setColor(kind === 'activated' || kind === 'custom' ? 0x2ecc71 : 0xe74c3c).setTimestamp();
  const id = cfg(g.id).log;
  const ch = (id && g.channels.cache.get(id)) || g.systemChannel || g.channels.cache.find((c) => c.type === T.GuildText && c.permissionsFor?.(g.members.me)?.has(P.SendMessages));
  await ch?.send({ embeds: [e] }).catch(() => {});
  const own = await g.fetchOwner().catch(() => null);
  await own?.send({ embeds: [e] }).catch(() => {});
}
async function checkSubs() {
  const L = lic(), now = Date.now();
  if (!OWNER() || !L.on) return;
  for (const g of client.guilds.cache.values()) {
    if (isOwnerId(g.ownerId)) continue;
    const s = subOf(g);
    if (s.status === 'active' && s.until) {
      if (s.until <= now && s.flag !== 'expired') { s.flag = 'expired'; s.stopped = s.until; (s.hist ??= []).push({ t: now, a: 'انتهى الاشتراك' }); save(); await notifyGuild(g, 'expired'); }
      else if (s.until > now && L.notifyDays && s.until - now <= L.notifyDays * 864e5 && !s.rem) { s.rem = true; save(); await notifyGuild(g, 'reminder', `ينتهي: ${new Date(s.until).toLocaleDateString('ar-SA')}`); }
    }
    if (L.leaveDays && !isActive(g) && now - (s.stopped || s.until || s.added) > L.leaveDays * 864e5) { (s.hist ??= []).push({ t: now, a: 'غادر تلقائياً' }); save(); await g.leave().catch(() => {}); }
  }
}
_on('guildCreate', (g) => {
  if (db.bl?.[g.id]) return void g.leave().catch(() => {});
  if (!OWNER()) return;
  subOf(g);
  notifyOwner(`🆕 انضم البوت لسيرفر **${g.name}** (${g.id}) — ${g.memberCount} عضو\nالحالة: ${isActive(g) ? 'نشط' : 'بانتظار تفعيلك من لوحة المالك'}`);
  if (!isActive(g)) notifyGuild(g, 'pending');
});
client.once('ready', () => {
  client.guilds.cache.forEach((g) => { if (db.bl?.[g.id]) g.leave().catch(() => {}); else if (OWNER()) subOf(g); });
  setTimeout(checkSubs, 20000);
});
setInterval(checkSubs, 10 * 60 * 1000);

// ---------- أدوات ----------
const recent = {};
async function log(g, title, desc, uid) {
  const stt = (cfg(g.id).stats ??= {});
  stt[title] = (stt[title] || 0) + 1;
  (recent[g.id] ??= []).unshift({ u: uid || null, at: Date.now(), t: title, d: desc.replace(/<@(\d+)>/g, '$1').replace(/\*/g, '') });
  if (recent[g.id].length > 50) recent[g.id].pop();
  if (uid) ctx.addAct?.(g, title, uid, desc);
  const pe = cfg(g.id).ui?.lg?.protect;
  if (pe?.on === false) return;
  const id = pe?.ch || cfg(g.id).log;
  const ch = id && g.channels.cache.get(id);
  if (!ch) return;
  const e = new EmbedBuilder().setTitle(title).setDescription(desc).setColor(0xe74c3c).setTimestamp();
  const components = uid
    ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ban:' + uid).setLabel('حظر').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('strip:' + uid).setLabel('عزل (سحب الرتب)').setStyle(ButtonStyle.Secondary))]
    : [];
  ch.send({ embeds: [e], components }).catch(() => {});
}

const trusted = (g, id) => id === client.user.id || id === g.ownerId || cfg(g.id).wl.includes(id);
const punish = (g, id, reason) => g.members.ban(id, { reason }).catch(() => {});

// ---------- Anti-Nuke ----------
const LIMIT = 3, WINDOW = 10000, hits = new Map();
async function guard(g, type, label, targetId) {
  if (!cfg(g.id).nuke || off(g, 'nuke') || off(g, KEY[label])) return;
  const ui = cfg(g.id).ui || {};
  const logs = await g.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  const e = logs?.entries.first();
  if (!e || Date.now() - e.createdTimestamp > 5000) return;
  if (targetId && e.target?.id !== targetId) return;
  const u = e.executor;
  if (!u || trusted(g, u.id) || seenE.has(e.id)) return;
  seenE.add(e.id); if (seenE.size > 500) seenE.clear();
  const k = g.id + u.id + label;
  const arr = (hits.get(k) || []).filter((t) => Date.now() - t < (ui.window || 10) * 1000);
  arr.push(Date.now());
  hits.set(k, arr);
  if (arr.length < (ui.limit || LIMIT)) return;
  hits.delete(k);
  await punishBy(g, u.id, 'Anti-Nuke: ' + label);
  log(g, '🚨 Anti-Nuke', `تم حظر <@${u.id}> بسبب: **${label}** (${ui.limit || LIMIT}+ خلال ${ui.window || 10} ثواني)`, u.id);
}

client.on('channelDelete', (c) => c.guild && guard(c.guild, A.ChannelDelete, 'حذف قنوات'));
client.on('roleDelete', (r) => guard(r.guild, A.RoleDelete, 'حذف رتب'));
client.on('guildBanAdd', (b) => guard(b.guild, A.MemberBanAdd, 'حظر جماعي'));
client.on('guildMemberRemove', (m) => guard(m.guild, A.MemberKick, 'طرد جماعي', m.id));

// ---------- حماية الويب هوك ----------
client.on('webhooksUpdate', async (ch) => {
  const g = ch.guild;
  if (!cfg(g.id).nuke || off(g, 'hook')) return;
  const logs = await g.fetchAuditLogs({ type: A.WebhookCreate, limit: 1 }).catch(() => null);
  const e = logs?.entries.first();
  if (!e || Date.now() - e.createdTimestamp > 5000 || trusted(g, e.executor.id)) return;
  const hooks = await ch.fetchWebhooks().catch(() => null);
  await hooks?.get(e.target.id)?.delete('Anti-Webhook').catch(() => {});
  log(g, '🪝 ويب هوك مشبوه', `تم حذف ويب هوك أنشأه <@${e.executor.id}>`, e.executor.id);
});

// ---------- Anti-Admin Escalation ----------
client.on('guildMemberUpdate', async (o, n) => {
  const g = n.guild;
  if (off(g, 'esc')) return;
  const gained = n.roles.cache.filter((r) => !o.roles.cache.has(r.id) && DANGER.some((p) => r.permissions.has(p)));
  if (!gained.size) return;
  const logs = await g.fetchAuditLogs({ type: A.MemberRoleUpdate, limit: 1 }).catch(() => null);
  const e = logs?.entries.first();
  if (!e || Date.now() - e.createdTimestamp > 5000 || trusted(g, e.executor.id)) return;
  await n.roles.remove(gained).catch(() => {});
  await punishBy(g, e.executor.id, 'Anti-Admin-Escalation');
  log(g, '⚠️ محاولة ترقية مشبوهة', `<@${e.executor.id}> حاول يعطي <@${n.id}> صلاحية Administrator. تم السحب والحظر.`, e.executor.id);
});

client.on('roleUpdate', async (o, n) => {
  if (!DANGER.some((p) => n.permissions.has(p) && !o.permissions.has(p))) return;
  const g = n.guild;
  if (off(g, 'esc')) return;
  const logs = await g.fetchAuditLogs({ type: A.RoleUpdate, limit: 1 }).catch(() => null);
  const e = logs?.entries.first();
  if (!e || Date.now() - e.createdTimestamp > 5000 || trusted(g, e.executor.id)) return;
  await n.setPermissions(o.permissions).catch(() => {});
  await punishBy(g, e.executor.id, 'Anti-Admin-Escalation');
  log(g, '⚠️ رتبة أخذت Administrator', `تم الرجوع للصلاحيات القديمة وحظر <@${e.executor.id}>`, e.executor.id);
});

// ---------- مراقبة الرابط المميز ----------
client.on('guildUpdate', async (o, n) => {
  if (o.vanityURLCode === n.vanityURLCode || off(n, 'vanity')) return;
  const logs = await n.fetchAuditLogs({ type: A.GuildUpdate, limit: 1 }).catch(() => null);
  const e = logs?.entries.first();
  const by = e && Date.now() - e.createdTimestamp < 5000 ? e.executor : null;
  if (by && trusted(n, by.id)) return;
  if (by) await punish(n, by.id, 'Vanity change');
  log(n, '🔗 تغيّر الرابط المميز', `من \`${o.vanityURLCode}\` إلى \`${n.vanityURLCode}\`\nالفاعل: ${by ? `<@${by.id}>` : 'غير معروف'}\n⚠️ ديسكورد لا يسمح للبوتات باسترجاع الرابط، رجّعه يدوياً.`, by?.id);
});

// ---------- الانضمام: وضع الطوارئ + ترحيب + كشف الحسابات الجديدة ----------
client.on('guildMemberAdd', async (m) => {
  const g = m.guild, c = cfg(g.id);
  if (c.lock && !m.user.bot) return m.kick('Panic Lockdown').catch(() => {});
  const age = (Date.now() - m.user.createdTimestamp) / 864e5;
  if (age < (c.ui?.altDays ?? 3) && !off(g, 'alt')) log(g, '🕵️ حساب جديد جداً', `<@${m.id}> عمر حسابه ${age.toFixed(1)} يوم`, m.id);
  const w = c.ui?.welcome;
  if (off(g, '_') || w?.on === false) return;
  const ch = findCh(g, w?.ch) || (c.welcome && g.channels.cache.get(c.welcome));
  const text = w?.msg ? fmt(w.msg, m, true) : `حياك الله <@${m.id}> في **${g.name}**\nأنت العضو رقم **${g.memberCount}**`;
  ch?.send({ embeds: [new EmbedBuilder().setColor(parseInt(String(w?.color || '#2ecc71').replace('#', ''), 16) || 0x2ecc71).setTitle(w?.title || 'أهلاً وسهلاً 👋').setDescription(text).setThumbnail(m.user.displayAvatarURL())] }).catch(() => {});
});

// ---------- المستويات ----------
const cd = new Map();
client.on('messageCreate', (m) => {
  if (!m.guild || m.author.bot || off(m.guild, '_') || cfg(m.guild.id).ui?.lvl?.on === false || cfg(m.guild.id).ui?.lvl?.ignore?.includes(m.channelId) || Date.now() - (cd.get(m.guild.id + m.author.id) || 0) < (cfg(m.guild.id).ui?.lvl?.cd || 60) * 1000) return;
  cd.set(m.guild.id + m.author.id, Date.now());
  const xp = (cfg(m.guild.id).xp[m.author.id] ??= 0);
  const lvl = (x) => Math.floor(0.1 * Math.sqrt(x));
  const L = cfg(m.guild.id).ui?.lvl || {}, lo = L.min || 15, hi = Math.max(lo, L.max || 25);
  const now = xp + lo + Math.floor(Math.random() * (hi - lo + 1));
  cfg(m.guild.id).xp[m.author.id] = now;
  if (lvl(now) > lvl(xp)) {
    const Lc = cfg(m.guild.id).ui?.lvl || {};
    if (Lc.announce !== false) {
      const text = String(Lc.msg || '🎉 مبروك {user} وصلت لفل **{level}**').replace(/{user}/g, `<@${m.author.id}>`).replace(/{level}/g, lvl(now));
      (findCh(m.guild, Lc.ch) || m.channel).send({ content: text, allowedMentions: { users: [m.author.id] } }).catch(() => {});
    }
    for (const r of cfg(m.guild.id).ui?.lvl?.rewards || []) {
      const role = r.lvl <= lvl(now) && m.guild.roles.cache.find((x) => x.name === r.role);
      if (role) m.member?.roles.add(role).catch(() => {});
    }
  }
  save();
});


// ---------- مساعدات + النسخ الاحتياطي + الطوارئ ----------
const KEY = { 'حذف قنوات': 'chan', 'حذف رتب': 'role', 'حظر جماعي': 'ban', 'طرد جماعي': 'ban' };
const off = (g, k) => cfg(g.id).ui?.on === false || cfg(g.id).ui?.sec?.[k] === false;
const findCh = (g, n) => n && g.channels.cache.find((c) => c.type === T.GuildText && (c.id === n || c.name === String(n).replace(/^#/, '')));
const fmt = (t, m, mention) => t.replace(/{user}/g, mention ? `<@${m.id}>` : `**${m.user.username}**`).replace(/{server}/g, m.guild.name).replace(/{count}/g, m.guild.memberCount);
client.on('guildMemberRemove', (m) => {
  const l = cfg(m.guild.id).ui?.leave;
  if (l?.on && !off(m.guild, '_')) findCh(m.guild, l.ch)?.send(fmt(l.msg || '{user} غادر', m, false)).catch(() => {});
});

const PORT = process.env.PORT || 3000;
// على Render يتوفر RENDER_EXTERNAL_URL تلقائياً، فلا تحتاج PUBLIC_URL
const URL_BASE = (process.env.PUBLIC_URL || process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
async function punishBy(g, id, reason) {
  threat(g, 5, reason);
  const how = cfg(g.id).ui?.punish || 'ban';
  const m = await g.members.fetch(id).catch(() => null);
  if (how === 'strip') return m?.roles.set([], reason).catch(() => {});
  if (how === 'kick') return m?.kick(reason).catch(() => {});
  addBad(g, id, reason);
  return punish(g, id, reason);
}
const sendPanel = (ch) => ch.send({ embeds: [new EmbedBuilder().setTitle('🎫 الدعم الفني').setDescription('اضغط الزر لفتح تذكرة')],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('ticket_open').setLabel('فتح تذكرة').setStyle(ButtonStyle.Primary))] });
const rid = () => crypto.randomBytes(24).toString('hex');
function newLink(gid, to) {
  db.tokens ??= {};
  const t = rid();
  db.tokens[t] = { gid, to, exp: Date.now() + 864e5, used: false };
  save();
  return `${URL_BASE}/t/${t}`;
}
function createBackup(g) {
  const c = cfg(g.id);
  const b = {
    id: rid().slice(0, 8), date: Date.now(),
    roles: g.roles.cache.filter((r) => !r.managed && r.id !== g.id).sort((a, b) => b.position - a.position)
      .map((r) => ({ name: r.name, color: r.color, hoist: r.hoist, admin: r.permissions.has(P.Administrator), perms: r.permissions.bitfield.toString() })),
    channels: g.channels.cache.filter((x) => [T.GuildText, T.GuildVoice, T.GuildCategory].includes(x.type))
      .sort((a, b) => a.rawPosition - b.rawPosition)
      .map((x) => chanSnap(g, x)),
  };
  (c.backups ??= []).unshift(b);
  c.backups.length = Math.min(c.backups.length, 10);
  save();
  return b;
}
async function restoreBackup(g, b) {
  let n = 0;
  for (const r of b.roles)
    if (!g.roles.cache.some((x) => x.name === r.name)) {
      await g.roles.create({ name: r.name, color: r.color, hoist: r.hoist, permissions: BigInt(r.perms) }).catch(() => {}); n++;
    }
  const sorted = [...b.channels].sort((a, c) => (c.type === T.GuildCategory) - (a.type === T.GuildCategory));
  for (const x of sorted)
    if (!g.channels.cache.some((y) => y.name === x.name && y.type === x.type)) {
      const parent = x.parent && g.channels.cache.find((y) => y.name === x.parent && y.type === T.GuildCategory);
      await g.channels.create(chanOpts(g, x, parent)).catch(() => {}); n++;
    }
  return n;
}
async function setPanic(g, on, by) {
  const c = cfg(g.id);
  c.lock = on; save();
  let ok = 0, bad = 0;
  for (const ch of g.channels.cache.filter((x) => x.type === T.GuildText).values())
    await ch.permissionOverwrites.edit(g.roles.everyone, { SendMessages: on ? false : null }).then(() => ok++, () => bad++);
  log(g, on ? '🔒 وضع الطوارئ مفعّل' : '🔓 وضع الطوارئ أُوقف', `بواسطة ${by}\nتم تعديل ${ok} روم${bad ? `، وفشل ${bad} (تأكد من صلاحيات البوت ورتبته)` : ''}`);
  return { done: ok, bad };
}
const SEC_N = { nuke: 'Anti-Nuke', ban: 'منع الحظر/الطرد الجماعي', chan: 'حماية القنوات', role: 'حماية الرتب', hook: 'الويب هوكس', vanity: 'الرابط المميز', esc: 'منع الترقية', alt: 'كشف الحسابات الجديدة', emoji: 'الإيموجيات', gset: 'إعدادات السيرفر', integ: 'التكاملات', bots: 'قائمة البوتات', raid: 'كشف الغارات', honey: 'قناة الفخ', link: 'درع الروابط', mention: 'سبام المنشن', trust: 'القائمة السوداء', restore: 'الاسترجاع التلقائي', spam: 'سبام الرسائل', words: 'الكلمات الممنوعة' };
const EV_N = { msgdel: 'سجل حذف الرسائل', msgedit: 'سجل تعديل الرسائل', join: 'سجل الدخول', leave: 'سجل الخروج', ban: 'سجل الحظر', unban: 'سجل فك الحظر', voice: 'سجل الصوت', nick: 'سجل الألقاب', ch: 'سجل الرومات', role: 'سجل الرتب' };
function settingsDiff(o, n) {
  const val = (x, p, d) => { const v = p.split('.').reduce((a, k) => a?.[k], x); return v === undefined ? d : v; };
  const list = [['on', 'البوت (التشغيل العام)', true], ['autoPanic', 'الطوارئ التلقائي', false], ['capsOn', 'فلتر الحروف الكبيرة', false], ['blockInvites', 'منع الدعوات', false],
    ['welcome.on', 'الترحيب', true], ['leave.on', 'المغادرة', false], ['lvl.on', 'المستويات', true], ['lvl.announce', 'إعلان المستوى', true], ['welcome.dm', 'الرسالة الخاصة', false]];
  for (const k in SEC_N) list.push(['sec.' + k, SEC_N[k], true]);
  for (const k in EV_N) list.push(['ev.' + k, EV_N[k], true]);
  return list.filter(([p, , d]) => !!val(o, p, d) !== !!val(n, p, d)).map(([p, name, d]) => `${val(n, p, d) ? '🟢' : '🔴'} ${name}: ${val(n, p, d) ? 'تشغيل' : 'إيقاف'}`);
}

// ---------- الويب (لوحة التحكم + عرض النسخ) ----------
const LOGO = fs.readFileSync(path.join(PUBLIC, 'logo.webp'));
const DASH = read('dashboard.html');
const VIEW = read('view.html');
const deny = (m) => `<meta charset="utf-8"><body style="background:#07040d;color:#f1e9ff;font-family:Tahoma;text-align:center;padding:80px">${m}</body>`;
const HTTPS = /^https:/i.test(URL_BASE);
const rateHits = new Map();
setInterval(() => rateHits.clear(), 10 * 60 * 1000).unref();
/** ترويسات أمان + حد طلبات + حماية CSRF (طلبات التعديل لازم تكون من نفس الموقع). */
function security(req, res, next) {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Referrer-Policy': 'same-origin' });
  if (req.path !== '/logo.webp') res.set('Cache-Control', 'no-store');
  if (HTTPS) res.set('Strict-Transport-Security', 'max-age=31536000');
  const now = Date.now(), hits = (rateHits.get(req.ip) || []).filter((t) => now - t < 60000);
  hits.push(now);
  rateHits.set(req.ip, hits);
  if (hits.length > 300) return res.status(429).send('Too many requests');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.get('origin');
    try { if (origin && new URL(origin).host !== new URL(URL_BASE).host) return res.status(403).json({ error: 'origin' }); } catch { return res.status(403).json({ error: 'origin' }); }
  }
  next();
}
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(security);
app.use(express.json({ limit: '300kb' }));
const ck = (req) => Object.fromEntries((req.headers.cookie || '').split(';').map((x) => x.trim().split('=')).filter((x) => x[0]));
const who = (req) => sess(req)?.name || 'لوحة التحكم';
const sess = (req) => { const x = db.sessions?.[ck(req).sx]; return x && x.exp > Date.now() ? x : null; };
const auth = (req, res, next) => {
  const x = sess(req);
  if (!x) return res.status(401).json({ error: 'login' });
  req.g = client.guilds.cache.get(x.gid);
  if (!req.g) return res.status(404).json({ error: 'guild' });
  if (!isActive(req.g) && !isOwnerId(x.uid) && !(req.method === 'GET' && req.path === '/api/state')) return res.status(402).json({ error: 'sub' });
  return next();
};
app.get('/health', (q, r) => r.json({ ok: true, ready: client.isReady?.() ?? false, guilds: client.guilds.cache.size })); // فحص الصحة (Render وغيره)
app.get('/logo.webp', (q, r) => r.type('image/webp').send(LOGO));
app.get('/t/:t', (req, res) => {
  const k = db.tokens?.[req.params.t], x = sess(req);
  if (!k || k.exp < Date.now()) return res.status(403).send(deny('الرابط منتهي أو غير صحيح'));
  if (k.used) return x && x.gid === k.gid ? res.redirect(k.to) : res.status(403).send(deny('هذا الرابط استُخدم مسبقاً (صالح لتسجيل دخول واحد فقط)'));
  k.used = true;
  const sid = rid();
  (db.sessions ??= {})[sid] = { gid: k.gid, gids: [k.gid], guilds: [{ id: k.gid, name: client.guilds.cache.get(k.gid)?.name || k.gid, icon: null }], exp: Date.now() + 30 * 864e5 };
  save();
  res.setHeader('Set-Cookie', `sx=${sid}; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax${HTTPS ? '; Secure' : ''}`);
  res.redirect(k.to);
});
const he = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CID = () => process.env.CLIENT_ID || client.user?.id;
const REDIR = () => `${URL_BASE}/auth/callback`;
const cookieSet = (res, k, v, age) => res.append('Set-Cookie', `${k}=${v}; HttpOnly; Path=/; Max-Age=${age}; SameSite=Lax${HTTPS ? '; Secure' : ''}`);
const PAGE = (body) => `<!DOCTYPE html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Systemix</title><link rel="icon" href="/logo.webp">
<body style="margin:0;min-height:100vh;font-family:Tahoma,sans-serif;color:#f1e9ff;background:radial-gradient(900px 500px at 85% -10%,#3b0f73aa,transparent),radial-gradient(700px 500px at 0% 110%,#5a14a855,transparent),#07040d">${body}</body></html>`;
const BTN = 'display:inline-block;background:#8b2fe8;color:#fff;padding:12px 24px;border-radius:12px;text-decoration:none;font-size:15px';
app.get('/', (q, r) => (sess(q) ? r.redirect('/servers') : r.send(PAGE(`<div style="min-height:100vh;display:grid;place-items:center;text-align:center"><div>
  <img src="/logo.webp" width="190" style="filter:drop-shadow(0 0 30px #8b2fe8aa)"><h1 style="font-size:34px;margin:10px">Systemix</h1>
  <p style="color:#a592c4">لوحة التحكم الكاملة بالبوت</p><a href="/auth/login" style="${BTN};margin-top:14px;font-size:17px;padding:14px 32px">تسجيل الدخول بـ Discord</a></div></div>`))));
app.get('/auth/login', (q, r) => {
  if (!process.env.CLIENT_SECRET) return r.status(500).send(deny('أضف CLIENT_SECRET (و CLIENT_ID) في ملف .env ثم أعد تشغيل البوت'));
  const st = rid();
  cookieSet(r, 'st', st, 600);
  r.redirect('https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: CID(), response_type: 'code', scope: 'identify guilds', redirect_uri: REDIR(), state: st, prompt: 'none' }));
});
app.get('/auth/callback', async (q, r) => {
  try {
    if (!q.query.code || q.query.state !== ck(q).st) return r.status(400).send(deny('فشل التحقق، ارجع وجرب مرة ثانية'));
    const tk = await (await fetch('https://discord.com/api/oauth2/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: CID(), client_secret: process.env.CLIENT_SECRET, grant_type: 'authorization_code', code: q.query.code, redirect_uri: REDIR() }) })).json();
    if (!tk.access_token) return r.status(400).send(deny('رفض ديسكورد الدخول: تأكد من CLIENT_SECRET وأن رابط Redirect مضاف في Developer Portal:<br><b>' + REDIR() + '</b>'));
    const H = { Authorization: 'Bearer ' + tk.access_token };
    const [u, gs] = await Promise.all([fetch('https://discord.com/api/users/@me', { headers: H }).then((x) => x.json()), fetch('https://discord.com/api/users/@me/guilds', { headers: H }).then((x) => x.json())]);
    const mine = (Array.isArray(gs) ? gs : []).filter((x) => x.owner || (BigInt(x.permissions || 0) & 8n) === 8n).map((x) => ({ id: x.id, name: x.name, icon: x.icon }));
    const sid = rid();
    (db.sessions ??= {})[sid] = { uid: u.id, name: u.global_name || u.username, guilds: mine, gids: mine.map((x) => x.id), exp: Date.now() + 7 * 864e5 };
    save();
    cookieSet(r, 'sx', sid, 604800);
    r.redirect(isOwnerId(u.id) ? '/owner' : '/servers?auto=1');
  } catch (e) { r.status(500).send(deny('خطأ في تسجيل الدخول')); }
});
app.get('/servers', (q, r) => {
  const x = sess(q);
  if (!x) return r.redirect('/');
  const own = isOwner(q);
  const list = own ? [...client.guilds.cache.values()].map((g) => ({ id: g.id, name: g.name, icon: g.icon })) : (x.guilds || []).filter((g) => client.guilds.cache.has(g.id));
  if (q.query.auto && !own && list.length === 1) { x.gid = list[0].id; save(); return r.redirect('/dashboard'); }
  const card = (g) => {
    const info = subInfo(client.guilds.cache.get(g.id));
    const icon = g.icon ? `https://cdn.discordapp.com/icons/${g.id}/${g.icon}.png?size=64` : '/logo.webp';
    const badge = info.active ? '' : `<span style="background:#ff4d6d;border-radius:10px;padding:2px 10px;font-size:12px;margin-inline-start:8px">${info.status === 'suspended' ? 'متوقف' : 'منتهي'}</span>`;
    return `<div style="display:flex;align-items:center;gap:14px;background:#120a1f;border:1px solid #2a1646;border-radius:16px;padding:14px;margin-bottom:12px"><img src="${icon}" width="48" height="48" style="border-radius:50%"><b style="flex:1">${he(g.name)}${badge}</b><a href="/select/${g.id}" style="${BTN}">إدارة</a></div>`;
  };
  r.send(PAGE(`<div style="max-width:620px;margin:auto;padding:30px 16px"><div style="display:flex;align-items:center;gap:12px;margin-bottom:20px"><img src="/logo.webp" width="46"><h2 style="flex:1;margin:0">سيرفراتك${x.name ? ' — ' + he(x.name) : ''}</h2>${own ? `<a href="/owner" style="${BTN}">👑 لوحة المالك</a>` : ''}<a href="/logout" style="color:#a592c4">خروج</a></div>
    ${list.map(card).join('') || '<p style="color:#a592c4;line-height:1.9">ما لقيت سيرفرات فيها البوت وأنت Administrator فيها.<br>إذا تبغى البوت في سيرفرك تواصل مع مالك البوت.</p>'}</div>`));
});
app.get('/select/:id', async (q, r) => {
  const x = sess(q), g = client.guilds.cache.get(q.params.id);
  if (!x || !g) return r.redirect('/servers');
  if (!isOwner(q)) {
    if (!x.gids?.includes(g.id)) return r.redirect('/servers');
    if (x.uid) {
      const m = await g.members.fetch(x.uid).catch(() => null);
      if (!m || !(m.permissions.has(P.Administrator) || g.ownerId === x.uid)) return r.redirect('/servers');
    }
  }
  x.gid = g.id;
  save();
  r.redirect('/dashboard');
});
app.get('/logout', (q, r) => { if (db.sessions) delete db.sessions[ck(q).sx]; save(); cookieSet(r, 'sx', '', 0); r.redirect('/'); });
app.get('/dashboard', (q, r) => { const x = sess(q); return x?.gid && client.guilds.cache.has(x.gid) ? r.type('html').send(DASH) : r.redirect('/servers'); });
app.get('/view/:id', (q, r) => (sess(q) ? r.type('html').send(VIEW) : r.status(403).send(deny('اطلب رابط الدخول من البوت'))));
app.get('/api/state', auth, (req, res) => {
  const g = req.g, c = cfg(g.id);
  res.json({ guild: g.name, acts: (c.acts || []).slice(0, 100), dlog: (c.dlog || []).slice(0, 100), bin: (c.bin || []).map((e) => ({ id: e.id, kind: e.kind, at: e.at, name: e.d.name })),
    voices: g.channels.cache.filter((x) => x.type === T.GuildVoice).map((x) => ({ id: x.id, name: '🔊 ' + x.name })), sub: subInfo(g), stats: c.stats || {}, isOwner: isOwnerId(sess(req)?.uid), presence: db.bot || {}, bad: Object.entries(db.bad || {}).slice(-100).map(([id, v]) => ({ id, r: v.r })), uptime: Math.floor(process.uptime()), chCount: g.channels.cache.size, roleCount: g.roles.cache.size, members: g.memberCount, ping: client.ws.ping, panic: c.lock, wl: c.wl, ui: c.ui || {}, logs: recent[g.id] || [],
    channels: g.channels.cache.filter((x) => x.type === T.GuildText).map((x) => ({ id: x.id, name: '#' + x.name })),
    categories: g.channels.cache.filter((x) => x.type === T.GuildCategory).map((x) => ({ id: x.id, name: x.name })),
    roles: g.roles.cache.filter((r) => !r.managed && r.id !== g.id).map((r) => ({ id: r.id, name: r.name })),
    top: Object.entries(c.xp).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([id, xp]) => ({ id, name: g.members.cache.get(id)?.user.username || id, xp })),
    backups: (c.backups || []).map((b) => ({ id: b.id, date: b.date, roles: b.roles.length, channels: b.channels.length })) });
});
app.put('/api/config', auth, (req, res) => {
  const b = req.body || {}, n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number(v) || d));
  const c = cfg(req.g.id), { sec, welcome, leave, lvl, tk, wl } = b;
  const old = c.ui || {};
  const { panic: _p, backups: _b, logs: _l, wl: _w, ...rest } = b;
  c.ui = { ...rest, on: b.on !== false, logCh: b.logCh || '', limit: n(b.limit, 1, 20, 3), window: n(b.window, 3, 120, 10),
    punish: ['ban', 'kick', 'strip'].includes(b.punish) ? b.punish : 'ban', altDays: n(b.altDays, 1, 365, 3), autoPanic: !!b.autoPanic,
    panicScore: n(b.panicScore, 3, 100, 12), raidJoins: n(b.raidJoins, 3, 100, 8), raidMin: n(b.raidMin, 1, 120, 5), maxMentions: n(b.maxMentions, 2, 50, 5),
    spamMsgs: n(b.spamMsgs, 3, 30, 6), spamSec: n(b.spamSec, 2, 60, 5), muteMin: n(b.muteMin, 1, 40320, 60), warnMax: n(b.warnMax, 1, 20, 3),
    capsPct: n(b.capsPct, 30, 100, 70), autoBackup: n(b.autoBackup, 0, 168, 0), badDomains: String(b.badDomains || '').slice(0, 2000),
    badWords: String(b.badWords || '').slice(0, 4000), ar: Array.isArray(b.ar) ? b.ar.slice(0, 50) : [] };
  if (c.ui.logCh) c.log = c.ui.logCh;
  c.nuke = sec?.nuke !== false;
  c.wl = (wl || []).filter((x) => /^\d{15,22}$/.test(x));
  save();
  const ch = settingsDiff(old, c.ui);
  const keys = Object.keys(c.ui).filter((k) => JSON.stringify(c.ui[k]) !== JSON.stringify(old[k]));
  if (keys.length) ctx.addDlog?.(req.g, who(req), `تعديل: ${keys.join('، ')}`);
  if (ch.length) log(req.g, '⚙️ تغيير إعدادات من لوحة التحكم', `${sess(req)?.name || 'لوحة التحكم'}:\n${ch.join('\n')}`);
  res.json({ ok: true, changed: ch.length });
});
app.post('/api/panic', auth, async (req, res) => { ctx.addDlog?.(req.g, who(req), req.body.on ? 'تفعيل وضع الطوارئ' : 'إيقاف وضع الطوارئ');
  const r = await setPanic(req.g, !!req.body.on, 'لوحة التحكم'); res.json({ ok: true, ...r }); });
app.post('/api/backup', auth, (req, res) => { const b = createBackup(req.g); res.json({ ok: true, link: newLink(req.g.id, '/view/' + b.id) }); });
app.post('/api/backup/restore', auth, async (req, res) => {
  const b = cfg(req.g.id).backups?.find((x) => x.id === req.body.id);
  if (!b) return res.json({ ok: false });
  res.json({ ok: true, n: await restoreBackup(req.g, b) });
});
app.get('/api/backup/:id', auth, (req, res) => res.json(cfg(req.g.id).backups?.find((x) => x.id === req.params.id) || { error: 'none' }));
app.post('/api/ticketpanel', auth, async (req, res) => {
  const ch = req.g.channels.cache.get(req.body.channel);
  if (!ch?.isTextBased()) return res.json({ ok: false });
  res.json({ ok: !!(await sendPanel(ch).catch(() => null)) });
});
app.post('/api/xp/reset', auth, (req, res) => { cfg(req.g.id).xp = {}; save(); res.json({ ok: true }); });
app.post('/api/mod', auth, async (req, res) => {
  const { action, id, reason, min, role, nick } = req.body || {};
  if (!/^\d{15,22}$/.test(id || '')) return res.json({ ok: false, msg: 'ID غير صحيح' });
  const g = req.g, c = cfg(g.id), ui = c.ui || {}, m = await g.members.fetch(id).catch(() => null);
  const why = String(reason || 'لوحة التحكم').slice(0, 200);
  if (ui.dmPunish && m && ['ban', 'kick', 'timeout', 'warn'].includes(action)) await m.send(`⚠️ إجراء إداري في **${g.name}**: ${action}\nالسبب: ${why}`).catch(() => {});
  try {
    if (action === 'ban') await g.members.ban(id, { reason: why });
    else if (action === 'unban') await g.members.unban(id);
    else if (action === 'kick') await m.kick(why);
    else if (action === 'strip') await m.roles.set([], why);
    else if (action === 'timeout') await m.timeout(Math.min(40320, Math.max(1, +min || 60)) * 60000, why);
    else if (action === 'untimeout') await m.timeout(null);
    else if (action === 'addrole' || action === 'rmrole') {
      const r = g.roles.cache.get(role);
      if (!r) return res.json({ ok: false, msg: 'اختر رتبة' });
      await (action === 'addrole' ? m.roles.add(r) : m.roles.remove(r));
    } else if (action === 'nick') await m.setNickname(String(nick || '').slice(0, 32) || null);
    else if (action === 'warn') {
      const w = ((c.warns ??= {})[id] ??= []);
      w.push({ r: why, at: Date.now() });
      if (w.length >= (ui.warnMax || 3)) {
        const act = ui.warnAct || 'timeout';
        if (act === 'ban') await g.members.ban(id, { reason: 'تحذيرات متكررة' });
        else if (act === 'kick') await m.kick('تحذيرات متكررة');
        else await m.timeout((ui.muteMin || 60) * 60000, 'تحذيرات متكررة');
        c.warns[id] = [];
      }
      save();
    } else if (action === 'clearwarns') { if (c.warns) delete c.warns[id]; save(); }
    else return res.json({ ok: false });
    ctx.addAct(g, action, id, why);
    ctx.addDlog(g, who(req), `إجراء ${action} على ${id}`);
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: 'فشل: تأكد أن العضو موجود وأن رتبة البوت أعلى منه' }); }
});
app.get('/api/warns', auth, (req, res) => res.json(cfg(req.g.id).warns?.[req.query.id] || []));
app.post('/api/chan', auth, async (req, res) => {
  const { action, channel, value, text, title } = req.body || {};
  const ch = req.g.channels.cache.get(channel);
  if (!ch?.isTextBased()) return res.json({ ok: false, msg: 'اختر قناة نصية' });
  try {
    if (action === 'lock' || action === 'unlock') await ch.permissionOverwrites.edit(req.g.roles.everyone, { SendMessages: action === 'lock' ? false : null });
    else if (action === 'slow') await ch.setRateLimitPerUser(Math.min(21600, Math.max(0, +value || 0)));
    else if (action === 'purge') await ch.bulkDelete(Math.min(100, Math.max(1, +value || 1)), true);
    else if (action === 'say') await ch.send(title ? { embeds: [new EmbedBuilder().setTitle(String(title).slice(0, 200)).setDescription(String(text || '').slice(0, 3500)).setColor(0x8b2fe8)] } : { content: String(text || '').slice(0, 1900), allowedMentions: { parse: [] } });
    else return res.json({ ok: false });
    res.json({ ok: true });
  } catch (e) { res.json({ ok: false, msg: 'فشل: تأكد من صلاحيات البوت' }); }
});
app.post('/api/rrpanel', auth, async (req, res) => {
  const { channel, title, roles } = req.body || {};
  const ch = req.g.channels.cache.get(channel);
  const rs = (roles || []).map((id) => req.g.roles.cache.get(id)).filter((r) => r && !r.managed && !DANGER.some((p) => r.permissions.has(p))).slice(0, 20);
  if (!ch?.isTextBased() || !rs.length) return res.json({ ok: false, msg: 'اختر قناة ورتبة (غير إدارية)' });
  const rows = [];
  for (let k = 0; k < rs.length; k += 5) rows.push(new ActionRowBuilder().addComponents(rs.slice(k, k + 5).map((r) => new ButtonBuilder().setCustomId('rr:' + r.id).setLabel(r.name.slice(0, 80)).setStyle(ButtonStyle.Secondary))));
  const sent = await ch.send({ embeds: [new EmbedBuilder().setTitle(String(title || 'اختر رتبك').slice(0, 200)).setDescription('اضغط على الزر لأخذ الرتبة أو سحبها').setColor(0x8b2fe8)], components: rows }).catch(() => null);
  res.json({ ok: !!sent });
});
app.post('/api/presence', auth, (req, res) => {
  if (!isOwnerId(sess(req)?.uid)) return res.json({ ok: false, msg: 'للمالك فقط: ضع OWNER_ID في .env' });
  const { status, type, text } = req.body || {};
  db.bot = { status: ['online', 'idle', 'dnd', 'invisible'].includes(status) ? status : 'online', type: [0, 2, 3, 5].includes(+type) ? +type : 0, text: String(text || '').slice(0, 100) };
  save();
  applyPresence();
  res.json({ ok: true });
});
app.post('/api/reset', auth, (req, res) => { const c = cfg(req.g.id); c.ui = {}; c.nuke = true; save(); res.json({ ok: true }); });
app.post('/api/xp/set', auth, (req, res) => { cfg(req.g.id).xp[req.body.id] = Math.max(0, Math.floor(+req.body.xp) || 0); save(); res.json({ ok: true }); });
app.post('/api/backup/delete', auth, (req, res) => { const c = cfg(req.g.id); c.backups = (c.backups || []).filter((x) => x.id !== req.body.id); save(); res.json({ ok: true }); });
app.post('/api/verifypanel', auth, async (req, res) => {
  const ch = req.g.channels.cache.get(req.body.channel);
  if (!ch?.isTextBased()) return res.json({ ok: false });
  res.json({ ok: !!(await sendVerify(ch).catch(() => null)) });
});
app.post('/api/honeypot/create', auth, async (req, res) => {
  const ch = await req.g.channels.create({ name: '🎁-free-nitro', type: T.GuildText, topic: '⚠️ فخ أمني: أي رسالة هنا = عقوبة تلقائية' }).catch(() => null);
  if (!ch) return res.json({ ok: false });
  const c = cfg(req.g.id);
  c.ui = { ...(c.ui || {}), honeypot: ch.id };
  save();
  res.json({ ok: true, id: ch.id });
});
app.post('/api/bad/add', auth, (req, res) => { if (/^\d{15,22}$/.test(req.body.id || '')) { (db.bad ??= {})[req.body.id] = { r: 'أضيف يدوياً', g: req.g.id, at: Date.now() }; save(); } res.json({ ok: true }); });
app.post('/api/bad/remove', auth, (req, res) => { if (db.bad) delete db.bad[req.body.id]; save(); res.json({ ok: true }); });
const OWNER_HTML = read('owner.html');
const isOwner = (req) => isOwnerId(sess(req)?.uid);
const ownerOnly = (req, res, next) => (isOwner(req) ? next() : res.status(403).json({ error: 'owner' }));
app.get('/owner', (q, r) => (isOwner(q) ? r.type('html').send(OWNER_HTML) : r.status(403).send(deny('هذه الصفحة للمالك فقط (ضع OWNER_ID في .env وسجّل الدخول بحسابك)'))));
app.get('/api/owner/state', ownerOnly, (req, res) => {
  const L = lic(), now = Date.now();
  const rows = [...client.guilds.cache.values()].map((g) => {
    const s = subOf(g), free = isOwnerId(g.ownerId), exp = s.until && s.until <= now;
    return { id: g.id, name: g.name, icon: g.iconURL?.({ size: 64 }) || null, members: g.memberCount || 0, ownerId: g.ownerId, status: free ? 'free' : s.status === 'suspended' ? 'suspended' : exp ? 'expired' : 'active',
      until: s.until, plan: s.plan, note: s.note, added: s.added, hist: (s.hist || []).slice(-4) };
  }).sort((a, b) => (a.until || 9e15) - (b.until || 9e15));
  res.json({ rows, lic: L, bl: Object.keys(db.bl || {}), invite: 'https://discord.com/oauth2/authorize?' + new URLSearchParams({ client_id: CID(), scope: 'bot applications.commands', permissions: '8' }) });
});
app.post('/api/owner/sub', ownerOnly, async (req, res) => {
  const { id, action, days, plan, note } = req.body || {};
  const g = client.guilds.cache.get(id);
  if (!g) return res.json({ ok: false, msg: 'البوت غير موجود في السيرفر' });
  const s = subOf(g), now = Date.now(), d = Math.max(0, Math.min(3650, +days || 0));
  if (typeof note === 'string') s.note = note.slice(0, 300);
  if (typeof plan === 'string') s.plan = plan.slice(0, 40);
  if (action === 'activate' || action === 'extend') {
    const live = s.status === 'active' && s.until && s.until > now;
    const base = action === 'extend' && live ? s.until : now;
    s.status = 'active';
    s.until = d ? base + d * 864e5 : action === 'activate' ? null : s.until;
    delete s.flag; delete s.rem; delete s.stopped;
    (s.hist ??= []).push({ t: now, a: d ? `تفعيل/تمديد ${d} يوم` : 'تفعيل بدون انتهاء' });
    save(); register(g);
    await notifyGuild(g, 'activated', s.until ? `ينتهي: ${new Date(s.until).toLocaleDateString('ar-SA')}` : 'بدون تاريخ انتهاء');
  } else if (action === 'suspend') {
    s.status = 'suspended'; s.stopped = now;
    (s.hist ??= []).push({ t: now, a: 'إيقاف يدوي' });
    save();
    await notifyGuild(g, 'suspended');
  } else save();
  res.json({ ok: true });
});
app.post('/api/owner/leave', ownerOnly, async (req, res) => {
  const g = client.guilds.cache.get(req.body.id);
  if (!g) return res.json({ ok: false });
  await g.leave().catch(() => {});
  res.json({ ok: true });
});
app.post('/api/owner/settings', ownerOnly, (req, res) => {
  const b = req.body || {}, L = lic(), n = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number(v) || d));
  Object.assign(L, { on: b.on !== false, newServers: b.newServers === 'trial' ? 'trial' : 'suspended', trialDays: n(b.trialDays, 0, 365, 0), notifyDays: n(b.notifyDays, 0, 30, 0),
    leaveDays: n(b.leaveDays, 0, 365, 0), contact: String(b.contact || '').slice(0, 200), msg: String(b.msg || '').slice(0, 400) });
  save();
  res.json({ ok: true });
});
app.post('/api/owner/broadcast', ownerOnly, async (req, res) => {
  const { target, text } = req.body || {};
  if (!String(text || '').trim()) return res.json({ ok: false });
  let k = 0;
  for (const g of client.guilds.cache.values()) {
    const act = isActive(g);
    if ((target === 'active' && !act) || (target === 'stopped' && act)) continue;
    await notifyGuild(g, 'custom', String(text).slice(0, 1500));
    k++;
  }
  res.json({ ok: true, n: k });
});
app.post('/api/owner/blacklist', ownerOnly, (req, res) => {
  const { id, add } = req.body || {};
  if (!/^\d{15,22}$/.test(id || '')) return res.json({ ok: false });
  db.bl ??= {};
  if (add === false) delete db.bl[id]; else { db.bl[id] = Date.now(); client.guilds.cache.get(id)?.leave().catch(() => {}); }
  save();
  res.json({ ok: true });
});

// ---------- طبقات الحماية المتقدمة ----------
const DANGER = [P.Administrator, P.ManageGuild, P.ManageRoles, P.ManageChannels, P.BanMembers, P.KickMembers, P.ManageWebhooks];
const seenE = new Set();
async function lastAudit(g, type, ms = 5000) {
  const l = await g.fetchAuditLogs({ type, limit: 1 }).catch(() => null);
  const e = l?.entries.first();
  return e && Date.now() - e.createdTimestamp < ms ? e : null;
}
const threats = {};
function threat(g, pts, why) {
  const ui = cfg(g.id).ui || {}, now = Date.now();
  const a = (threats[g.id] = (threats[g.id] || []).filter((x) => now - x.t < 60000));
  a.push({ t: now, p: pts });
  if (ui.autoPanic && !cfg(g.id).lock && a.reduce((t, x) => t + x.p, 0) >= (ui.panicScore || 12)) {
    threats[g.id] = [];
    setPanic(g, true, 'التحليل الاستباقي (' + why + ')');
  }
}
function addBad(g, id, why) {
  if (trusted(g, id)) return;
  (db.bad ??= {})[id] = { r: String(why).slice(0, 80), g: g.id, at: Date.now() };
  save();
}
Object.assign(KEY, { 'إنشاء قنوات': 'chan', 'تعديل قنوات': 'chan', 'إنشاء رتب': 'role', 'تعديل رتب': 'role', 'حذف إيموجي': 'emoji', 'حذف ملصقات': 'emoji' });
client.on('channelCreate', (c) => c.guild && guard(c.guild, A.ChannelCreate, 'إنشاء قنوات'));
client.on('channelUpdate', (o, n) => n.guild && guard(n.guild, A.ChannelUpdate, 'تعديل قنوات'));
client.on('roleCreate', (r) => guard(r.guild, A.RoleCreate, 'إنشاء رتب'));
client.on('roleUpdate', (o, n) => guard(n.guild, A.RoleUpdate, 'تعديل رتب'));
client.on('emojiDelete', (e) => guard(e.guild, A.EmojiDelete, 'حذف إيموجي'));
client.on('stickerDelete', (x) => x.guild && guard(x.guild, A.StickerDelete, 'حذف ملصقات'));

// حماية إعدادات السيرفر (اسم/شعار/مستوى التحقق)
client.on('guildUpdate', async (o, n) => {
  if (off(n, 'gset') || (o.name === n.name && o.icon === n.icon && o.verificationLevel === n.verificationLevel)) return;
  const e = await lastAudit(n, A.GuildUpdate);
  if (!e || trusted(n, e.executor.id)) return;
  await n.edit({ name: o.name, verificationLevel: o.verificationLevel, icon: o.iconURL({ extension: 'png', size: 1024 }) }).catch(() => {});
  await punishBy(n, e.executor.id, 'Server settings change');
  log(n, '🏰 تعديل إعدادات السيرفر', `<@${e.executor.id}> غيّر الاسم/الشعار/التحقق. تم التراجع والعقوبة.`, e.executor.id);
});

// حماية التكاملات
client.on('guildIntegrationsUpdate', async (g) => {
  if (off(g, 'integ')) return;
  for (const t of [A.IntegrationCreate, A.IntegrationDelete]) {
    const e = await lastAudit(g, t);
    if (e && !trusted(g, e.executor.id) && !seenE.has(e.id)) {
      seenE.add(e.id);
      await punishBy(g, e.executor.id, 'Integration abuse');
      log(g, '🔌 تلاعب بالتكاملات', `<@${e.executor.id}> عدّل التكاملات`, e.executor.id);
    }
  }
});

// الاسترجاع التلقائي للمحذوف
async function restoreOne(g, kind, name, type) {
  const b = cfg(g.id).backups?.[0];
  if (!b || off(g, 'restore')) return;
  const e = await lastAudit(g, kind === 'ch' ? A.ChannelDelete : A.RoleDelete, 8000);
  if (!e || trusted(g, e.executor.id)) return;
  if (kind === 'ch') {
    const x = b.channels.find((y) => y.name === name && y.type === type);
    if (!x) return;
    const parent = x.parent && g.channels.cache.find((y) => y.name === x.parent && y.type === T.GuildCategory);
    await g.channels.create(chanOpts(g, x, parent)).catch(() => {});
  } else {
    const r = b.roles.find((y) => y.name === name);
    if (!r) return;
    await g.roles.create({ name: r.name, color: r.color, hoist: r.hoist, permissions: BigInt(r.perms) }).catch(() => {});
  }
  log(g, '♻️ استرجاع تلقائي', `تم استرجاع ${kind === 'ch' ? 'الروم' : 'الرتبة'} **${name}** من آخر نسخة`);
}
client.on('channelDelete', (c) => c.guild && restoreOne(c.guild, 'ch', c.name, c.type));
client.on('roleDelete', (r) => restoreOne(r.guild, 'role', r.name));

// البوتات، القائمة السوداء، كشف الغارات
const joins = {}, raid = {};
client.on('guildMemberAdd', async (m) => {
  const g = m.guild, c = cfg(g.id), ui = c.ui || {};
  if (off(g, '_')) return;
  if (m.user.bot) {
    if (m.id === client.user.id || off(g, 'bots') || c.wl.includes(m.id)) return;
    const e = await lastAudit(g, A.BotAdd);
    if (e && trusted(g, e.executor.id)) return;
    await m.kick('Strict bot whitelist').catch(() => {});
    if (e) await punishBy(g, e.executor.id, 'Unauthorized bot add');
    return log(g, '🤖 بوت غير مصرّح', `تم طرد البوت **${m.user.username}**${e ? ` وعقوبة <@${e.executor.id}>` : ''}`, e?.executor.id);
  }
  if (!off(g, 'trust') && db.bad?.[m.id] && !trusted(g, m.id)) {
    await m.ban({ reason: 'Blacklist: ' + db.bad[m.id].r }).catch(() => {});
    return log(g, '🕸️ مخرب معروف', `تم حظر <@${m.id}> تلقائياً (السبب السابق: ${db.bad[m.id].r})`);
  }
  if (off(g, 'raid')) return;
  const now = Date.now(), a = (joins[g.id] = (joins[g.id] || []).filter((x) => now - x.t < 10000));
  a.push({ id: m.id, t: now });
  if (raid[g.id] > now) return void m.kick('Raid mode').catch(() => {});
  if (a.length >= (ui.raidJoins || 8)) {
    raid[g.id] = now + (ui.raidMin || 5) * 60000;
    for (const x of a) (ui.raidAct === 'ban' ? g.members.ban(x.id, { reason: 'Raid wave' }) : g.members.kick(x.id, 'Raid wave')).catch(() => {});
    threat(g, 6, 'raid');
    log(g, '🌊 غارة انضمام', `${a.length} عضو دخلوا خلال 10 ثواني. تم طردهم وتفعيل وضع الغارة ${ui.raidMin || 5} دقائق.`);
  }
});

// الفخ، سبام المنشن، درع الروابط
const OFFICIAL = /(^|\.)(discord\.com|discord\.gg|discordapp\.com|discordapp\.net|discord\.media|discord\.gift|discord\.new|discordstatus\.com|steampowered\.com|steamcommunity\.com)$/i;
client.on('messageCreate', async (m) => {
  if (!m.guild || m.author.bot || !m.member) return;
  const g = m.guild, ui = cfg(g.id).ui || {};
  if (off(g, '_') || trusted(g, m.author.id)) return;
  if (ui.honeypot && m.channelId === ui.honeypot && !off(g, 'honey')) {
    m.delete().catch(() => {});
    await punishBy(g, m.author.id, 'Honeypot');
    return log(g, '🍯 وقع في الفخ', `<@${m.author.id}> كتب في قناة الفخ`, m.author.id);
  }
  let why = null;
  const txt = m.content || '';
  if (!off(g, 'spam')) {
    const k = g.id + m.author.id, now = Date.now(), a = (spamB[k] = (spamB[k] || []).filter((t) => now - t < (ui.spamSec || 5) * 1000));
    a.push(now);
    if (a.length >= (ui.spamMsgs || 6)) { spamB[k] = []; why = 'سبام رسائل'; }
  }
  if (!why && !off(g, 'words') && ui.badWords) {
    const lw = String(ui.badWords).toLowerCase().split(/[\n,]+/).map((x) => x.trim()).filter(Boolean), t = txt.toLowerCase();
    if (lw.some((w) => t.includes(w))) why = 'كلمة ممنوعة';
  }
  if (!why && ui.capsOn && txt.length >= 10) {
    const l = txt.replace(/[^A-Za-z]/g, '');
    if (l.length >= 8 && (l.replace(/[^A-Z]/g, '').length / l.length) * 100 >= (ui.capsPct || 70)) why = 'حروف كبيرة';
  }
  if (!why && ui.blockInvites) {
    const ok = String(ui.allowInv || '').toLowerCase().split(/[\s,]+/);
    for (const mm of txt.matchAll(/(?:discord\.gg|discord(?:app)?\.com\/invite)\/([\w-]+)/gi)) if (!ok.includes(mm[1].toLowerCase())) { why = 'دعوة سيرفر'; break; }
  }
  if (!off(g, 'mention') && (m.mentions.everyone || m.mentions.users.size + m.mentions.roles.size >= (ui.maxMentions || 5))) why = 'سبام منشن';
  if (!why && !off(g, 'link')) {
    const urls = m.content.match(/https?:\/\/[^\s<>()]+|(?:discord\.gg|discord\.com\/invite)\/\S+/gi) || [];
    const bad = String(ui.badDomains || '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    for (const u of urls) {
      let host = '';
      try { host = new URL(/^https?:/i.test(u) ? u : 'https://' + u).hostname.toLowerCase(); } catch {}
      if (!host) continue;
      if (bad.some((d) => host === d || host.endsWith('.' + d))) { why = 'رابط محظور'; break; }
      if (/(discord|nitro|steam|dlscord|discrod)/.test(host) && !OFFICIAL.test(host)) { why = 'رابط تصيّد محتمل'; break; }
    }
  }
  if (!why) return;
  m.delete().catch(() => {});
  const risky = DANGER.some((p) => m.member.permissions.has(p));
  const soft = ['سبام رسائل', 'كلمة ممنوعة', 'حروف كبيرة', 'دعوة سيرفر'].includes(why);
  if (risky && !soft) await m.member.roles.set([], 'Auto-quarantine: ' + why).catch(() => {});
  else if (!risky && !(why === 'كلمة ممنوعة' && ui.wordAction === 'delete')) await m.member.timeout((ui.muteMin || 60) * 60000, why).catch(() => {});
  threat(g, soft ? 1 : risky ? 5 : 2, why);
  log(g, soft ? '🧹 فلتر المحتوى' : risky ? '🧪 حجر تلقائي' : '🛡️ درع الرسائل', `<@${m.author.id}>: ${why}`, m.author.id);
});

// بوابة التحقق (سؤال بشري)
const vq = {};
const sendVerify = (ch) => ch.send({ embeds: [new EmbedBuilder().setColor(0x8b2fe8).setTitle('✅ التحقق').setDescription('اضغط الزر وجاوب على سؤال بسيط عشان تدخل السيرفر')],
  components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('verify_start').setLabel('تحقق').setStyle(ButtonStyle.Success))] });
client.on('interactionCreate', async (i) => {
  if (!i.guild) return;
  if (i.isButton() && i.customId === 'verify_start') {
    const a = 1 + Math.floor(Math.random() * 9), b = 1 + Math.floor(Math.random() * 9);
    vq[i.user.id] = a + b;
    return i.showModal(new ModalBuilder().setCustomId('verify_modal').setTitle('تحقق بشري').addComponents(
      new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId('ans').setLabel(`كم ناتج ${a} + ${b} ؟`).setStyle(TextInputStyle.Short).setRequired(true))));
  }
  if (i.isModalSubmit() && i.customId === 'verify_modal') {
    const ok = String(vq[i.user.id]) === i.fields.getTextInputValue('ans').trim();
    delete vq[i.user.id];
    if (!ok) return i.reply({ content: '❌ إجابة خاطئة، حاول مرة ثانية', flags: 64 });
    const role = cfg(i.guild.id).ui?.verify?.role;
    if (role) await i.member.roles.add(role).catch(() => {});
    return i.reply({ content: '✅ تم التحقق، حياك الله', flags: 64 });
  }
});

// نسخ تلقائي + حماية من الانهيار
setInterval(() => client.guilds.cache.forEach((g) => {
  const h = isActive(g) && cfg(g.id).ui?.autoBackup;
  if (h && Date.now() - (cfg(g.id).backups?.[0]?.date || 0) > h * 36e5) createBackup(g);
}), 10 * 60 * 1000);
process.on('uncaughtException', (e) => console.log('Crash guard:', e?.message || e));
client.on('error', (e) => console.log('Client error:', e?.message));

// ---------- سجلات الأحداث + أتمتة + ميزات إضافية ----------
const spamB = {};
function chanSnap(g, x) {
  return {
    name: x.name, type: x.type, parent: x.parent?.name || null, topic: x.topic || null, slow: x.rateLimitPerUser || 0, nsfw: !!x.nsfw,
    ow: x.permissionOverwrites.cache.filter((o) => o.type === 0)
      .map((o) => ({ role: o.id === g.id ? '@everyone' : g.roles.cache.get(o.id)?.name, allow: o.allow.bitfield.toString(), deny: o.deny.bitfield.toString() })).filter((o) => o.role),
  };
}
const chanOpts = (g, x, parent) => ({
  name: x.name, type: x.type, topic: x.topic || undefined, parent: parent?.id,
  ...(x.type === T.GuildText ? { rateLimitPerUser: x.slow || 0, nsfw: !!x.nsfw } : {}),
  permissionOverwrites: (x.ow || []).map((o) => ({ id: o.role === '@everyone' ? g.id : g.roles.cache.find((r) => r.name === o.role)?.id, allow: BigInt(o.allow), deny: BigInt(o.deny) })).filter((o) => o.id),
});
function applyPresence() {
  const p = db.bot;
  if (p) client.user.setPresence({ status: p.status || 'online', activities: p.text ? [{ name: String(p.text).slice(0, 100), type: +p.type || 0 }] : [] });
}

// رتب تلقائية + رسالة خاصة
client.on('guildMemberAdd', (m) => {
  const g = m.guild, ui = cfg(g.id).ui || {};
  if (off(g, '_') || cfg(g.id).lock) return;
  const roleId = m.user.bot ? ui.botrole : ui.autorole;
  if (roleId) m.roles.add(roleId).catch(() => {});
  if (!m.user.bot && ui.welcome?.dm && ui.welcome?.dmMsg) m.send(fmt(ui.welcome.dmMsg, m, false)).catch(() => {});
});

// الردود التلقائية
client.on('messageCreate', (m) => {
  if (!m.guild || m.author.bot || off(m.guild, '_')) return;
  const ar = cfg(m.guild.id).ui?.ar;
  if (!ar?.length) return;
  const t = m.content.trim().toLowerCase();
  const hit = ar.find((x) => x.t && (x.exact ? t === String(x.t).toLowerCase() : t.includes(String(x.t).toLowerCase())));
  if (hit) m.reply({ content: String(hit.r).slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {});
});

// رتب بالأزرار
client.on('interactionCreate', async (i) => {
  if (!i.guild || !i.isButton() || !i.customId.startsWith('rr:')) return;
  const role = i.guild.roles.cache.get(i.customId.slice(3));
  if (!role || DANGER.some((p) => role.permissions.has(p))) return i.reply({ content: '❌ رتبة غير متاحة', flags: 64 });
  const has = i.member.roles.cache.has(role.id);
  await (has ? i.member.roles.remove(role) : i.member.roles.add(role)).catch(() => {});
  i.reply({ content: has ? `➖ سحبت رتبة ${role.name}` : `➕ أخذت رتبة ${role.name}`, flags: 64 });
});

// ---------- الأوامر ----------
const admin = P.Administrator;
const commands = [
  new S().setName('setup').setDescription('إعداد القنوات').setDefaultMemberPermissions(admin)
    .addChannelOption((o) => o.setName('log').setDescription('قناة اللوج').addChannelTypes(T.GuildText))
    .addChannelOption((o) => o.setName('welcome').setDescription('قناة الترحيب').addChannelTypes(T.GuildText)),
  new S().setName('whitelist').setDescription('إضافة/إزالة شخص من القائمة البيضاء (للأونر فقط)').setDefaultMemberPermissions(admin)
    .addUserOption((o) => o.setName('user').setDescription('العضو').setRequired(true)),
  new S().setName('panic').setDescription('وضع الطوارئ').setDefaultMemberPermissions(admin)
    .addStringOption((o) => o.setName('mode').setDescription('on/off').setRequired(true).addChoices({ name: 'تشغيل', value: 'on' }, { name: 'إيقاف', value: 'off' })),
  new S().setName('backup').setDescription('نسخ احتياطي للهيكل').setDefaultMemberPermissions(admin)
    .addStringOption((o) => o.setName('action').setDescription('save/restore').setRequired(true).addChoices({ name: 'حفظ', value: 'save' }, { name: 'استعادة المفقود', value: 'restore' })),
  new S().setName('dashboard').setDescription('رابط دخول لوحة التحكم (استخدام واحد)').setDefaultMemberPermissions(admin),
  new S().setName('rank').setDescription('مستواك'),
  new S().setName('ticketpanel').setDescription('لوحة التذاكر').setDefaultMemberPermissions(admin),
].map((c) => c.toJSON());

const register = (g) => g.commands.set(commands).catch((e) => console.log('register fail', e.message));
client.on('guildCreate', register);
client.once('ready', () => {
  console.log('✅ Online:', client.user.tag);
  applyPresence();
  client.guilds.cache.forEach(register);
});

client.on('interactionCreate', async (i) => {
  const g = i.guild;
  if (!g) return;
  const c = cfg(g.id);
  const reply = (content) => (i.deferred ? i.editReply(content) : i.reply({ content, flags: 64 }));

  // أزرار
  if (i.isButton()) {
    const [act, id] = i.customId.split(':');
    if (act === 'ban' || act === 'strip') {
      if (!i.member.permissions.has(admin)) return reply('❌ للإدارة فقط');
      if (act === 'ban') { await punish(g, id, 'من زر اللوج'); return reply('✅ تم الحظر'); }
      const m = await g.members.fetch(id).catch(() => null);
      await m?.roles.set([], 'Quarantine').catch(() => {});
      return reply('✅ تم سحب كل الرتب');
    }
    if (i.customId === 'ticket_open') {
      const dup = g.channels.cache.find((x) => x.name === ('ticket-' + i.user.username).toLowerCase());
      if (dup) return reply('⚠️ عندك تذكرة مفتوحة: ' + dup.toString());
      const ch = await g.channels.create({
        name: 'ticket-' + i.user.username, type: T.GuildText, parent: c.ui?.tk?.cat || undefined,
        permissionOverwrites: [
          { id: g.id, deny: [P.ViewChannel] },
          ...(c.ui?.tk?.role ? [{ id: c.ui.tk.role, allow: [P.ViewChannel, P.SendMessages] }] : []),
          { id: i.user.id, allow: [P.ViewChannel, P.SendMessages] },
          { id: client.user.id, allow: [P.ViewChannel, P.SendMessages, P.ManageChannels] },
        ],
      });
      ch.send({ content: `<@${i.user.id}> الإدارة بترد عليك قريب.`, components: [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('ticket_close').setLabel('إغلاق').setStyle(ButtonStyle.Danger))] });
      ctx.logE?.(g, 'tkopen', '🎫 فتح تذكرة', `<@${i.user.id}> ← ${ch}`);
      return reply('🎫 تم فتح تذكرتك: ' + ch.toString());
    }
    if (i.customId === 'ticket_close') {
      ctx.logE?.(g, 'tkclose', '🔒 إغلاق تذكرة', `${i.channel.name} — <@${i.user.id}>`);
      await reply('سيتم الحذف بعد 5 ثواني...');
      return setTimeout(() => i.channel.delete().catch(() => {}), 5000);
    }
    return;
  }

  if (!i.isChatInputCommand()) return;

  switch (i.commandName) {
    case 'setup': {
      const l = i.options.getChannel('log'), w = i.options.getChannel('welcome');
      if (l) c.log = l.id;
      if (w) c.welcome = w.id;
      save();
      return reply('✅ تم الحفظ');
    }
    case 'whitelist': {
      if (i.user.id !== g.ownerId) return reply('❌ للأونر فقط');
      const id = i.options.getUser('user').id;
      c.wl = c.wl.includes(id) ? c.wl.filter((x) => x !== id) : [...c.wl, id];
      save();
      return reply(c.wl.includes(id) ? '✅ أُضيف للقائمة البيضاء' : '✅ أُزيل من القائمة البيضاء');
    }
    case 'panic': {
      await i.deferReply({ flags: 64 });
      const on = i.options.getString('mode') === 'on';
      await setPanic(g, on, `<@${i.user.id}>`);
      return reply(on ? '🔒 تم قفل السيرفر ومنع الانضمام' : '🔓 تم الفتح');
    }
    case 'backup': {
      await i.deferReply({ flags: 64 });
      if (i.options.getString('action') === 'save') {
        const b = createBackup(g);
        return reply(`💾 تم حفظ ${b.roles.length} رتبة و${b.channels.length} قناة\n🔗 رابط عرض النسخة (يعمل لتسجيل دخول واحد فقط):\n${newLink(g.id, '/view/' + b.id)}`);
      }
      const b = c.backups?.[0];
      if (!b) return reply('❌ ما في نسخة محفوظة');
      return reply(`♻️ تمت استعادة ${await restoreBackup(g, b)} عنصر مفقود`);
    }
    case 'dashboard':
      return reply('🔗 رابط لوحة التحكم (يعمل لتسجيل دخول واحد فقط، لا تشاركه):\n' + newLink(g.id, '/dashboard'));
    case 'rank': {
      const xp = c.xp[i.user.id] || 0;
      return reply(`⭐ XP: **${xp}** | الفل: **${Math.floor(0.1 * Math.sqrt(xp))}**`);
    }
    case 'ticketpanel': {
      await sendPanel(i.channel);
      return reply('✅ تم');
    }
  }
});

process.on('unhandledRejection', (e) => console.log('Error:', e?.message || e));
const color = (c, d) => { const n = parseInt(String(c || '').replace('#', ''), 16); return Number.isNaN(n) ? d : n; };
Object.assign(ctx, { client, app, auth, sess, who, cfg, save, db, off, isActive, trusted, findCh, fmt, rid, color, chanOpts, chanSnap, DANGER, log, discord });
for (const f of ['logs', 'tools', 'tempvoice', 'bin', 'starboard', 'statchannels']) require(`./features/${f}`)(ctx);

app.listen(PORT, () => console.log('🌐 Web:', URL_BASE));
if (!process.env.TOKEN) { console.error('❌ TOKEN غير موجود في ملف .env'); process.exit(1); }
client.login(process.env.TOKEN);

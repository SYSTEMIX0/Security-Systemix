'use strict';
/**
 * أدوات الاختبار: تحمّل البوت بدون اتصال حقيقي بديسكورد (مكتبات وهمية)
 * وتعطي وصولاً للأحداث (handlers) وللمسارات (routes) لاختبارها مباشرة.
 */
const Module = require('module');
const path = require('path');
const fs = require('fs');
const os = require('os');

class Coll extends Map {
  filter(f) { const r = new Coll(); for (const [k, v] of this) if (f(v, k)) r.set(k, v); return r; }
  map(f) { return [...this].map(([k, v]) => f(v, k)); }
  find(f) { for (const [k, v] of this) if (f(v, k)) return v; }
  some(f) { return !!this.find(f); }
  first() { return [...this.values()][0]; }
  sort() { return this; }
}

const perms = { has: () => false, bitfield: 0n };
const channel = (calls, id = 'c1', extra = {}) => ({
  id, name: 'general', type: 'GuildText', parent: null, parentId: null, topic: null, rawPosition: 0, rateLimitPerUser: 0, nsfw: false,
  send: async (x) => { calls.push('send:' + (x.content || (x.embeds && 'embed'))); return { id: 'm' + calls.length, edit: async () => {} }; },
  isTextBased: () => true, permissionsFor: () => perms,
  permissionOverwrites: { cache: new Coll(), edit: async () => calls.push('lock') },
  setRateLimitPerUser: async (n) => calls.push('slow' + n), bulkDelete: async (n) => calls.push('purge' + n), setName: async (n) => { calls.push('rename:' + n); },
  messages: { fetch: async () => null }, members: new Coll(), delete: async () => calls.push('chdelete:' + id), ...extra,
});
const guild = (calls, id, ownerId, extra = {}) => {
  const member = { id: '5', displayName: 'Sara', permissions: perms, timeout: async (ms) => calls.push('timeout:' + ms), kick: async () => calls.push('kick'), send: async (t) => calls.push('dm:' + t),
    roles: { set: async () => calls.push('strip'), add: async (r) => calls.push('addrole:' + (r.id || r)), remove: async () => {}, cache: new Coll() }, setNickname: async () => {}, user: { bot: false } };
  const g = {
    id, name: 'G' + id, ownerId, memberCount: 7, premiumSubscriptionCount: 2, systemChannel: null, member,
    channels: { cache: new Coll([['c1', channel(calls)]]), create: async (o) => { calls.push('create:' + o.name); return channel(calls, 'new' + calls.length, { name: o.name, type: o.type }); } },
    roles: { cache: new Coll([['r1', { id: 'r1', name: 'Member', permissions: perms, managed: false, position: 1, color: 0, hoist: false }]]), everyone: { id }, create: async (o) => calls.push('rolecreate:' + o.name) },
    members: { cache: new Coll(), me: { setNickname: async (n) => calls.push('nick:' + n) }, fetch: async () => member, ban: async () => calls.push('ban'), unban: async () => {} },
    commands: { set: async () => calls.push('register') }, fetchOwner: async () => ({ send: async () => calls.push('dm-owner') }),
    fetchAuditLogs: async () => ({ entries: { first: () => g.audit || null } }), leave: async () => calls.push('leave:' + id), iconURL: () => null, ...extra,
  };
  return g;
};

function loadBot({ owner = '', sessions = null, guilds = () => [], env = {}, publicUrl = 'http://localhost:3000' } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'systemix-'));
  Object.assign(process.env, { DATA_DIR: dir, TOKEN: 'test' }, env);
  if (publicUrl) process.env.PUBLIC_URL = publicUrl; else delete process.env.PUBLIC_URL;
  if (owner) process.env.OWNER_ID = owner; else delete process.env.OWNER_ID;
  if (sessions) fs.writeFileSync(path.join(dir, 'data.json'), JSON.stringify({ sessions }));

  const handlers = {}, routes = {}, uses = [], calls = [];
  const all = new Coll(guilds(calls).map((g) => [g.id, g]));
  const proxy = () => new Proxy(function () {}, { get: (t, k) => (k === 'toJSON' ? () => ({}) : proxy()), apply: () => proxy() });
  const enumP = () => new Proxy({}, { get: (t, k) => (typeof k === 'string' ? k : undefined) });
  class Client {
    constructor() { this.user = { id: 'BOT', username: 'bot', setPresence() {} }; this.guilds = { cache: all }; this.ws = { ping: 12 }; this.users = { fetch: async () => ({ send: async () => {} }) }; }
    on(e, f) { (handlers[e] ||= []).push(f); }
    once() {}
    login() {}
  }
  const B = class { constructor() { return proxy(); } };
  const discord = { Client, GatewayIntentBits: enumP(), Partials: enumP(), PermissionFlagsBits: enumP(), AuditLogEvent: enumP(), ChannelType: enumP(), ButtonStyle: enumP(), TextInputStyle: enumP(),
    EmbedBuilder: B, ActionRowBuilder: B, ButtonBuilder: B, SlashCommandBuilder: B, ModalBuilder: B, TextInputBuilder: B };
  const app = { use: (f) => uses.push(f), set() {}, disable() {}, listen() {} };
  for (const m of ['get', 'post', 'put']) app[m] = (p, ...f) => (routes[`${m} ${p}`] = f);
  const express = Object.assign(() => app, { json: () => () => {} });
  const stubs = { 'discord.js': discord, express, dotenv: { config() {} } };

  const orig = Module._load, origInterval = global.setInterval;
  global.setInterval = (...a) => origInterval(...a).unref(); // لا نترك مؤقتات تمنع انتهاء الاختبار
  Module._load = function (req, ...a) { return Object.hasOwn(stubs, req) ? stubs[req] : orig.call(this, req, ...a); };
  const srcDir = path.join(__dirname, '..', 'src') + path.sep;
  for (const k of Object.keys(require.cache)) if (k.startsWith(srcDir)) delete require.cache[k];
  try { require('../src/index.js'); } finally { Module._load = orig; global.setInterval = origInterval; }

  const fire = async (ev, ...a) => { for (const f of handlers[ev] || []) await f(...a); };
  /** يشغّل سلسلة المسار (auth ثم المعالج) كما يفعل express. */
  const call = async (key, req = {}) => {
    const res = { code: 200, status(c) { this.code = c; return this; }, json(x) { this.out = x; }, send(x) { this.out = x; }, type() { return this; }, redirect(u) { this.out = 'redirect:' + u; }, set() {}, append() {} };
    const rq = { headers: {}, body: {}, query: {}, params: {}, path: key.split(' ')[1], method: key.split(' ')[0].toUpperCase(), ...req };
    for (const h of routes[key]) { let nx = false; await h(rq, res, () => (nx = true)); if (!nx) break; }
    return res;
  };
  const msg = (g, content, extra = {}) => ({ guild: g, author: { id: '5', bot: false }, member: g.member, content, channelId: 'c1', mentions: { everyone: false, users: { size: 0 }, roles: { size: 0 } },
    delete: async () => calls.push('delete'), reply: async (x) => calls.push('reply:' + (x.content || x)), channel: g.channels.cache.get('c1'), ...extra });
  return { handlers, routes, uses, calls, fire, call, msg, Coll, guilds: all, dir };
}

const session = (gid, uid = 'U1', gids = [gid]) => ({ uid, name: 'user', gid, gids, guilds: gids.map((id) => ({ id, name: 'G' + id, icon: null })), exp: Date.now() + 1e9 });
module.exports = { loadBot, guild, channel, Coll, session, perms };

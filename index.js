// SevereClaw presence bot.
// Следит за статусами Discord у тебя и друзей на твоём сервере
// и выкладывает их в публичный gist, откуда их читает severeclaw.github.io.

const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');

const CFG_PATH = path.join(__dirname, 'config.json');
if (!fs.existsSync(CFG_PATH)) {
  console.error('Нет config.json. Скопируй config.example.json в config.json и заполни его.');
  process.exit(1);
}
let cfg;
try {
  // Блокнот иногда сохраняет файл с невидимым символом BOM в начале — убираем его.
  cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8').replace(/^﻿/, ''));
} catch (e) {
  console.error('config.json сломан, не могу его прочитать:', e.message);
  console.error('Проверь, что каждое значение в кавычках, а между строками стоят запятые, как в config.example.json.');
  process.exit(1);
}
const clean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bot\s+/i, '').replace(/\s+/g, '');
cfg.discordToken = clean(cfg.discordToken);
cfg.githubToken = clean(cfg.githubToken);
cfg.guildId = clean(cfg.guildId);
for (const k of ['discordToken', 'githubToken', 'guildId']) {
  if (!cfg[k] || cfg[k].includes('ВСТАВЬ')) {
    console.error(`В config.json не заполнено поле "${k}".`);
    process.exit(1);
  }
}
{
  const t = cfg.discordToken;
  const hint = 'Нужен токен со вкладки Bot (кнопка Reset Token), а не Application ID, Public Key или Client Secret со вкладки General/OAuth2.';
  if (/^\d{17,20}$/.test(t)) { console.error('В discordToken стоит ID (только цифры), а не токен. ' + hint); process.exit(1); }
  if (/^[a-f0-9]{64}$/i.test(t)) { console.error('В discordToken стоит Public Key, а не токен. ' + hint); process.exit(1); }
  if (t.split('.').length !== 3) { console.error(`discordToken не похож на токен бота (у токена три части через точку, а тут ${t.split('.').length}). ` + hint); process.exit(1); }
  if (!/^\d{17,20}$/.test(cfg.guildId)) { console.error('guildId должен быть числом, например 1234567890123456789 (ПКМ по серверу → Копировать ID сервера).'); process.exit(1); }
}
const IDS = [cfg.ownerId, ...(cfg.friends || [])].filter(Boolean);
const FILE = 'presence.json';
const VFILE = 'visitors.json';
const MIN_GAP = 15_000;      // не чаще раза в 15 секунд
const HEARTBEAT = 120_000;   // раз в 2 минуты, даже если ничего не поменялось

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
});

const log = (...a) => console.log(new Date().toLocaleTimeString('ru-RU'), ...a);
const ms = d => (d ? new Date(d).getTime() : undefined);

// ---------- арт игры из Steam ----------
// Discord знает только название игры, поэтому ищем её в магазине Steam
// и берём оттуда фон страницы, баннер библиотеки и шапку.
const artCache = new Map();          // имя игры -> арт или null (не нашли)
const norm = s => String(s).toLowerCase().replace(/[™®©:'’!?.,\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
async function steam(url) {
  const r = await fetch(url, { headers: { 'User-Agent': 'severeclaw-presence-bot' } });
  if (!r.ok) throw new Error('Steam ' + r.status);
  return r.json();
}
async function lookupArt(name) {
  if (artCache.has(name)) return;
  artCache.set(name, null);
  const manual = cfg.gameArt && cfg.gameArt[name];
  if (manual) { artCache.set(name, { background: manual }); schedule(); return; }
  try {
    const s = await steam(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(name)}&l=english&cc=US`);
    const items = s.items || [];
    const q = norm(name);
    const hit = items.find(i => norm(i.name) === q)
      || items.find(i => norm(i.name).startsWith(q) || q.startsWith(norm(i.name)));
    if (!hit) { log(`Арт: «${name}» не нашёл в Steam (можно задать вручную в gameArt)`); return; }
    const d = await steam(`https://store.steampowered.com/api/appdetails?appids=${hit.id}&l=english`);
    const data = d[hit.id] && d[hit.id].success ? d[hit.id].data : {};
    artCache.set(name, {
      appid: hit.id,
      hero: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${hit.id}/library_hero.jpg`,
      background: data.background_raw || data.background || null,
      header: data.header_image || null,
    });
    log(`Арт: «${name}» → Steam ${hit.id} (${hit.name})`);
    schedule();
  } catch (e) {
    artCache.delete(name);           // попробуем ещё раз при следующем обновлении
    log(`Арт: не смог спросить Steam про «${name}»:`, e.message);
  }
}

const KIND_RU = { 0: 'Играет', 1: 'Стримит', 2: 'Слушает', 3: 'Смотрит', 4: 'Статус', 5: 'Соревнуется' };
let lastOwnerLine = '';
function logOwner(users) {
  const u = users[cfg.ownerId];
  let line;
  if (!u) line = 'тебя нет на сервере — статус не виден';
  else if (!u.activities.length) line = `${u.discord_status}, Discord не передаёт ни одной активности`;
  else line = u.discord_status + ' | ' + u.activities.map(a => `${KIND_RU[a.type] || a.type}: ${a.type === 4 ? a.state : a.name}`).join(' | ');
  if (line !== lastOwnerLine) { lastOwnerLine = line; log('Ты сейчас:', line); }
}

function snapshotUser(member) {
  const u = member.user;
  const p = member.presence;
  return {
    discord_user: { id: u.id, username: u.username, global_name: u.globalName || null, avatar: u.avatar || null },
    discord_status: p ? p.status : 'offline',
    activities: (p ? p.activities : []).map(a => ({
      type: a.type,
      name: a.name,
      details: a.details || null,
      state: a.state || null,
      application_id: a.applicationId || null,
      timestamps: a.timestamps ? { start: ms(a.timestamps.start), end: ms(a.timestamps.end) } : null,
      assets: a.assets ? { large_image: a.assets.largeImage || null } : null,
      art: a.type === 0 ? (lookupArt(a.name), artCache.get(a.name) || null) : undefined,
    })),
  };
}

let guild = null;
function buildUsers() {
  const users = {};
  if (!guild) return users;
  for (const id of IDS) {
    const m = guild.members.cache.get(id);
    if (m) users[id] = snapshotUser(m);
  }
  return users;
}

async function gh(method, url, body) {
  const r = await fetch('https://api.github.com' + url, {
    method,
    headers: {
      Authorization: `Bearer ${cfg.githubToken}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'severeclaw-presence-bot',
      'Content-Type': 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

async function ensureGist(files) {
  if (cfg.gistId) return;
  const g = await gh('POST', '/gists', {
    description: 'SevereClaw: статус и гости для severeclaw.github.io',
    public: true,
    files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])),
  });
  cfg.gistId = g.id;
  saveCfg();
  log('Создал gist', g.html_url);
}
function saveCfg() {
  const out = Object.assign({}, cfg);
  fs.writeFileSync(CFG_PATH, JSON.stringify(out, null, 2));
}

// ---------- гости ----------
const VIS_PATH = path.join(__dirname, 'visitors-data.json');
let vis = { total: 0, days: {}, srcDays: {}, guests: [] };
try { vis = Object.assign(vis, JSON.parse(fs.readFileSync(VIS_PATH, 'utf8'))); } catch (e) {}
const today = () => new Date().toLocaleDateString('sv-SE');      // 2026-11-11, по времени ноутбука
let visDirty = true;
function saveVis() { fs.writeFileSync(VIS_PATH, JSON.stringify(vis)); visDirty = true; schedule(); }
function visitorsFile() {
  const d = today();
  return JSON.stringify({
    updated: Date.now(),
    stats: { total: vis.total, today: vis.days[d] || 0, bySourceToday: vis.srcDays[d] || {} },
    guests: vis.guests.slice(0, 60),
  });
}
function siteInfo() {
  return {
    discordClientId: cfg.discordClientSecret && client.application ? client.application.id : null,
    telegramBot: cfg.telegramBotToken && cfg.telegramBotName ? cfg.telegramBotName.replace(/^@/, '') : null,
  };
}

let lastUsersJson = '';
let lastSent = 0;
let timer = null;

async function publish(force = false, online = true) {
  const users = buildUsers();
  logOwner(users);
  const usersJson = JSON.stringify(users);
  if (!force && usersJson === lastUsersJson && !visDirty) return;
  const files = { [FILE]: JSON.stringify({ updated: Date.now(), bot: online, site: siteInfo(), users }) };
  if (visDirty || force) files[VFILE] = visitorsFile();
  try {
    if (!cfg.gistId) await ensureGist(files);
    else await gh('PATCH', `/gists/${cfg.gistId}`, { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) });
    lastUsersJson = usersJson;
    visDirty = false;
    lastSent = Date.now();
  } catch (e) {
    log('Не смог обновить gist:', e.message);
  }
}

function schedule() {
  if (timer) return;
  const wait = Math.max(0, lastSent + MIN_GAP - Date.now());
  timer = setTimeout(() => { timer = null; publish(); }, wait);
}

// ---------- сообщения в Discord ----------
let logChannel = null;
let sentThisMinute = 0, minuteStart = Date.now(), skipped = 0;
async function say(payload) {
  if (!logChannel) return;
  if (Date.now() - minuteStart > 60_000) {
    if (skipped) logChannel.send(`…и ещё ${skipped} заход(ов) за минуту, не стал спамить.`).catch(() => {});
    minuteStart = Date.now(); sentThisMinute = 0; skipped = 0;
  }
  if (++sentThisMinute > 15) { skipped++; return; }
  try { await logChannel.send(payload); } catch (e) { log('Не смог написать в канал:', e.message); }
}

const SRC_RU = { tg: 'из Telegram', ds: 'из Discord', yt: 'с YouTube', steam: 'из Steam', gh: 'с GitHub', search: 'из поиска', direct: 'напрямую', other: 'с другого сайта' };
const DEV_OK = ['Android', 'iOS', 'Windows', 'Mac', 'Linux', '?'];
function onVisit(m) {
  const src = SRC_RU[m.src] ? m.src : 'other';
  const dev = DEV_OK.includes(m.dev) ? m.dev : '?';
  const d = today();
  vis.total++;
  vis.days[d] = (vis.days[d] || 0) + 1;
  vis.srcDays[d] = vis.srcDays[d] || {};
  vis.srcDays[d][src] = (vis.srcDays[d][src] || 0) + 1;
  for (const k of Object.keys(vis.days)) if (k < new Date(Date.now() - 40 * 864e5).toLocaleDateString('sv-SE')) { delete vis.days[k]; delete vis.srcDays[k]; }
  saveVis();
  say(`👁 Кто-то зашёл на сайт ${SRC_RU[src]} · ${dev}${m.back ? ' · уже был раньше' : ''} · сегодня ${vis.days[d]}-й`);
  log(`Гость ${SRC_RU[src]}, ${dev}`);
}

function addGuest(g) {
  vis.guests = [g, ...vis.guests.filter(x => !(x.via === g.via && x.id === g.id))].slice(0, 100);
  saveVis();
  const via = g.via === 'discord' ? 'Discord' : 'Telegram';
  say({ embeds: [new EmbedBuilder().setColor(0x66e0ff).setTitle(`✅ ${g.name} отметился на сайте`)
    .setDescription(`через ${via}${g.handle ? ` · ${g.handle}` : ''}`).setThumbnail(g.avatar || null).setTimestamp(new Date())] });
  log(`Отметился ${g.name} (${via})`);
}

const usedCodes = new Set();
async function onDiscordLogin(code) {
  if (!cfg.discordClientSecret || typeof code !== 'string' || code.length > 100 || usedCodes.has(code)) return;
  usedCodes.add(code);
  try {
    const tr = await fetch('https://discord.com/api/v10/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: client.application.id, client_secret: cfg.discordClientSecret,
        grant_type: 'authorization_code', code, redirect_uri: cfg.siteUrl || 'https://severeclaw.github.io/' }),
    });
    const tok = await tr.json();
    if (!tok.access_token) return log('Discord-отметка не прошла:', JSON.stringify(tok).slice(0, 200));
    const u = await (await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
    if (!u.id) return;
    addGuest({ via: 'discord', id: u.id, name: u.global_name || u.username, handle: '@' + u.username,
      avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`,
      url: `https://discord.com/users/${u.id}`, time: Date.now() });
  } catch (e) { log('Discord-отметка: ошибка', e.message); }
}

const crypto = require('crypto');
function onTelegramLogin(user) {
  if (!cfg.telegramBotToken || !user || typeof user !== 'object' || !user.hash) return;
  const { hash, ...data } = user;
  const check = Object.keys(data).sort().map(k => `${k}=${data[k]}`).join('\n');
  const secret = crypto.createHash('sha256').update(cfg.telegramBotToken).digest();
  const hmac = crypto.createHmac('sha256', secret).update(check).digest('hex');
  if (hmac !== hash) return log('Telegram-отметка с неверной подписью, пропускаю');
  if (Date.now() / 1000 - Number(data.auth_date) > 86400) return log('Telegram-отметка устарела, пропускаю');
  const name = [data.first_name, data.last_name].filter(Boolean).join(' ') || data.username || 'Гость';
  addGuest({ via: 'telegram', id: String(data.id), name, handle: data.username ? '@' + data.username : '',
    avatar: data.photo_url || null, url: data.username ? `https://t.me/${data.username}` : null, time: Date.now() });
}

// ---------- приём событий с сайта через ntfy ----------
const TOPIC = cfg.ntfyTopic || 'sc-site-u1bacv0rngvi2x';
let ntfySince = cfg.ntfySince || '1h';
async function listen() {
  for (;;) {
    try {
      const r = await fetch(`https://ntfy.sh/${TOPIC}/json?since=${encodeURIComponent(ntfySince)}`);
      if (!r.ok) throw new Error('ntfy ' + r.status);
      log('Слушаю сайт (ntfy)');
      let buf = '';
      const dec = new TextDecoder();
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          if (!line.trim()) continue;
          let ev; try { ev = JSON.parse(line); } catch (e) { continue; }
          if (ev.event !== 'message') continue;
          ntfySince = ev.id;
          if (cfg.ntfySince !== ev.id) { cfg.ntfySince = ev.id; saveCfg(); }
          let m; try { m = JSON.parse(ev.message); } catch (e) { continue; }
          if (m.t === 'visit') onVisit(m);
          else if (m.t === 'login' && m.via === 'discord') onDiscordLogin(m.code);
          else if (m.t === 'login' && m.via === 'telegram') onTelegramLogin(m.user);
        }
      }
      throw new Error('соединение закрыто');
    } catch (e) {
      log('ntfy:', e.message, '— переподключаюсь через 10 с');
      await new Promise(r => setTimeout(r, 10_000));
    }
  }
}

client.once(Events.ClientReady, async () => {
  guild = client.guilds.cache.get(String(cfg.guildId));
  if (!guild) {
    console.error('Бот не на сервере с guildId из config.json. Пригласи его на сервер.');
    process.exit(1);
  }
  await guild.members.fetch({ user: IDS, withPresences: true }).catch(e => log('fetch members:', e.message));
  const missing = IDS.filter(id => !guild.members.cache.has(id));
  log(`Вошёл как ${client.user.tag}, сервер «${guild.name}». Слежу за ${IDS.length - missing.length} из ${IDS.length}.`);
  if (missing.length) log('Нет на сервере (их статус не будет виден):', missing.join(', '));
  if (cfg.logChannelId && /^\d{17,20}$/.test(String(cfg.logChannelId).trim())) {
    logChannel = await client.channels.fetch(String(cfg.logChannelId)).catch(() => null);
    if (!logChannel || !logChannel.isTextBased()) { log('Не нашёл канал logChannelId — про гостей буду писать только сюда'); logChannel = null; }
    else log(`Про гостей пишу в #${logChannel.name}`);
  }
  await client.application.fetch().catch(() => {});
  await publish(true);
  setInterval(() => publish(true), HEARTBEAT);
  listen();
});

client.on(Events.PresenceUpdate, (_old, p) => { if (p.guild && p.guild.id === guild?.id && IDS.includes(p.userId)) schedule(); });
client.on(Events.UserUpdate, (_old, u) => { if (IDS.includes(u.id)) schedule(); });
client.on(Events.GuildMemberAdd, m => { if (IDS.includes(m.id)) schedule(); });
client.on(Events.GuildMemberRemove, m => { if (IDS.includes(m.id)) schedule(); });

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  log('Выключаюсь…');
  await publish(true, false);
  client.destroy();
  process.exit(0);
}
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

client.login(cfg.discordToken).catch(e => {
  console.error('Не смог войти в Discord:', e.message);
  if (/disallowed intents/i.test(e.message))
    console.error('Включи в Developer Portal → Bot: PRESENCE INTENT и SERVER MEMBERS INTENT и нажми Save Changes.');
  else if (/invalid token|TokenInvalid|401/i.test(e.code + ' ' + e.message))
    console.error('Discord говорит, что токен неверный. Нажми Reset Token на вкладке Bot, скопируй НОВЫЙ токен целиком и вставь в config.json. Старый после сброса перестаёт работать.');
  else if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed/i.test(e.code + ' ' + e.message))
    console.error('Нет связи с Discord. Если Discord у тебя работает только через VPN, включи в NekoBox режим TUN: обычный системный прокси Node.js не использует.');
  process.exit(1);
});

// CyberSite: логика бота. Следит за статусами Discord у тебя и друзей,
// принимает гостей с сайта и выкладывает всё в публичный gist,
// откуда это читает severeclaw.github.io.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, GatewayIntentBits, Events, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

const clean = v => String(v || '').trim().replace(/^["'`]+|["'`]+$/g, '').replace(/^Bot\s+/i, '').replace(/\s+/g, '');

// Чистит настройки и возвращает текст ошибки или null.
function checkConfig(cfg) {
  cfg.discordToken = clean(cfg.discordToken);
  cfg.githubToken = clean(cfg.githubToken);
  cfg.guildId = clean(cfg.guildId);
  if (!cfg.discordToken) return 'Не указан токен бота Discord.';
  if (!cfg.githubToken) return 'Не указан токен GitHub.';
  if (!cfg.guildId) return 'Не указан ID сервера.';
  const t = cfg.discordToken;
  const hint = 'Нужен токен со вкладки Bot (Reset Token), а не Application ID, Public Key или Client Secret.';
  if (/^\d{17,20}$/.test(t)) return 'В поле токена стоит ID (только цифры). ' + hint;
  if (/^[a-f0-9]{64}$/i.test(t)) return 'В поле токена стоит Public Key. ' + hint;
  if (t.split('.').length !== 3) return 'Это не похоже на токен бота: у токена три части через точку. ' + hint;
  if (!/^\d{17,20}$/.test(cfg.guildId)) return 'ID сервера — это число из 17–20 цифр (ПКМ по серверу → Копировать ID сервера).';
  return null;
}

function createBot({ cfg, dataDir, saveCfg: persist, log, emit = () => {} }) {
  let stopped = false, hbTimer = null, ntfyAbort = null;
  const saveCfg = () => persist(cfg);

  const friendList = () => (cfg.friends || []).map(f => typeof f === 'string' ? { id: f, name: '' } : f).filter(f => f && /^\d{17,20}$/.test(String(f.id)));
  const IDS = [cfg.ownerId, ...friendList().map(f => String(f.id))].filter(Boolean);
  const hide = () => cfg.hide || {};
  const ignored = () => new Set((cfg.ignoreGames || []).map(n => String(n).trim().toLowerCase()).filter(Boolean));
  const isIgnored = a => a.type === 0 && ignored().has(String(a.name).toLowerCase());
  // Что из твоего статуса можно показывать на сайте (переключатели «не показывать»).
  function privacy(u) {
    if (!u) return u;
    const h = hide();
    if (h.all) return Object.assign({}, u, { discord_status: 'offline', activities: [] });
    return Object.assign({}, u, { activities: u.activities.filter(a => !isIgnored(a) && !(h.games && (a.type === 0 || a.type === 5)) && !(h.music && a.type === 2)) });
  }
  const FILE = 'presence.json';
  const VFILE = 'visitors.json';
  const MIN_GAP = 30_000;      // не чаще раза в 30 секунд
  const HEARTBEAT = 240_000;   // раз в 4 минуты, даже если ничего не поменялось
  // Защита лимитов GitHub: после ошибки пауза растёт (30 с, 1 мин, 2 мин… до 10 мин),
  // при «rate limit» ждём до времени сброса, которое сообщает GitHub.
  let nextAllowed = 0, errStreak = 0, rate = null;
  const hhmm = t => new Date(t).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences, GatewayIntentBits.GuildVoiceStates],
  });

  const ms = d => (d ? new Date(d).getTime() : undefined);

  // ---------- арт игры из Steam ----------
  // Discord знает только название игры, поэтому ищем её в магазине Steam
  // и берём оттуда фон страницы, баннер библиотеки и шапку.
  const artCache = new Map();          // имя игры -> арт или null (не нашли)
  const norm = s => String(s).toLowerCase().replace(/[™®©:'’!?.,\-–—]/g, ' ').replace(/\s+/g, ' ').trim();
  async function steam(url) {
    const r = await fetch(url, { headers: { 'User-Agent': 'severeclaw-presence-bot' }, signal: AbortSignal.timeout(15_000) });
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
    else line = u.discord_status + ' | ' + u.activities.map(a => `${KIND_RU[a.type] || a.type}: ${a.type === 4 ? a.state : a.name}${a.source === 'steam' ? ' (из Steam)' : ''}`).join(' | ');
    if (line !== lastOwnerLine) { lastOwnerLine = line; log('Ты сейчас:', line); emit('owner', { line, user: u || null }); }
  }

  // Плееры в режиме «текст песни строчками» кладут в статус текущую строку с ♪ —
  // это не название трека, и на сайт такие строки не попадают.
  const isLyric = t => typeof t === 'string' && /^\s*[♪♫🎵🎶]/.test(t);

  function snapshotUser(member) {
    const u = member.user;
    const p = member.presence;
    return {
      discord_user: { id: u.id, username: u.username, global_name: u.globalName || null, avatar: u.avatar || null },
      discord_status: p ? p.status : 'offline',
      activities: (p ? p.activities : []).map(a => ({
        type: a.type,
        name: a.name,
        details: isLyric(a.details) ? null : (a.details || null),
        state: isLyric(a.state) ? null : (a.state || null),
        application_id: a.applicationId || null,
        timestamps: a.timestamps ? { start: ms(a.timestamps.start), end: ms(a.timestamps.end) } : null,
        assets: a.assets ? { large_image: a.assets.largeImage || null, large_text: a.assets.largeText || null } : null,
        lyric_mode: (isLyric(a.details) || isLyric(a.state)) || undefined,
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
    // Без таймаута повисший запрос (сон ноутбука, смена VPN) навсегда блокировал очередь записей.
    const r = await fetch('https://api.github.com' + url, {
      signal: AbortSignal.timeout(20_000),
      method,
      headers: {
        Authorization: `Bearer ${cfg.githubToken}`,
        Accept: 'application/vnd.github+json',
        'User-Agent': 'severeclaw-presence-bot',
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const rem = r.headers.get('x-ratelimit-remaining');
    if (rem !== null) rate = { remaining: +rem, limit: +r.headers.get('x-ratelimit-limit'), reset: +r.headers.get('x-ratelimit-reset') * 1000 };
    if (!r.ok) {
      const text = (await r.text()).slice(0, 200);
      const err = new Error(`GitHub ${r.status}: ${text}`);
      if ((r.status === 403 || r.status === 429) && /rate limit/i.test(text)) {
        const after = +r.headers.get('retry-after');
        err.rateLimitUntil = after ? Date.now() + after * 1000 : (rate && rate.remaining === 0 && rate.reset) ? rate.reset + 5000 : Date.now() + 15 * 60_000;
      }
      throw err;
    }
    return r.status === 204 ? null : r.json();
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

  // ---------- музыка и игры ----------
  const AFILE = 'activity.json';
  const ACT_PATH = path.join(dataDir, 'activity-data.json');
  let act = { music: { day: '', tracks: [] }, games: { days: {}, art: {} }, lastTick: 0 };
  try { act = Object.assign(act, JSON.parse(fs.readFileSync(ACT_PATH, 'utf8'))); } catch (e) {}
  let actDirty = true, lastTrackKey = '', tickN = 0, lastGamesKey = '';
  const saveAct = () => { try { fs.writeFileSync(ACT_PATH, JSON.stringify(act)); } catch (e) {} };
  if (act.music && Array.isArray(act.music.tracks)) act.music.tracks = act.music.tracks.filter(t => t && t.title && !/^\s*[♪♫🎵🎶]/.test(t.title));
  function coverOf(a) {
    const img = a.assets && a.assets.large_image;
    if (!img) return null;
    if (img.startsWith('mp:')) return 'https://media.discordapp.net/' + img.slice(3);
    if (img.startsWith('spotify:')) return 'https://i.scdn.co/image/' + img.slice(8);
    return a.application_id ? `https://cdn.discordapp.com/app-assets/${a.application_id}/${img}.png` : null;
  }
  function trackMusic(u) {
    const d = new Date().toLocaleDateString('sv-SE');
    if (act.music.day !== d) { act.music = { day: d, tracks: [] }; actDirty = true; }
    const a = u && u.activities.find(x => x.type === 2 && x.details);   // без названия (строка 1 — текст песни) не записываем
    if (!a) { lastTrackKey = ''; return; }
    const key = [a.name, a.details, a.state].join('|');
    if (key === lastTrackKey) return;
    lastTrackKey = key;
    const last = act.music.tracks[0];
    if (last && last.key === key && Date.now() - last.time < 15 * 60_000) return;   // тот же трек после перезапуска
    const t = a.timestamps;
    act.music.tracks.unshift({ key, title: a.details, artist: a.state || null, app: a.name,
      cover: coverOf(a), time: Date.now(), dur: t && t.start && t.end ? t.end - t.start : null });
    act.music.tracks.length = Math.min(act.music.tracks.length, 10);
    actDirty = true; saveAct(); schedule();
  }
  function gameTick() {
    const now = Date.now();
    const delta = act.lastTick ? Math.min(now - act.lastTick, 120_000) : 0;
    act.lastTick = now;
    const m = guild && guild.members.cache.get(cfg.ownerId);
    const games = (hide().all || hide().games) ? [] : (m && m.presence ? m.presence.activities : []).filter(a => a.type === 0 && !isIgnored(a)).map(a => a.name);
    { const sa = steamActivity(); if (sa && !games.length) games.push(sa.name); }
    const d = new Date().toLocaleDateString('sv-SE');
    if (games.length && delta) {
      const day = act.games.days[d] = act.games.days[d] || {};
      for (const g of games) {
        day[g] = Math.round(((day[g] || 0) + delta / 60_000) * 10) / 10;
        const art = artCache.get(g);
        if (art && art.header) act.games.art[g] = art.header;
      }
    }
    const old = new Date(now - 14 * 864e5).toLocaleDateString('sv-SE');
    for (const k of Object.keys(act.games.days)) if (k < old) delete act.games.days[k];
    saveAct();
    const gk = games.join('|');
    if (gk !== lastGamesKey || (games.length && ++tickN % 5 === 0)) { lastGamesKey = gk; actDirty = true; schedule(); }
  }
  function activityFile() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date(Date.now() - i * 864e5).toLocaleDateString('sv-SE');
      days.push({ date: d, games: act.games.days[d] || {} });
    }
    const used = new Set(days.flatMap(x => Object.keys(x.games)));
    const art = Object.fromEntries(Object.entries(act.games.art).filter(([k]) => used.has(k)));
    return JSON.stringify({ updated: Date.now(), music: { day: act.music.day, tracks: act.music.tracks.map(({ key, ...t }) => t) }, games: { days, art }, youtube: act.youtube || null, telegram: act.telegram || null, steam: act.steam || null, commits: act.commits || null });
  }
  let gameTimer = null;

  // ---------- голосовой канал ----------
  // На сайт попадают только ты и друзья из списка; остальные — числом, без ников.
  let voiceSince = 0, voiceChan = null;
  function voiceInfo() {
    const m = guild && guild.members.cache.get(cfg.ownerId);
    const ch = m && m.voice && m.voice.channel;
    if (!ch) { voiceChan = null; voiceSince = 0; return null; }
    if (voiceChan !== ch.id) { voiceChan = ch.id; voiceSince = Date.now(); }
    if (hide().all) return null;
    const known = new Set(IDS);
    const names = Object.fromEntries(friendList().map(f => [String(f.id), f.name]));
    const all = [...ch.members.values()];
    const people = all.filter(x => known.has(x.id)).map(x => ({
      id: x.id, name: names[x.id] || x.user.globalName || x.user.username, avatar: x.user.avatar || null, me: x.id === cfg.ownerId,
      mute: !!(x.voice.selfMute || x.voice.serverMute), deaf: !!(x.voice.selfDeaf || x.voice.serverDeaf),
      stream: !!x.voice.streaming, video: !!x.voice.selfVideo,
    })).sort((a, b) => b.me - a.me);
    return { channel: ch.name, since: voiceSince, people, others: all.length - people.length };
  }

  // ---------- Telegram: последний пост публичных каналов (страница t.me/s, без ключей) ----------
  let tgTimer = null;
  const tgChannels = () => (Array.isArray(cfg.telegram) ? cfg.telegram : String(cfg.telegram || '').split(/[\s,]+/))
    .map(c => String(c).trim().replace(/^https?:\/\/t\.me\/(s\/)?/i, '').replace(/^@/, '').replace(/\/.*$/, '')).filter(c => /^\w{4,}$/.test(c));
  const unhtml = t => String(t || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n)).trim();
  async function fetchTelegram() {
    const list = tgChannels();
    if (!list.length) { if (act.telegram) { act.telegram = null; actDirty = true; schedule(); } return; }
    const out = [];
    for (const c of list) {
      try {
        const r = await fetch(`https://t.me/s/${c}`, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0', 'Accept-Language': 'ru' } });
        if (!r.ok) throw new Error('t.me ' + r.status);
        const html = await r.text();
        const title = unhtml((html.match(/<div class="tgme_channel_info_header_title"[^>]*>([\s\S]*?)<\/div>/) || [])[1]);
        const avatar = (html.match(/<i class="tgme_page_photo_image[^"]*"[^>]*><img src="([^"]+)"/) || [])[1] || null;
        const blocks = html.split('<div class="tgme_widget_message_wrap').slice(1);
        const posts = blocks.map(b => {
          const id = (b.match(/data-post="([^"]+)"/) || [])[1];
          const textHtml = (b.match(/<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>/) || [])[1];
          const photo = (b.match(/tgme_widget_message_(?:photo_wrap|video_thumb)[^>]*style="[^"]*background-image:url\('([^']+)'\)/) || [])[1] || null;
          const date = Date.parse((b.match(/<time datetime="([^"]+)"/) || [])[1]) || null;
          const views = (b.match(/<span class="tgme_widget_message_views">([^<]+)/) || [])[1] || null;
          let text = unhtml(textHtml);
          if (text.length > 420) text = text.slice(0, 400).replace(/\s+\S*$/, '') + '…';
          return { id, text, photo, date, views, url: id ? `https://t.me/${id}` : `https://t.me/${c}` };
        }).filter(p => p.id && (p.text || p.photo));
        if (posts.length) out.push({ channel: c, title: title || '@' + c, avatar, post: posts[posts.length - 1] });
      } catch (e) { log(`Telegram @${c}: не получилось —`, e.message); }
    }
    if (!out.length) return;
    out.sort((a, b) => (b.post.date || 0) - (a.post.date || 0));
    const was = JSON.stringify(act.telegram);
    act.telegram = out;
    if (JSON.stringify(out) !== was) { log(`Telegram: последний пост в @${out[0].channel}`); actDirty = true; saveAct(); schedule(); }
  }

  // ---------- Steam: во что играл за 2 недели (открытый профиль ?xml=1, без ключа) ----------
  let steamTimer = null;
  // Игра «прямо сейчас» из профиля Steam — на случай, если Discord её не показывает.
  let steamNow = null, steamNowTimer = null;
  async function fetchSteamNow() {
    const id = String(cfg.steam || '').trim().replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//i, '').replace(/\/.*$/, '');
    if (!id || id === 'off') { steamNow = null; return; }
    try {
      const path_ = /^\d{17}$/.test(id) ? `profiles/${id}` : `id/${id}`;
      const r = await fetch(`https://steamcommunity.com/${path_}/?xml=1&t=${Date.now()}`, { signal: AbortSignal.timeout(15_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('Steam ' + r.status);
      const xml = await r.text();
      const info = (xml.match(/<inGameInfo>([\s\S]*?)<\/inGameInfo>/) || [])[1];
      const name = info && ((info.match(/<gameName>(?:<!\[CDATA\[)?([\s\S]*?)(?:\]\]>)?<\/gameName>/) || [])[1] || '').trim();
      const appid = info && ((info.match(/app\/(\d+)/) || [])[1] || null);
      const was = steamNow && steamNow.name;
      if (name) {
        if (was !== name) {
          steamNow = { name, appid, since: Date.now() };
          log(`Steam: сейчас играешь в «${name}»${appid ? ' (app ' + appid + ')' : ''}`);
          schedule();
        }
      } else if (was) { steamNow = null; log('Steam: вышел из игры'); schedule(); }
    } catch (e) { if (steamNow) log('Steam (сейчас): не получилось —', e.message); }
  }
  const steamApps = new Map();        // appid -> { header, background } или null
  async function steamApp(appid) {
    if (!appid) return null;
    if (steamApps.has(appid)) return steamApps.get(appid);
    try {
      const d = await steam(`https://store.steampowered.com/api/appdetails?appids=${appid}&l=english&filters=basic`);
      const data = d[appid] && d[appid].success ? d[appid].data : null;
      const v = data ? { header: data.header_image || data.capsule_image || null, background: data.background_raw || data.background || null } : null;
      steamApps.set(appid, v);
      return v;
    } catch (e) { return null; }
  }
  function steamActivity() {
    if (!steamNow || hide().all || hide().games) return null;
    const a = { type: 0, name: steamNow.name, details: null, state: null, application_id: null, source: 'steam',
      timestamps: { start: steamNow.since }, assets: null };
    if (isIgnored(a)) return null;
    const own = artCache.get(steamNow.name);
    if (!own && !artCache.has(steamNow.name)) lookupArt(steamNow.name);
    const app = steamNow.appid ? steamApps.get(steamNow.appid) : null;
    if (steamNow.appid && !steamApps.has(steamNow.appid)) steamApp(steamNow.appid).then(v => { if (v) schedule(); });
    a.art = steamNow.appid ? {
      appid: +steamNow.appid,
      hero: `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamNow.appid}/library_hero.jpg`,
      header: (app && app.header) || (own && own.header) || `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${steamNow.appid}/header.jpg`,
      background: (app && app.background) || (own && own.background) || null,
    } : (own || null);
    return a;
  }

  async function fetchSteam() {
    const id = String(cfg.steam || '').trim().replace(/^https?:\/\/steamcommunity\.com\/(id|profiles)\//i, '').replace(/\/.*$/, '');
    if (!id || id === 'off') { if (act.steam) { act.steam = null; actDirty = true; schedule(); } return; }
    try {
      const path_ = /^\d{17}$/.test(id) ? `profiles/${id}` : `id/${id}`;
      const r = await fetch(`https://steamcommunity.com/${path_}/?xml=1&l=russian`, { signal: AbortSignal.timeout(20_000), headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!r.ok) throw new Error('Steam ' + r.status);
      const xml = await r.text();
      const tag = (src, t) => { const m = src.match(new RegExp(`<${t}>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${t}>`)); return m ? m[1].trim() : ''; };
      if (tag(xml, 'privacyState') && tag(xml, 'privacyState') !== 'public') throw new Error('профиль Steam закрыт — открой его в настройках приватности');
      const games = [...xml.matchAll(/<mostPlayedGame>([\s\S]*?)<\/mostPlayedGame>/g)].map(([, g]) => {
        const link = tag(g, 'gameLink'); const appid = (link.match(/app\/(\d+)/) || [])[1] || null;
        const num = v => {               // «1,234» — тысячи, «12,5» — дробь, «1 234,5» — тоже
          let t = String(v).replace(/[\s\u00a0]/g, '');
          if (/,\d{3}(\D|$)/.test(t) && !/,\d{1,2}$/.test(t)) t = t.replace(/,/g, ''); else t = t.replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
          return parseFloat(t.replace(/[^\d.]/g, '')) || 0;
        };
        return { name: tag(g, 'gameName'), appid, h2w: num(tag(g, 'hoursPlayed')), total: num(tag(g, 'hoursOnRecord')),
          img: null, logo: tag(g, 'gameLogo') || tag(g, 'gameIcon') || null };
      }).filter(g => g.name);
      // Настоящая ссылка на шапку из магазина; если магазин не ответил — логотип из профиля.
      for (const g of games) {
        const app = await steamApp(g.appid);
        g.img = (app && app.header) || g.logo || (g.appid ? `https://shared.akamai.steamstatic.com/store_item_assets/steam/apps/${g.appid}/header.jpg` : null);
        if (g.logo === g.img) g.logo = null;
      }
      const steam = { profile: `https://steamcommunity.com/${path_}`, name: tag(xml, 'steamID'), level: null,
        state: tag(xml, 'onlineState'), stateText: unhtml(tag(xml, 'stateMessage')), games, checked: Date.now() };
      const was = JSON.stringify(act.steam && act.steam.games);
      act.steam = steam;
      if (JSON.stringify(games) !== was) {
        log(games.length ? `Steam: за 2 недели — ${games.map(g => `${g.name} ${g.h2w} ч`).join(', ')}` : 'Steam: за 2 недели игр нет (или скрыты «Игровые данные» в приватности)');
        actDirty = true; saveAct(); schedule();
      }
    } catch (e) { log('Steam: не получилось —', e.message); }
  }

  // ---------- лента изменений: последние коммиты из публичных репозиториев ----------
  // Только публичные репозитории (список /users/…/repos приватные не отдаёт) и только первая строка сообщения.
  let commitsTimer = null, ghLogin = null;
  async function fetchCommits() {
    if (cfg.commits === false) { if (act.commits) { act.commits = null; actDirty = true; schedule(); } return; }
    try {
      if (!ghLogin) ghLogin = (await gh('GET', '/user')).login;
      const skip = new Set((cfg.commitsExclude || ['CyberSite']).map(x => String(x).toLowerCase()));
      const repos = (await gh('GET', `/users/${ghLogin}/repos?per_page=100&sort=pushed&type=owner`))
        .filter(r => !r.private && !r.fork && !skip.has(r.name.toLowerCase()))
        .filter(r => Date.now() - Date.parse(r.pushed_at) < 30 * 864e5)
        .slice(0, 8);
      const all = [];
      for (const r of repos) {
        try {
          const list = await gh('GET', `/repos/${r.full_name}/commits?per_page=5`);
          for (const c of list) {
            const msg = String(c.commit && c.commit.message || '').split('\n')[0].trim();
            if (!msg || /^Merge (branch|pull request)/i.test(msg)) continue;
            all.push({ repo: r.name, sha: c.sha.slice(0, 7), msg: msg.length > 140 ? msg.slice(0, 137) + '…' : msg,
              time: Date.parse(c.commit.committer && c.commit.committer.date || c.commit.author.date), url: c.html_url });
          }
        } catch (e) { if (e.rateLimitUntil) throw e; }
      }
      all.sort((a, b) => b.time - a.time);
      const top = all.slice(0, 10);
      const was = JSON.stringify(act.commits);
      act.commits = top;
      if (JSON.stringify(top) !== was) { log(`Лента изменений: ${top.length ? 'последний коммит в ' + top[0].repo : 'коммитов нет'}`); actDirty = true; saveAct(); schedule(); }
    } catch (e) { log('Лента изменений: не получилось —', e.message); }
  }

  // ---------- YouTube: последние ролики канала (лента RSS, без ключей) ----------
  let ytTimer = null;
  const ytHandle = () => String(cfg.youtube || '@SevereClaw').trim();
  const unxml = t => String(t || '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  async function ytGet(url) {
    const r = await fetch(url, { signal: AbortSignal.timeout(20_000),
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Safari/537.36',
        'Accept-Language': 'ru,en;q=0.8', Cookie: 'CONSENT=YES+1; SOCS=CAI' } });
    if (!r.ok) throw new Error('YouTube ответил ' + r.status);
    if (/consent\.youtube\.com|accounts\.google/.test(r.url)) throw new Error('YouTube показал страницу согласия с cookies');
    return r.text();
  }
  // Запасной путь: список роликов со страницы канала (данные ytInitialData), если лента RSS не отвечает.
  function videosFromPage(html) {
    const m = html.match(/var ytInitialData\s*=\s*(\{[\s\S]*?\});\s*<\/script>/) || html.match(/ytInitialData"\]\s*=\s*(\{[\s\S]*?\});/);
    if (!m) return [];
    let data; try { data = JSON.parse(m[1]); } catch (e) { return []; }
    const out = [], seen = new Set();
    const text = t => t ? (t.simpleText || t.content || (t.runs || []).map(r => r.text).join('')) : '';
    (function walk(o) {
      if (!o || typeof o !== 'object' || out.length >= 8) return;
      if (o.videoRenderer && o.videoRenderer.videoId) {
        const v = o.videoRenderer;
        if (!seen.has(v.videoId)) { seen.add(v.videoId); out.push({ id: v.videoId, title: text(v.title), published: null, publishedText: text(v.publishedTimeText),
          views: parseInt(text(v.viewCountText).replace(/\D/g, '')) || null, short: false }); }
        return;
      }
      if (o.lockupViewModel && o.lockupViewModel.contentId && /VIDEO/.test(o.lockupViewModel.contentType || 'VIDEO')) {
        const v = o.lockupViewModel, md = v.metadata && v.metadata.lockupMetadataViewModel;
        const rows = JSON.stringify(md && md.metadata || {});
        const parts = [...rows.matchAll(/"content":"([^"]+)"/g)].map(x => x[1]);
        if (!seen.has(v.contentId)) { seen.add(v.contentId); out.push({ id: v.contentId, title: md ? text(md.title) : '', published: null,
          publishedText: parts.find(x => /назад|ago/.test(x)) || null, views: parseInt((parts.find(x => /просмотр|view/i.test(x)) || '').replace(/\D/g, '')) || null, short: false }); }
        return;
      }
      for (const k in o) walk(o[k]);
    })(data);
    return out.filter(v => v.title).slice(0, 4);
  }
  async function fetchYouTube() {
    const h = ytHandle();
    if (!h || h === 'off') { if (act.youtube) { act.youtube = null; actDirty = true; schedule(); } return; }
    const handlePath = /^UC[\w-]{22}$/.test(h) ? 'channel/' + h : (h.startsWith('@') ? h : '@' + h);
    let videos = [], id = /^UC[\w-]{22}$/.test(h) ? h : (cfg.youtubeChannelId && cfg.youtubeHandleFor === h ? cfg.youtubeChannelId : null);
    let channelTitle = '', how = '';
    try {
      if (!id) {
        const page = await ytGet('https://www.youtube.com/' + handlePath);
        const m = page.match(/"externalId":"(UC[\w-]{22})"/) || page.match(/"channelId":"(UC[\w-]{22})"/) || page.match(/channel\/(UC[\w-]{22})/);
        if (!m) throw new Error('не нашёл ID канала на странице ' + h);
        id = m[1]; cfg.youtubeChannelId = id; cfg.youtubeHandleFor = h; saveCfg();
        log(`YouTube: канал ${h} → ${id}`);
      }
      const xml = await ytGet('https://www.youtube.com/feeds/videos.xml?channel_id=' + id);
      videos = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].slice(0, 4).map(([, e]) => ({
        id: (e.match(/<yt:videoId>([^<]+)/) || [])[1],
        title: unxml((e.match(/<title>([^<]*)/) || [])[1]),
        published: Date.parse((e.match(/<published>([^<]+)/) || [])[1]) || null,
        views: +((e.match(/<media:statistics views="(\d+)"/) || [])[1] || 0) || null,
        short: /\/shorts\//.test(e),
      })).filter(v => v.id);
      channelTitle = unxml((xml.match(/<title>([^<]*)/) || [])[1]);
      how = 'лента RSS';
    } catch (e) {
      log('YouTube: лента RSS не сработала —', e.message, '— пробую страницу канала');
    }
    if (!videos.length) {
      try {
        const page = await ytGet('https://www.youtube.com/' + handlePath + '/videos');
        videos = videosFromPage(page);
        channelTitle = channelTitle || unxml((page.match(/<meta property="og:title" content="([^"]*)"/) || [])[1]);
        how = 'страница канала';
        if (!videos.length) log('YouTube: на странице канала роликов не нашёл (нет видео или YouTube поменял страницу)');
      } catch (e) {
        log('YouTube: не получилось открыть канал —', e.message, '(без VPN в режиме TUN YouTube может не открываться)');
        return;
      }
    }
    const was = JSON.stringify(act.youtube && act.youtube.videos);
    act.youtube = { channelId: id, handle: h, title: channelTitle, videos, checked: Date.now() };
    if (JSON.stringify(videos) !== was) {
      log(`YouTube (${how}): ${videos.length ? 'последнее видео «' + videos[0].title + '»' : 'роликов нет'}`);
      actDirty = true; saveAct(); schedule();
    }
  }


  // ---------- гости ----------
  const VIS_PATH = path.join(dataDir, 'visitors-data.json');
  let vis = { total: 0, days: {}, srcDays: {}, guests: [], who: {} };
  try { vis = Object.assign(vis, JSON.parse(fs.readFileSync(VIS_PATH, 'utf8'))); } catch (e) {}
  const today = () => new Date().toLocaleDateString('sv-SE');      // 2026-11-11, по времени ноутбука
  let visDirty = true;
  function saveVis() { fs.writeFileSync(VIS_PATH, JSON.stringify(vis)); visDirty = true; schedule(); }
  // ---------- отзывы о программах ----------
  // На сайт попадают только одобренные тобой отзывы.
  const RFILE = 'reviews.json';
  const REV_PATH = path.join(dataDir, 'reviews-data.json');
  let rev = { pending: [], approved: [] };
  try { rev = Object.assign(rev, JSON.parse(fs.readFileSync(REV_PATH, 'utf8'))); } catch (e) {}
  let revDirty = true;
  const saveRev = () => { try { fs.writeFileSync(REV_PATH, JSON.stringify(rev)); } catch (e) {} revDirty = true; emit('reviews', rev); schedule(); };
  function reviewsFile() {
    return JSON.stringify({ updated: Date.now(), reviews: rev.approved.map(({ id, repo, stars, text, name, time }) => ({ id, repo, stars, text, name, time })) });
  }
  const starsTxt = n => '★'.repeat(n) + '☆'.repeat(5 - n);
  function reviewButtons(id) {
    return [new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId('rv:approve:' + id).setLabel('Опубликовать').setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId('rv:delete:' + id).setLabel('Удалить').setStyle(ButtonStyle.Danger))];
  }
  async function ownerDM() {
    const me = await client.users.fetch(String(cfg.ownerId)).catch(() => null);
    return me ? me.createDM().catch(() => null) : null;
  }
  async function onReview(m) {
    const repo = String(m.repo || '').trim();
    const stars = Math.round(+m.stars);
    const text = String(m.text || '').replace(/\s+\n/g, '\n').trim().slice(0, 600);
    const name = String(m.name || '').trim().slice(0, 40) || 'Аноним';
    const vid = String(m.vid || '').slice(0, 20);
    if (!/^[\w.-]{1,60}$/.test(repo) || !(stars >= 1 && stars <= 5) || text.length < 3) return;
    if (vid && [...rev.pending, ...rev.approved].some(r => r.vid === vid && r.repo === repo)) return log(`Отзыв на ${repo}: повтор с того же браузера, пропускаю`);
    if (rev.pending.length >= 200) return log('Отзывов на проверке слишком много (200), новые не принимаю');
    const r = { id: crypto.randomBytes(5).toString('hex'), repo, stars, text, name, vid, time: Date.now() };
    rev.pending.unshift(r);
    saveRev();
    log(`Новый отзыв на ${repo}: ${starsTxt(stars)} от «${name}»`);
    emit('visit', { text: `Отзыв на ${repo}: ${starsTxt(stars)}`, time: Date.now() });
    const dm = await ownerDM();
    if (!dm) return;
    const msg = await dm.send({
      embeds: [new EmbedBuilder().setColor(0xffd36b).setTitle(`Новый отзыв · ${repo}`).setDescription(`${starsTxt(stars)}\n\n${text}`)
        .setFooter({ text: `${name} · появится на сайте после одобрения` }).setTimestamp(new Date(r.time))],
      components: reviewButtons(r.id),
    }).catch(e => { log('Не смог прислать отзыв в личку:', e.message); return null; });
    if (msg) { r.dm = { ch: msg.channelId, msg: msg.id }; saveRev(); }
  }
  async function reviewAction(id, action) {
    const pi = rev.pending.findIndex(r => r.id === id), ai = rev.approved.findIndex(r => r.id === id);
    const r = pi >= 0 ? rev.pending[pi] : ai >= 0 ? rev.approved[ai] : null;
    if (!r) return false;
    if (action === 'approve' && pi >= 0) { rev.pending.splice(pi, 1); rev.approved.unshift(r); log(`Отзыв на ${r.repo} опубликован`); }
    else if (action === 'delete') { if (pi >= 0) rev.pending.splice(pi, 1); else rev.approved.splice(ai, 1); log(`Отзыв на ${r.repo} удалён`); }
    else return false;
    saveRev();
    if (r.dm) {                                // убрать кнопки в личке
      const ch = await client.channels.fetch(r.dm.ch).catch(() => null);
      const msg = ch && await ch.messages.fetch(r.dm.msg).catch(() => null);
      if (msg) msg.edit({ content: action === 'approve' ? '✅ Опубликован на сайте' : '🗑 Удалён', components: [] }).catch(() => {});
    }
    return true;
  }

  function visitorsFile() {
    const d = today();
    return JSON.stringify({
      updated: Date.now(),
      stats: { total: vis.total, today: vis.days[d] || 0, bySourceToday: vis.srcDays[d] || {}, who: vis.who || {} },
      guests: vis.guests.slice(0, 60),
    });
  }
  function siteInfo() {
    return {
      friends: friendList().map(f => ({ id: String(f.id), name: f.name || '' })),
      discordClientId: cfg.discordClientSecret && client.application ? client.application.id : null,
      telegramBot: cfg.telegramBotToken && cfg.telegramBotName ? cfg.telegramBotName.replace(/^@/, '') : null,
    };
  }

  let lastUsersJson = '';
  let lastSent = 0;
  let timer = null;

  // Публикации идут строго по одной: два одновременных PATCH дают у GitHub ошибку 409.
  let busy = null, busyAt = 0, again = null, conflicts = 0;
  async function publish(force = false, online = true) {
    if (Date.now() < nextAllowed && online) { schedule(); return; }
    if (busy && Date.now() - busyAt > 90_000) { log('Запись в gist зависла, начинаю заново'); busy = null; }
    if (busy) {
      again = { force: (again && again.force) || force, online };
      return busy;
    }
    busyAt = Date.now();
    busy = doPublish(force, online).finally(() => { busy = null; });
    await busy;
    if (again) { const a = again; again = null; await publish(a.force, a.online); }
  }
  async function rotateGist(files) {
    const old = cfg.gistId;
    log('Gist перестал принимать обновления, создаю новый (сайт найдёт его сам)');
    cfg.gistId = '';
    await ensureGist(files);
    if (old) await gh('DELETE', `/gists/${old}`).then(() => log('Старый gist удалён')).catch(e => log('Старый gist не удалил:', e.message));
  }
  async function doPublish(force, online) {
    const users = buildUsers();
    logOwner(users);
    if (users[cfg.ownerId]) users[cfg.ownerId] = privacy(users[cfg.ownerId]);
    {
      const sa = steamActivity(), u = users[cfg.ownerId];
      if (sa && u && !u.activities.some(a => a.type === 0 && a.name.toLowerCase() === sa.name.toLowerCase())) {
        if (!u.activities.some(a => a.type === 0)) u.activities.push(sa);
      }
    }
    trackMusic(users[cfg.ownerId]);
    emit('people', { users, friends: friendList(), hide: hide() });
    const voice = voiceInfo();
    const usersJson = JSON.stringify([users, voice]);
    if (!force && usersJson === lastUsersJson && !visDirty && !actDirty && !revDirty) return;
    const files = { [FILE]: JSON.stringify({ updated: Date.now(), bot: online, site: siteInfo(), users, voice: online ? voice : null }) };
    if (visDirty || force) files[VFILE] = visitorsFile();
    if (actDirty || force) files[AFILE] = activityFile();
    if (revDirty || force) files[RFILE] = reviewsFile();
    try {
      if (!cfg.gistId) await ensureGist(files);
      else {
        for (let attempt = 0; ; attempt++) {
          try {
            await gh('PATCH', `/gists/${cfg.gistId}`, { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) });
            conflicts = 0;
            break;
          } catch (e) {
            if (!/GitHub 409/.test(e.message)) throw e;
            if (attempt < 2) { await new Promise(r => setTimeout(r, 4000 * (attempt + 1))); continue; }
            if (++conflicts >= 3) {
              conflicts = 0;
              files[VFILE] = files[VFILE] || visitorsFile();
              files[AFILE] = files[AFILE] || activityFile();
              await rotateGist(files);
              break;
            }
            throw e;
          }
        }
      }
      lastUsersJson = usersJson;
      visDirty = false;
      actDirty = false;
      revDirty = false;
      lastSent = Date.now();
      errStreak = 0; nextAllowed = 0;
      emit('gist', { state: 'ok', text: 'обновлено ' + new Date().toLocaleTimeString('ru-RU') + (rate ? ` · запросов осталось ${rate.remaining} из ${rate.limit}` : ''), id: cfg.gistId });
      emit('visitors', JSON.parse(visitorsFile()));
    } catch (e) {
      lastSent = Date.now();
      errStreak++;
      if (e.rateLimitUntil) {
        nextAllowed = e.rateLimitUntil;
        log(`GitHub ограничил запросы, следующая попытка в ${hhmm(nextAllowed)}`);
        emit('gist', { state: 'error', text: `GitHub временно ограничил запросы. Продолжу сам в ${hhmm(nextAllowed)}, данные не потеряются.` });
      } else {
        nextAllowed = Date.now() + Math.min(30_000 * 2 ** (errStreak - 1), 600_000);
        log('Не смог обновить gist:', e.message, `— повтор в ${hhmm(nextAllowed)}`);
        emit('gist', { state: 'error', text: /401/.test(e.message) ? 'токен GitHub не подходит (нужен classic с галочкой gist)' : e.message });
      }
      schedule();
    }
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(0, lastSent + MIN_GAP - Date.now(), nextAllowed - Date.now());
    timer = setTimeout(() => { timer = null; if (!stopped) publish(); }, wait);
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
    try { await logChannel.send(payload); } catch (e) { log(/Cannot send messages to this user|50007/.test(e.message) ? 'Не могу написать тебе в личку: в Discord закрыты сообщения от участников сервера (ПКМ по серверу → Настройки конфиденциальности → Личные сообщения)' : 'Не смог написать про гостя: ' + e.message); }
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
    emit('visit', { text: `Зашли ${SRC_RU[src]} · ${dev}${m.back ? ' · уже был' : ''}`, time: Date.now() });
  }

  const WHO_RU = { friend: 'Друг', acq: 'Знакомый', stranger: 'Незнакомец' };
  const WHO_EMO = { friend: '🫂', acq: '🤝', stranger: '👤' };
  const answered = new Set();
  function onWho(m) {
    if (!WHO_RU[m.a]) return;
    const key = String(m.vid || '').slice(0, 20);
    if (key && answered.has(key)) return;            // один ответ с одного браузера за запуск
    if (key) answered.add(key);
    vis.who = vis.who || {};
    vis.who[m.a] = (vis.who[m.a] || 0) + 1;
    saveVis();
    const src = SRC_RU[m.src] ? SRC_RU[m.src] : '';
    const dev = DEV_OK.includes(m.dev) ? m.dev : '';
    say(`${WHO_EMO[m.a]} Новый гость${src ? ' ' + src : ''}${dev ? ' · ' + dev : ''} ответил, кто он тебе: **${WHO_RU[m.a]}**`);
    log(`Опрос: ${WHO_RU[m.a]}`);
    emit('visit', { text: `Ответил на опрос: ${WHO_RU[m.a]}`, time: Date.now() });
  }

  function addGuest(g) {
    vis.guests = [g, ...vis.guests.filter(x => !(x.via === g.via && x.id === g.id))].slice(0, 100);
    saveVis();
    const via = g.via === 'discord' ? 'Discord' : 'Telegram';
    say({ embeds: [new EmbedBuilder().setColor(0x66e0ff).setTitle(`✅ ${g.name} отметился на сайте`)
      .setDescription(`через ${via}${g.handle ? ` · ${g.handle}` : ''}`).setThumbnail(g.avatar || null).setTimestamp(new Date())] });
    log(`Отметился ${g.name} (${via})`);
    emit('visit', { text: `${g.name} отметился через ${via}`, avatar: g.avatar, time: Date.now() });
  }

  const usedCodes = new Set();
  async function onDiscordLogin(code) {
    if (!cfg.discordClientSecret || typeof code !== 'string' || code.length > 100 || usedCodes.has(code)) return;
    usedCodes.add(code);
    try {
      const tr = await fetch('https://discord.com/api/v10/oauth2/token', {
        signal: AbortSignal.timeout(15_000),
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: client.application.id, client_secret: cfg.discordClientSecret,
          grant_type: 'authorization_code', code, redirect_uri: cfg.siteUrl || 'https://severeclaw.github.io/' }),
      });
      const tok = await tr.json();
      if (!tok.access_token) return log('Discord-отметка не прошла:', JSON.stringify(tok).slice(0, 200));
      const u = await (await fetch('https://discord.com/api/v10/users/@me', { signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${tok.access_token}` } })).json();
      if (!u.id) return;
      addGuest({ via: 'discord', id: u.id, name: u.global_name || u.username, handle: '@' + u.username,
        avatar: u.avatar ? `https://cdn.discordapp.com/avatars/${u.id}/${u.avatar}.png?size=128` : `https://cdn.discordapp.com/embed/avatars/${Number((BigInt(u.id) >> 22n) % 6n)}.png`,
        url: `https://discord.com/users/${u.id}`, time: Date.now() });
    } catch (e) { log('Discord-отметка: ошибка', e.message); }
  }

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
    while (!stopped) {
      try {
        ntfyAbort = new AbortController();
        const ab = ntfyAbort;
        let idle = setTimeout(() => ab.abort(), 120_000);
        const r = await fetch(`https://ntfy.sh/${TOPIC}/json?since=${encodeURIComponent(ntfySince)}`, { signal: ntfyAbort.signal });
        if (!r.ok) throw new Error('ntfy ' + r.status);
        log('Слушаю сайт (ntfy)');
        emit('ntfy', { state: 'ok', text: 'сайт подключён' });
        let buf = '';
        const dec = new TextDecoder();
        for await (const chunk of r.body) {
          clearTimeout(idle); idle = setTimeout(() => ab.abort(), 120_000);
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
            else if (m.t === 'who') onWho(m);
            else if (m.t === 'review') onReview(m);
            else if (m.t === 'login' && m.via === 'discord') onDiscordLogin(m.code);
            else if (m.t === 'login' && m.via === 'telegram') onTelegramLogin(m.user);
          }
        }
        throw new Error('соединение закрыто');
      } catch (e) {
        if (stopped) return;
        log('ntfy:', e.message, '— переподключаюсь через 10 с');
        emit('ntfy', { state: 'error', text: 'нет связи с ntfy.sh: ' + e.message });
        await new Promise(r => setTimeout(r, 10_000));
      }
    }
  }

  client.once(Events.ClientReady, async () => {
    guild = client.guilds.cache.get(String(cfg.guildId))
      || await client.guilds.fetch(String(cfg.guildId)).catch(() => null);
    if (!guild) {
      const list = [...client.guilds.cache.values()];
      log(`Сервера ${cfg.guildId} среди серверов бота нет. Бот состоит на: ${list.map(g => `${g.name} (${g.id})`).join(', ') || 'ни одном'}`);
      if (list.length === 1) {
        guild = list[0];
        log(`Беру единственный сервер бота: «${guild.name}», ID исправлен в настройках`);
        cfg.guildId = guild.id;
        saveCfg();
      } else {
        const text = list.length
          ? `В настройках стоит ID ${cfg.guildId}, а бот состоит на: ${list.map(g => `«${g.name}» — ${g.id}`).join('; ')}. Вставь нужный ID в настройки.`
          : 'Бот не состоит ни на одном сервере. Пригласи его: Developer Portal → OAuth2 → URL Generator → галочка bot → открой ссылку.';
        emit('discord', { state: 'error', text });
        return;
      }
    }
    await guild.members.fetch({ user: IDS, withPresences: true }).catch(e => log('fetch members:', e.message));
    const missing = IDS.filter(id => !guild.members.cache.has(id));
    log(`Вошёл как ${client.user.tag}, сервер «${guild.name}». Слежу за ${IDS.length - missing.length} из ${IDS.length}.`);
    emit('discord', { state: 'ok', text: `${client.user.tag} · ${guild.name}`, tracked: IDS.length - missing.length, total: IDS.length, missing });
    if (missing.length) log('Нет на сервере (их статус не будет виден):', missing.join(', '));
    // Куда писать про гостей: в личку (по умолчанию), в канал или никуда.
    const where = cfg.notify || 'dm';
    if (where === 'dm') {
      const me = await client.users.fetch(String(cfg.ownerId)).catch(() => null);
      logChannel = me ? await me.createDM().catch(() => null) : null;
      if (logChannel) log(`Про гостей пишу тебе в личку (${me.username})`);
      else log('Не смог открыть личку с тобой — про гостей пишу только сюда');
    } else if (where === 'channel' && /^\d{17,20}$/.test(String(cfg.logChannelId || '').trim())) {
      logChannel = await client.channels.fetch(String(cfg.logChannelId)).catch(() => null);
      if (!logChannel || !logChannel.isTextBased()) { log('Не нашёл канал для гостей — пишу только сюда'); logChannel = null; }
      else log(`Про гостей пишу в #${logChannel.name}`);
    } else log('Про гостей в Discord не пишу (выключено в настройках)');
    await client.application.fetch().catch(() => {});
    await publish(true);
    hbTimer = setInterval(() => publish(true), HEARTBEAT);
    emit('reviews', rev);
    gameTimer = setInterval(gameTick, 60_000); gameTick();
    ytTimer = setInterval(fetchYouTube, 30 * 60_000); setTimeout(fetchYouTube, 8_000);
    tgTimer = setInterval(fetchTelegram, 20 * 60_000); setTimeout(fetchTelegram, 12_000);
    steamTimer = setInterval(fetchSteam, 30 * 60_000); setTimeout(fetchSteam, 16_000);
    steamNowTimer = setInterval(fetchSteamNow, 90_000); setTimeout(fetchSteamNow, 6_000);
    commitsTimer = setInterval(fetchCommits, 20 * 60_000); setTimeout(fetchCommits, 20_000);
    listen();
  });

  client.on(Events.InteractionCreate, async i => {
    if (!i.isButton() || !i.customId.startsWith('rv:')) return;
    if (i.user.id !== String(cfg.ownerId)) return i.reply({ content: 'Это может сделать только владелец сайта.', ephemeral: true }).catch(() => {});
    const [, action, id] = i.customId.split(':');
    const ok = await reviewAction(id, action);
    await i.update({ content: !ok ? 'Этого отзыва уже нет.' : action === 'approve' ? '✅ Опубликован на сайте' : '🗑 Удалён', components: [] }).catch(() => {});
  });
  client.on(Events.VoiceStateUpdate, (o, n) => {
    if (!guild || (n.guild && n.guild.id !== guild.id)) return;
    const mine = voiceChan;
    if (n.id === cfg.ownerId || o.channelId === mine || n.channelId === mine) schedule();
  });
  client.on(Events.PresenceUpdate, (_old, p) => { if (p.guild && p.guild.id === guild?.id && IDS.includes(p.userId)) schedule(); });
  client.on(Events.UserUpdate, (_old, u) => { if (IDS.includes(u.id)) schedule(); });
  client.on(Events.GuildMemberAdd, m => { if (IDS.includes(m.id)) schedule(); });
  client.on(Events.GuildMemberRemove, m => { if (IDS.includes(m.id)) schedule(); });


  async function start() {
    emit('discord', { state: 'connecting', text: 'подключаюсь…' });
    try {
      await client.login(cfg.discordToken);
    } catch (e) {
      const m = (e.code || '') + ' ' + e.message;
      let text = e.message;
      if (/disallowed intents/i.test(m)) text = 'Включи в Developer Portal → Bot: PRESENCE INTENT и SERVER MEMBERS INTENT и сохрани.';
      else if (/invalid token|TokenInvalid|401/i.test(m)) text = 'Discord говорит, что токен неверный. Нажми Reset Token на вкладке Bot и вставь новый.';
      else if (/ENOTFOUND|ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|connect/i.test(m)) text = 'Нет связи с Discord. Включи VPN в режиме TUN.';
      log('Не смог войти в Discord:', e.message);
      emit('discord', { state: 'error', text });
      throw new Error(text);
    }
  }

  async function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(hbTimer);
    clearInterval(gameTimer);
    clearInterval(ytTimer);
    clearInterval(tgTimer);
    clearInterval(steamTimer);
    clearInterval(steamNowTimer);
    clearInterval(commitsTimer);
    try { gameTick(); } catch (e) {}
    clearTimeout(timer);
    if (ntfyAbort) ntfyAbort.abort();
    try { if (guild) await publish(true, false); } catch (e) {}
    client.destroy();
    emit('discord', { state: 'off', text: 'остановлен' });
  }

  // Поменялись «не показывать» или имена друзей — сразу выложить.
  function refresh() { lastUsersJson = ''; actDirty = true; if (guild) publish(true); }

  return { start, stop, refresh, reviewAction, reviews: () => rev };
}

module.exports = { createBot, checkConfig };

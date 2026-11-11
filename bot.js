// CyberSite: логика бота. Следит за статусами Discord у тебя и друзей,
// принимает гостей с сайта и выкладывает всё в публичный gist,
// откуда это читает severeclaw.github.io.

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { Client, GatewayIntentBits, Events, EmbedBuilder } = require('discord.js');

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
  // Что из твоего статуса можно показывать на сайте (переключатели «не показывать»).
  function privacy(u) {
    if (!u) return u;
    const h = hide();
    if (h.all) return Object.assign({}, u, { discord_status: 'offline', activities: [] });
    if (!h.games && !h.music) return u;
    return Object.assign({}, u, { activities: u.activities.filter(a => !(h.games && (a.type === 0 || a.type === 5)) && !(h.music && a.type === 2)) });
  }
  const FILE = 'presence.json';
  const VFILE = 'visitors.json';
  const MIN_GAP = 15_000;      // не чаще раза в 15 секунд
  const HEARTBEAT = 120_000;   // раз в 2 минуты, даже если ничего не поменялось

  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers, GatewayIntentBits.GuildPresences],
  });

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
    if (line !== lastOwnerLine) { lastOwnerLine = line; log('Ты сейчас:', line); emit('owner', { line, user: u || null }); }
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

  // ---------- музыка и игры ----------
  const AFILE = 'activity.json';
  const ACT_PATH = path.join(dataDir, 'activity-data.json');
  let act = { music: { day: '', tracks: [] }, games: { days: {}, art: {} }, lastTick: 0 };
  try { act = Object.assign(act, JSON.parse(fs.readFileSync(ACT_PATH, 'utf8'))); } catch (e) {}
  let actDirty = true, lastTrackKey = '', tickN = 0, lastGamesKey = '';
  const saveAct = () => { try { fs.writeFileSync(ACT_PATH, JSON.stringify(act)); } catch (e) {} };
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
    const a = u && u.activities.find(x => x.type === 2 && (x.details || x.state));
    if (!a) { lastTrackKey = ''; return; }
    const key = [a.name, a.details, a.state].join('|');
    if (key === lastTrackKey) return;
    lastTrackKey = key;
    const last = act.music.tracks[0];
    if (last && last.key === key && Date.now() - last.time < 15 * 60_000) return;   // тот же трек после перезапуска
    const t = a.timestamps;
    act.music.tracks.unshift({ key, title: a.details || a.state, artist: a.details ? a.state : null, app: a.name,
      cover: coverOf(a), time: Date.now(), dur: t && t.start && t.end ? t.end - t.start : null });
    act.music.tracks.length = Math.min(act.music.tracks.length, 10);
    actDirty = true; saveAct(); schedule();
  }
  function gameTick() {
    const now = Date.now();
    const delta = act.lastTick ? Math.min(now - act.lastTick, 120_000) : 0;
    act.lastTick = now;
    const m = guild && guild.members.cache.get(cfg.ownerId);
    const games = (hide().all || hide().games) ? [] : (m && m.presence ? m.presence.activities : []).filter(a => a.type === 0).map(a => a.name);
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
    return JSON.stringify({ updated: Date.now(), music: { day: act.music.day, tracks: act.music.tracks.map(({ key, ...t }) => t) }, games: { days, art } });
  }
  let gameTimer = null;

  // ---------- гости ----------
  const VIS_PATH = path.join(dataDir, 'visitors-data.json');
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
      friends: friendList().map(f => ({ id: String(f.id), name: f.name || '' })),
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
    if (users[cfg.ownerId]) users[cfg.ownerId] = privacy(users[cfg.ownerId]);
    trackMusic(users[cfg.ownerId]);
    emit('people', { users, friends: friendList(), hide: hide() });
    const usersJson = JSON.stringify(users);
    if (!force && usersJson === lastUsersJson && !visDirty && !actDirty) return;
    const files = { [FILE]: JSON.stringify({ updated: Date.now(), bot: online, site: siteInfo(), users }) };
    if (visDirty || force) files[VFILE] = visitorsFile();
    if (actDirty || force) files[AFILE] = activityFile();
    try {
      if (!cfg.gistId) await ensureGist(files);
      else await gh('PATCH', `/gists/${cfg.gistId}`, { files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, { content: v }])) });
      lastUsersJson = usersJson;
      visDirty = false;
      actDirty = false;
      lastSent = Date.now();
      emit('gist', { state: 'ok', text: 'обновлено ' + new Date().toLocaleTimeString('ru-RU'), id: cfg.gistId });
      emit('visitors', JSON.parse(visitorsFile()));
    } catch (e) {
      log('Не смог обновить gist:', e.message);
      emit('gist', { state: 'error', text: /401/.test(e.message) ? 'токен GitHub не подходит (нужен classic с галочкой gist)' : e.message });
    }
  }

  function schedule() {
    if (timer) return;
    const wait = Math.max(0, lastSent + MIN_GAP - Date.now());
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
    emit('visit', { text: `Зашли ${SRC_RU[src]} · ${dev}${m.back ? ' · уже был' : ''}`, time: Date.now() });
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
        const r = await fetch(`https://ntfy.sh/${TOPIC}/json?since=${encodeURIComponent(ntfySince)}`, { signal: ntfyAbort.signal });
        if (!r.ok) throw new Error('ntfy ' + r.status);
        log('Слушаю сайт (ntfy)');
        emit('ntfy', { state: 'ok', text: 'сайт подключён' });
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
    if (cfg.logChannelId && /^\d{17,20}$/.test(String(cfg.logChannelId).trim())) {
      logChannel = await client.channels.fetch(String(cfg.logChannelId)).catch(() => null);
      if (!logChannel || !logChannel.isTextBased()) { log('Не нашёл канал logChannelId — про гостей буду писать только сюда'); logChannel = null; }
      else log(`Про гостей пишу в #${logChannel.name}`);
    }
    await client.application.fetch().catch(() => {});
    await publish(true);
    hbTimer = setInterval(() => publish(true), HEARTBEAT);
    gameTimer = setInterval(gameTick, 60_000); gameTick();
    listen();
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
    try { gameTick(); } catch (e) {}
    clearTimeout(timer);
    if (ntfyAbort) ntfyAbort.abort();
    try { if (guild) await publish(true, false); } catch (e) {}
    client.destroy();
    emit('discord', { state: 'off', text: 'остановлен' });
  }

  // Поменялись «не показывать» или имена друзей — сразу выложить.
  function refresh() { lastUsersJson = ''; actDirty = true; if (guild) publish(true); }

  return { start, stop, refresh };
}

module.exports = { createBot, checkConfig };

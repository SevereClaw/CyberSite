// CyberSite — окно, трей, настройки и автообновления вокруг бота из bot.js.
const { app, BrowserWindow, Tray, Menu, ipcMain, dialog, shell, nativeImage, Notification } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { createBot, checkConfig } = require('./bot');

let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch (e) {}

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('io.github.severeclaw.cybersite');

const DATA = app.getPath('userData');            // %APPDATA%\CyberSite — переживает обновления
const CFG_PATH = path.join(DATA, 'config.json');
const DEFAULTS = {
  discordToken: '', githubToken: '', guildId: '', logChannelId: '',
  discordClientSecret: '', telegramBotToken: '', telegramBotName: '',
  ownerId: '326495406970109962',
  friends: ['952898114321281084', '552120303153578015', '813521412165861397', '839747625887465482', '985113810266386432', '983770743198347294'],
  gameArt: {}, ntfyTopic: 'sc-site-u1bacv0rngvi2x', siteUrl: 'https://severeclaw.github.io/', gistId: '',
  autostart: true, startHidden: true,
};
const startedHidden = process.argv.includes('--hidden');

// ---------- настройки ----------
const readJson = f => JSON.parse(fs.readFileSync(f, 'utf8').replace(/^﻿/, ''));
const looksLikeConfig = o => o && typeof o === 'object' && ('discordToken' in o || 'githubToken' in o || 'guildId' in o);
let cfg = null;
function loadCfg() {
  try { cfg = Object.assign({}, DEFAULTS, readJson(CFG_PATH)); } catch (e) { cfg = null; }
  return cfg;
}
function saveCfg(c) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(CFG_PATH, JSON.stringify(c, null, 2));
  cfg = c;
}

// Перенос настроек из старой версии: берём config.json (и visitors-data.json рядом с ним).
function importFrom(file) {
  const o = readJson(file);
  if (!looksLikeConfig(o)) throw new Error('Это не похоже на config.json бота.');
  const merged = Object.assign({}, DEFAULTS, cfg || {}, o);
  if (o.autostart === undefined && cfg) merged.autostart = cfg.autostart;
  saveCfg(merged);
  const vis = path.join(path.dirname(file), 'visitors-data.json');
  const myVis = path.join(DATA, 'visitors-data.json');
  if (fs.existsSync(vis) && !fs.existsSync(myVis)) fs.copyFileSync(vis, myVis);
  log('Настройки перенесены из', file);
  return merged;
}
function findOldConfig() {
  const home = os.homedir();
  const roots = [path.dirname(process.execPath), path.join(home, 'Downloads'), path.join(home, 'Desktop'),
    path.join(home, 'Documents'), path.join(home, 'OneDrive', 'Desktop'), path.join(home, 'OneDrive', 'Рабочий стол'), home];
  const subs = ['', 'bot', 'CyberSite', 'presence-bot', 'cybersite'];
  const seen = new Set(), found = [];
  const tryDir = d => {
    for (const s of subs) {
      const f = path.join(d, s, 'config.json');
      if (seen.has(f)) continue; seen.add(f);
      try { if (looksLikeConfig(readJson(f))) found.push({ f, t: fs.statSync(f).mtimeMs }); } catch (e) {}
    }
  };
  for (const r of roots) {
    tryDir(r);
    let list = [];
    try { list = fs.readdirSync(r, { withFileTypes: true }).filter(e => e.isDirectory()).slice(0, 300); } catch (e) {}
    for (const e of list) tryDir(path.join(r, e.name));
  }
  found.sort((a, b) => b.t - a.t);
  return found.length ? found[0].f : null;
}

// ---------- журнал и состояние ----------
const logs = [];
function log(...a) {
  const line = new Date().toLocaleTimeString('ru-RU') + '  ' + a.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
  logs.push(line); if (logs.length > 800) logs.shift();
  send('log', line);
}
const state = { discord: { state: 'off', text: 'не запущен' }, gist: { state: 'off', text: '—' }, ntfy: { state: 'off', text: '—' },
  owner: null, visitors: null, visits: [], update: null, imported: null };
function emit(kind, v) {
  if (kind === 'visit') { state.visits.unshift(v); state.visits.length = Math.min(state.visits.length, 50); }
  else state[kind] = v;
  send('state', state);
  if (kind === 'discord') updateTray();
}
function send(ch, v) { if (win && !win.isDestroyed()) win.webContents.send(ch, v); }

// ---------- бот ----------
let bot = null;
async function startBot() {
  if (bot) { const b = bot; bot = null; await b.stop().catch(() => {}); }
  state.gist = { state: 'off', text: '—' }; state.ntfy = { state: 'off', text: '—' };
  if (!cfg) { emit('discord', { state: 'setup', text: 'нужно настроить' }); return; }
  const err = checkConfig(cfg);
  if (err) { emit('discord', { state: 'setup', text: err }); return; }
  bot = createBot({ cfg, dataDir: DATA, saveCfg, log, emit });
  bot.start().catch(() => {});
}

// ---------- окно и трей ----------
let win = null, tray = null, quitting = false;
function createWindow(show) {
  win = new BrowserWindow({
    width: 1000, height: 700, minWidth: 820, minHeight: 560, show: false, frame: false,
    backgroundColor: '#05070d', title: 'CyberSite', icon: path.join(__dirname, 'build', 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  win.removeMenu();
  win.loadFile(path.join(__dirname, 'ui', 'index.html'));
  win.once('ready-to-show', () => { if (show) win.show(); });
  win.on('close', e => {
    if (quitting) return;
    e.preventDefault(); win.hide();
    if (!state.trayHinted && Notification.isSupported()) {
      state.trayHinted = true;
      new Notification({ title: 'CyberSite работает в фоне', body: 'Значок в трее: открыть окно или выйти.' }).show();
    }
  });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https?:/.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file:')) { e.preventDefault(); if (/^https?:/.test(url)) shell.openExternal(url); } });
}
function showWin() { if (!win) createWindow(true); else { win.show(); win.focus(); } }
function updateTray() {
  if (!tray) return;
  const d = state.discord.state;
  tray.setToolTip('CyberSite — ' + ({ ok: 'работает', connecting: 'подключается', error: 'ошибка', setup: 'нужно настроить', off: 'выключен' }[d] || d));
}
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(__dirname, 'build', 'tray.png')));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Открыть CyberSite', click: showWin },
    { label: 'Открыть сайт', click: () => shell.openExternal(cfg?.siteUrl || DEFAULTS.siteUrl) },
    { label: 'Перезапустить бота', click: () => startBot() },
    { type: 'separator' },
    { label: 'Выход', click: () => quit() },
  ]));
  tray.on('click', showWin);
  updateTray();
}
async function quit() {
  quitting = true;
  if (bot) await Promise.race([bot.stop(), new Promise(r => setTimeout(r, 4000))]).catch(() => {});
  app.exit(0);
}
function applyAutostart() {
  if (!app.isPackaged || !cfg) return;
  app.setLoginItemSettings({ openAtLogin: !!cfg.autostart, args: cfg.startHidden ? ['--hidden'] : [] });
}

// ---------- обновления ----------
function setupUpdater() {
  if (!autoUpdater || !app.isPackaged) return;
  autoUpdater.logger = { info: m => log('Обновление:', String(m)), warn: () => {}, error: m => log('Обновление: ошибка', String(m)), debug: () => {} };
  autoUpdater.on('update-available', i => emit('update', { state: 'downloading', version: i.version }));
  autoUpdater.on('download-progress', p => emit('update', { state: 'downloading', version: state.update?.version, percent: Math.round(p.percent) }));
  autoUpdater.on('update-downloaded', i => {
    emit('update', { state: 'ready', version: i.version });
    if (Notification.isSupported()) new Notification({ title: 'CyberSite ' + i.version + ' готов', body: 'Обновится при следующем запуске или по кнопке в окне.' }).show();
  });
  const check = () => autoUpdater.checkForUpdates().catch(e => log('Обновление: не смог проверить', e.message));
  check(); setInterval(check, 6 * 3600 * 1000);
}

// ---------- IPC ----------
ipcMain.handle('get', () => ({ cfg, state, logs, version: app.getVersion(), dataDir: DATA, defaults: DEFAULTS }));
ipcMain.handle('save', async (_e, c) => {
  const merged = Object.assign({}, DEFAULTS, cfg || {}, c);
  const err = checkConfig(merged);
  saveCfg(merged); applyAutostart();
  log('Настройки сохранены');
  await startBot();
  return { ok: true, warn: err, cfg: merged };
});
ipcMain.handle('import', async (_e, file) => {
  if (!file) {
    const r = await dialog.showOpenDialog(win, { title: 'Где лежит старый config.json?', filters: [{ name: 'config.json', extensions: ['json'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return { ok: false };
    file = r.filePaths[0];
  }
  try { const c = importFrom(file); applyAutostart(); await startBot(); return { ok: true, cfg: c, file }; }
  catch (e) { return { ok: false, error: e.message }; }
});
ipcMain.handle('export', async () => {
  const r = await dialog.showSaveDialog(win, { title: 'Сохранить настройки', defaultPath: 'config.json', filters: [{ name: 'JSON', extensions: ['json'] }] });
  if (r.canceled || !r.filePath) return { ok: false };
  fs.writeFileSync(r.filePath, JSON.stringify(cfg || DEFAULTS, null, 2));
  return { ok: true, file: r.filePath };
});
ipcMain.handle('restart', () => startBot());
ipcMain.handle('open', (_e, url) => { if (/^https?:/.test(url)) shell.openExternal(url); });
ipcMain.handle('openData', () => shell.openPath(DATA));
ipcMain.handle('win', (_e, a) => { if (!win) return; if (a === 'min') win.minimize(); else if (a === 'max') win.isMaximized() ? win.unmaximize() : win.maximize(); else if (a === 'close') win.close(); else if (a === 'quit') quit(); });
ipcMain.handle('installUpdate', () => { if (autoUpdater && state.update?.state === 'ready') { quitting = true; bot?.stop().finally(() => autoUpdater.quitAndInstall()); } });

// ---------- запуск ----------
app.on('second-instance', showWin);
app.on('window-all-closed', e => e?.preventDefault?.());
app.whenReady().then(async () => {
  loadCfg();
  if (!cfg) {
    const old = findOldConfig();
    if (old) { try { importFrom(old); state.imported = old; } catch (e) { log('Не смог перенести', old, e.message); } }
  }
  applyAutostart();
  createTray();
  createWindow(!(startedHidden && cfg && cfg.startHidden));
  log('CyberSite', app.getVersion(), '· настройки:', CFG_PATH);
  await startBot();
  setupUpdater();
});

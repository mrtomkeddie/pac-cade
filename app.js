const state = {
  currentRoom: null,
  currentView: 'room',
  selectedGame: null,
  theme: null,
  games: { arcade: [], console: [] },
};

const DEFAULT_GAMES = {
  arcade: [
    { name: 'Pac-Man', core: 'mame2003', rom: 'pacman.zip', aspect: '3/4' },
    { name: 'Donkey Kong', core: 'mame2003', rom: 'dkong.zip', aspect: '3/4' },
    { name: 'Donkey Kong Jr.', core: 'mame2003', rom: 'dkongjr.zip', aspect: '3/4' },
    { name: 'Mario Bros.', core: 'mame2003', rom: 'mario.zip', aspect: '4/3' },
    { name: 'Space Invaders', core: 'mame2003', rom: 'invaders.zip', aspect: '1/1' },
    { name: 'Super Street Fighter II Turbo', core: 'mame32', rom: 'ssf2t.zip', aspect: '4/3' },
    { name: 'The Simpsons', core: 'mame32', rom: 'simpsons2p.zip', aspect: '4/3' },
  ],
  console: [
    { name: 'Super Mario Bros.', core: 'nes', rom: 'Super Mario Bros.nes' },
    { name: 'Super Mario Bros. Deluxe', core: 'gbc', rom: 'Super Mario Bros. Deluxe.gbc', aspect: '10/9' },
    { name: 'Mario Kart 64', core: 'n64', rom: 'Mario Kart 64.z64', aspect: '4/3' },
    { name: 'Banjo-Kazooie', core: 'n64', rom: 'Banjo-Kazooie.z64', aspect: '4/3' },
    { name: 'Super Mario World', core: 'snes', rom: 'Super Mario World.sfc', aspect: '4/3' },
    { name: 'Super Mario Kart', core: 'snes', rom: 'Super Mario Kart.sfc', aspect: '4/3' },
  ],
};

const qs = sel => document.querySelector(sel);
const qsa = sel => Array.from(document.querySelectorAll(sel));

// Account system
const Account = (() => {
  const DB_NAME = 'arcade_accounts_v1';
  const DB_VERSION = 4;
  let db, current;

  function openDB() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const d = req.result;
        if (!d.objectStoreNames.contains('accounts')) d.createObjectStore('accounts', { keyPath: 'code' });
        if (!d.objectStoreNames.contains('saves')) d.createObjectStore('saves', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('controllers')) d.createObjectStore('controllers', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('favorites')) d.createObjectStore('favorites', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('friends')) d.createObjectStore('friends', { keyPath: 'code' });
        if (!d.objectStoreNames.contains('messages')) d.createObjectStore('messages', { keyPath: 'id', autoIncrement: true });
        if (!d.objectStoreNames.contains('profiles')) d.createObjectStore('profiles', { keyPath: 'code' });
        if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta', { keyPath: 'key' });
        if (!d.objectStoreNames.contains('controllers_game')) d.createObjectStore('controllers_game', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('core_options')) d.createObjectStore('core_options', { keyPath: 'id' });
        if (!d.objectStoreNames.contains('core_options_site')) d.createObjectStore('core_options_site', { keyPath: 'game' });
      };
      req.onsuccess = () => { db = req.result; resolve(db); };
      req.onerror = () => reject(req.error);
    });
  }

  async function ensureDB() { if (!db) await openDB(); }
  function tx(store, mode = 'readonly') { return db.transaction(store, mode).objectStore(store); }
  function put(store, value) { return new Promise((res, rej) => { const r = tx(store, 'readwrite').put(value); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); }); }
  function get(store, key) { return new Promise((res, rej) => { const r = tx(store).get(key); r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }
  function del(store, key) { return new Promise((res, rej) => { const r = tx(store, 'readwrite').delete(key); r.onsuccess = () => res(true); r.onerror = () => rej(r.error); }); }
  function all(store) { return new Promise((res, rej) => { const req = tx(store).getAll(); req.onsuccess = () => res(req.result || []); req.onerror = () => rej(req.error); }); }

  function rndCode() {
    const alphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
    const arr = new Uint8Array(8);
    crypto.getRandomValues(arr);
    let s = '';
    for (let i = 0; i < 8; i++) s += alphabet[arr[i] % alphabet.length];
    return s.slice(0, 4) + '-' + s.slice(4);
  }

  async function createAccount() {
    await ensureDB();
    const code = rndCode();
    const accountKey = crypto.getRandomValues(new Uint8Array(32));
    await put('accounts', { code, createdAt: Date.now(), accountKey: Array.from(accountKey) });
    current = { code, accountKey };
    return code;
  }

  const RATE_LIMIT_MAX = 5, RATE_LIMIT_WINDOW_MS = 60_000;
  function canAttemptLogin() {
    const now = Date.now();
    const raw = JSON.parse(localStorage.getItem('loginAttempts') || '[]').filter(x => now - x < RATE_LIMIT_WINDOW_MS);
    if (raw.length >= RATE_LIMIT_MAX) return false;
    raw.push(now);
    localStorage.setItem('loginAttempts', JSON.stringify(raw));
    return true;
  }

  async function login(code) {
    if (!canAttemptLogin()) throw new Error('Too many attempts, please wait');
    await ensureDB();
    const rec = await get('accounts', code);
    if (!rec) throw new Error('Account not found');
    current = { code, accountKey: new Uint8Array(rec.accountKey) };
    Session.start();
    return true;
  }
  function logout() { current = null; Session.stop(); }

  // Encryption helpers (AES-GCM)
  async function encrypt(data) {
    const key = await crypto.subtle.importKey('raw', current.accountKey, 'AES-GCM', false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, data);
    return { iv: Array.from(iv), buf: Array.from(new Uint8Array(enc)) };
  }
  async function decrypt(payload) {
    const key = await crypto.subtle.importKey('raw', current.accountKey, 'AES-GCM', false, ['decrypt']);
    const iv = new Uint8Array(payload.iv);
    const buf = new Uint8Array(payload.buf);
    const dec = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, buf);
    return new Uint8Array(dec);
  }

  // Saves API
  async function saveState(game, slot, bytes) {
    await ensureDB();
    if (!current) { const code = await createAccount(); await login(code); }
    const id = `${current.code}|${game}|${slot}`;
    const enc = await encrypt(bytes);
    await put('saves', { id, code: current.code, game, slot, data: enc, ts: Date.now() });
  }
  async function loadState(game, slot) {
    await ensureDB();
    const id = `${current.code}|${game}|${slot}`;
    const rec = await get('saves', id);
    if (!rec) return null;
    return await decrypt(rec.data);
  }
  async function listSaves(game) {
    await ensureDB();
    const allS = await all('saves');
    return allS.filter(s => s.code === current.code && (!game || s.game === game));
  }

  // Controllers API
  async function saveProfile(name, mapping) {
    await ensureDB();
    if (!current) { const code = await createAccount(); await login(code); }
    const id = `${current.code}|${name}`;
    const enc = await encrypt(new TextEncoder().encode(JSON.stringify(mapping)));
    await put('controllers', { id, code: current.code, name, data: enc, ts: Date.now() });
  }
  async function loadProfileMapping(name) { await ensureDB(); const id = `${current.code}|${name}`; const rec = await get('controllers', id); if (!rec) return null; const bytes = await decrypt(rec.data); return JSON.parse(new TextDecoder().decode(bytes)); }
  async function listProfiles() { await ensureDB(); const allP = await all('controllers'); return allP.filter(p => p.code === current.code); }

  async function saveGameController(game, mapping) {
    await ensureDB();
    if (!current) { const code = await createAccount(); await login(code); }
    const base = String(game || window.ROMNAME || state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '').toLowerCase();
    const id = `${current.code}|${base}`;
    const enc = await encrypt(new TextEncoder().encode(JSON.stringify(mapping)));
    await put('controllers_game', { id, code: current.code, game: base, data: enc, ts: Date.now() });
  }
  async function getGameController(game) { await ensureDB(); if (!current) return null; const base = String(game || window.ROMNAME || state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '').toLowerCase(); const id = `${current.code}|${base}`; const rec = await get('controllers_game', id); if (!rec) return null; const bytes = await decrypt(rec.data); return JSON.parse(new TextDecoder().decode(bytes)); }
  async function listGameControllers() { await ensureDB(); const allG = await all('controllers_game'); return allG.filter(r => r.code === current.code); }

  // Favorites
  async function setFavorite(game, fav, tags = [], note = '', rating = null) {
    await ensureDB();
    const id = `${current.code}|${game}`;
    if (!fav) return del('favorites', id);
    await put('favorites', { id, code: current.code, game, tags, note, rating, ts: Date.now() });
  }
  async function listFavorites() { await ensureDB(); const f = await all('favorites'); return f.filter(x => x.code === current.code); }

  // Social
  async function addFriend(code) { await ensureDB(); const rec = await get('friends', current.code) || { code: current.code, list: [] }; if (!rec.list.includes(code)) rec.list.push(code); await put('friends', rec); }
  async function removeFriend(code) { await ensureDB(); const rec = await get('friends', current.code) || { code: current.code, list: [] }; rec.list = rec.list.filter(c => c !== code); await put('friends', rec); }
  async function listFriends() { await ensureDB(); const rec = await get('friends', current.code) || { code: current.code, list: [] }; return rec.list; }

  async function sendMessage(toCode, text) { await ensureDB(); const id = `${current.code}|${Date.now()}`; await put('messages', { id, from: current.code, to: toCode, text, ts: Date.now() }); }
  async function listMessages() { await ensureDB(); const allM = await all('messages'); return allM.filter(m => m.to === current.code || m.from === current.code); }

  // Profile
  async function updateProfile(profile) { await ensureDB(); await put('profiles', { code: current.code, ...profile, ts: Date.now() }); }
  async function getProfile() { await ensureDB(); return await get('profiles', current.code); }

  // Backup/Restore
  async function exportAll() { await ensureDB(); return { accounts: await all('accounts'), saves: await all('saves'), controllers: await all('controllers'), controllers_game: await all('controllers_game'), favorites: await all('favorites'), friends: await all('friends'), messages: await all('messages'), profiles: await all('profiles'), core_options_site: await all('core_options_site') }; }
  async function importAll(json) {
    await ensureDB();
    for (const [store, items] of Object.entries(json)) {
      if (!Array.isArray(items)) continue;
      for (const it of items) { await put(store, it); }
    }
  }

  async function saveCoreOptions(game, payload) {
    await ensureDB();
    if (!current) { const code = await createAccount(); await login(code); }
    const base = String(game || window.ROMNAME || state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '').toLowerCase();
    const id = `${current.code}|${base}`;
    const enc = await encrypt(new TextEncoder().encode(JSON.stringify(payload)));
    await put('core_options', { id, code: current.code, game: base, data: enc, ts: Date.now() });
  }
  async function saveSiteCoreOptions(game, payload) {
    await ensureDB();
    const base = String(game || window.ROMNAME || state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '').toLowerCase();
    await put('core_options_site', { game: base, data: payload, ts: Date.now() });
  }
  async function loadCoreOptions(game) {
    await ensureDB();
    if (!current) return null;
    const base = String(game || window.ROMNAME || state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '').toLowerCase();
    const id = `${current.code}|${base}`;
    const rec = await get('core_options', id);
    if (!rec) return null;
    const bytes = await decrypt(rec.data);
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  async function loadSiteCoreOptions(game) {
    await ensureDB();
    const base = String(game || window.ROMNAME || state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '').toLowerCase();
    const rec = await get('core_options_site', base);
    return rec ? (rec.data || null) : null;
  }

  window.__arcade_onCoreOptions = async function (base, files) {
    try {
      await saveSiteCoreOptions(base, files);
    } catch (e) { console.warn('Save site options failed', e); }
  }

  window.__arcade_onStateSaved = async function (base, bytes) {
    try {
      const game = String(base || window.ROMNAME || state.selectedGame?.rom || 'game').replace(/\.[^/.]+$/, '').toLowerCase();
      await saveState(game, 0, bytes);
    } catch (e) {
      console.warn('Auto-save failed', e);
    }
  }

  // Session management
  const Session = (() => {
    const TIMEOUT_MS = 15 * 60_000;
    let timer;
    function bump() { clearTimeout(timer); timer = setTimeout(() => { logout(); uiRefresh(); }, TIMEOUT_MS); }
    function start() { bump();['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev => document.addEventListener(ev, bump)); }
    function stop() { clearTimeout(timer);['mousemove', 'keydown', 'click', 'touchstart'].forEach(ev => document.removeEventListener(ev, bump)); }
    return { start, stop };
  })();

  // UI hooks
  async function uiRefresh() {
    const modal = qs('#account-modal');
    const sess = qs('#session-row');
    if (current) {
      sess.classList.remove('hidden');
      qs('#session-code').textContent = `Logged in: ${current.code}`;
    } else {
      sess.classList.add('hidden');
      qs('#session-code').textContent = '';
    }
    await refreshLists();
  }
  async function refreshLists() {
    const favs = current ? await listFavorites() : [];
    qs('#favorites-list').innerHTML = favs.map(f => `<div>${f.game} ${f.tags?.length ? ('[' + f.tags.join(', ') + ']') : ''}</div>`).join('');
    const profs = current ? await listProfiles() : [];
    qs('#profiles-list').innerHTML = profs.map(p => `<div>${p.name}</div>`).join('');
    const gprofs = current ? await listGameControllers() : [];
    qs('#game-controllers-list').innerHTML = gprofs.map(p => `<div>${p.game}</div>`).join('');
    const saves = current ? await listSaves() : [];
    qs('#saves-list').innerHTML = saves.map(s => `<div>${s.game} slot ${s.slot} • ${new Date(s.ts).toLocaleString()}</div>`).join('');
    const friends = current ? await listFriends() : [];
    qs('#friends-list').innerHTML = friends.map(c => `<div>${c}</div>`).join('');
    const msgs = current ? await listMessages() : [];
    qs('#messages-list').innerHTML = msgs.map(m => `<div>${m.from} → ${m.to}: ${m.text}</div>`).join('');
  }

  // External integration: Emulatrix save/load
  async function captureCurrentState(game, slot) {
    const host = getFsContainer()?.querySelector('iframe');
    const cw = host?.contentWindow;
    if (!cw?.Module?._cmd_save_state) throw new Error('Save not supported');
    cw.Module._cmd_save_state();
    const filename = (window.ROMNAME || game || '').replace(/\.[^/.]+$/, '');
    let tries = 0, data = null;
    while (tries < 6) {
      try {
        const path = `/home/web_user/retroarch/userdata/states/${filename}.state`;
        const buf = cw.FS.readFile(path);
        if (buf && buf.length > 0) { data = buf; break; }
      } catch { }
      await new Promise(r => setTimeout(r, 500));
      tries++;
    }
    if (!data) throw new Error('No state found');
    await saveState(filename, slot, data);
  }
  async function loadCurrentState(game, slot) {
    const host = getFsContainer()?.querySelector('iframe');
    const cw = host?.contentWindow;
    const filename = (window.ROMNAME || game || '').replace(/\.[^/.]+$/, '');
    const bytes = await loadState(filename, slot);
    if (!bytes) throw new Error('No saved state');
    const path = `/home/web_user/retroarch/userdata/states/${filename}.state`;
    try { cw.FS.unlink(path); } catch { }
    cw.FS.createDataFile('/home/web_user/retroarch/userdata/states', `${filename}.state`, bytes, true, true);
    cw.Module._cmd_load_state();
  }

  return {
    createAccount, login, logout, uiRefresh,
    saveState: captureCurrentState, loadState: loadCurrentState,
    saveProfile, loadProfileMapping, listProfiles, saveGameController, getGameController, listGameControllers,
    setFavorite, listFavorites, addFriend, removeFriend, listFriends, sendMessage, listMessages,
    updateProfile, getProfile, exportAll, importAll
  };
})();

try {
  function showErrorBanner(msg) {
    try {
      var b = document.getElementById('error-banner');
      if (!b) { b = document.createElement('div'); b.id = 'error-banner'; b.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:9999;background:#8b0000;color:#fff;padding:8px 12px;font:13px system-ui'; document.body.appendChild(b); }
      b.textContent = String(msg || '');
    } catch { }
  }
  window.showErrorBanner = showErrorBanner;
  window.addEventListener('error', function (e) { try { var msg = 'Error: ' + String(e?.message || '') + (e?.filename ? (' @ ' + e.filename) : ''); var t = qs('#game-title'); if (t) t.textContent = msg; document.title = msg; showErrorBanner(msg); } catch { } });
  window.addEventListener('unhandledrejection', function (e) { try { var m = ''; try { m = String(e?.reason?.message || e?.reason || ''); } catch { } var msg = 'Error: ' + m; var t = qs('#game-title'); if (t) t.textContent = msg; document.title = msg; showErrorBanner(msg); } catch { } });
} catch { }

function showRoom(room) {
  state.currentRoom = room;
  state.currentView = 'room';
  qs('#game-view').classList.add('hidden');
  qs('#room-arcade').classList.toggle('hidden', room !== 'arcade');
  qs('#room-console').classList.toggle('hidden', room !== 'console');
  document.body.style.background = room === 'arcade' ?
    'radial-gradient(1000px 500px at 50% -200px, rgba(0,245,255,0.2), transparent 40%), var(--bg-arcade)'
    : 'radial-gradient(1000px 500px at 50% -200px, rgba(255,209,102,0.15), transparent 40%), var(--bg-console)';
}

function toGameView(theme) {
  state.currentView = 'game';
  state.theme = theme;
  qs('#room-arcade').classList.add('hidden');
  qs('#room-console').classList.add('hidden');
  const gameView = qs('#game-view');
  gameView.classList.remove('hidden');
  gameView.classList.add('fade-in');
  qs('#theme-arcade').classList.toggle('hidden', theme !== 'arcade');
  qs('#theme-console').classList.toggle('hidden', theme !== 'console');
  { const t = qs('#game-title'); if (t) t.textContent = state.selectedGame?.name || ''; }
  if (theme === 'arcade') {
    const marquee = qs('#arcade-marquee');
    if (marquee) marquee.textContent = state.selectedGame?.name || '';
    const controls = qs('.arcade-controls');
    if (controls) {
      controls.innerHTML = '';
    }
  }
  if (theme === 'console') qs('#console-model').textContent = (state.selectedGame?.core || '').toUpperCase();
  try { updateControlsInfo(); } catch {}
  let aw = 0, ah = 0;
  const asp = state.selectedGame?.aspect || '';
  const m = String(asp).match(/(\d+)\s*[\/:x]\s*(\d+)/i);
  if (m) { aw = parseFloat(m[1]); ah = parseFloat(m[2]); }
  if (!aw || !ah) { const d = [4, 3]; aw = d[0]; ah = d[1]; }
  if (String(state.selectedGame?.core || '').toLowerCase() === 'n64') { aw = 4; ah = 3; }
  if (['ds', 'nds'].includes(String(state.selectedGame?.core || '').toLowerCase())) { aw = 2; ah = 3; }
  window.INNER_RATIO = { w: aw, h: ah };
  document.documentElement.style.setProperty('--emu-aspect-w', String(aw));
  document.documentElement.style.setProperty('--emu-aspect-h', String(ah));
  const wrap = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  if (wrap) wrap.style.setProperty('--emu-aspect', `${aw} / ${ah}`);
  if (state.selectedGame?.rom) startEmulatorUrl(state.selectedGame.core, state.selectedGame.rom, theme);
  (async () => {
    try {
      const g = (state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '');
      const map = await Account.getGameController(g);
      if (map && KeyMapper && KeyMapper.set) {
        KeyMapper.set(map);
      } else if (KeyMapper && KeyMapper.set) {
        let applied = false;
        try {
          const profs = await Account.listProfiles();
          if (Array.isArray(profs) && profs.length > 0) {
            const latest = profs.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))[0];
            const profMap = latest && latest.name ? (await Account.loadProfileMapping(latest.name)) : null;
            if (profMap && typeof profMap === 'object') {
              const tpl = gameActionTemplate();
              const idx = {};
              tpl.forEach(it => { idx[String(it.name || '').toLowerCase()] = it.target; });
              const m2 = {};
              const entries = Object.entries(profMap);
              for (const [k, v] of entries) {
                const key = String(k || '').toLowerCase();
                const code = valueToCode(v);
                const target = idx[key];
                if (code && target) m2[code] = target;
              }
              if (Object.keys(m2).length > 0) {
                KeyMapper.set(m2);
                applied = true;
              }
            }
          }
        } catch { }
        if (!applied) {
          const tpl = gameActionTemplate();
          const def = defaultGameMappingFromTemplate(tpl);
          KeyMapper.set(def);
        }
      }
    } catch { }
  })();
  setTimeout(() => {
    try {
      const host = (theme === 'arcade' ? qs('#emulator') : qs('#emulator-console'))?.querySelector('iframe');
      const hostWin = host?.contentWindow;
      if (hostWin) hostWin.dispatchEvent(new hostWin.Event('resize'));
      const inner = hostWin?.document?.getElementById('container');
      const innerWin = inner?.contentWindow || hostWin;
      if (innerWin) innerWin.dispatchEvent(new innerWin.Event('resize'));
      innerWin?.resizeEmulatorCanvas?.();
    } catch { }
  }, 800);
  setTimeout(() => {
    try {
      const host = (theme === 'arcade' ? qs('#emulator') : qs('#emulator-console'))?.querySelector('iframe');
      const hostWin = host?.contentWindow;
      if (hostWin) hostWin.dispatchEvent(new hostWin.Event('resize'));
      const inner = hostWin?.document?.getElementById('container');
      const innerWin = inner?.contentWindow || hostWin;
      const r = getComputedStyle(document.documentElement);
      const aw = parseFloat(r.getPropertyValue('--emu-aspect-w')) || 4;
      const ah = parseFloat(r.getPropertyValue('--emu-aspect-h')) || 3;
      const wrap = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
      if (wrap) wrap.style.setProperty('--emu-aspect', `${aw} / ${ah}`);
      if (innerWin) innerWin.dispatchEvent(new innerWin.Event('resize'));
      innerWin?.resizeEmulatorCanvas?.();
    } catch { }
  }, 2200);
  try {
    let tries = 0;
    const tick = setInterval(() => {
      tries++;
      notifyEmulatorResize();
      if (tries >= 8) clearInterval(tick);
    }, 600);
  } catch { }
  setTimeout(() => { try { focusEmulator(); } catch { } }, 140);
  setTimeout(() => { try { focusEmulator(); } catch { } }, 1600);
  try { GamepadBridge.start(); } catch { }
}

function displayKeyLabel(code) {
  const s = String(code || '');
  const m1 = s.match(/^Key([A-Z])$/);
  if (m1) return m1[1];
  const m2 = s.match(/^Digit(\d)$/);
  if (m2) return m2[1];
  if (s === 'ArrowUp') return '↑';
  if (s === 'ArrowDown') return '↓';
  if (s === 'ArrowLeft') return '←';
  if (s === 'ArrowRight') return '→';
  return s;
}

function updateControlsInfo() {
  const box = qs('#controls-info');
  if (!box) return;
  const tpl = gameActionTemplate();
  const idx = {};
  tpl.forEach(it => { idx[String(it.name).toLowerCase()] = it.default; });
  const parts = [];
  parts.push('<div class="controls-line"><span class="key">W</span><span class="key">A</span><span class="key">S</span><span class="key">D</span> or Arrow Keys — Move</div>');
  parts.push('<div class="controls-line"><span class="key">Space</span> — Jump / Action</div>');
  parts.push('<div class="controls-line"><span class="key">Enter</span> — Start / Confirm</div>');
  const base = String((state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '')).toLowerCase();
  if (['ssf2t','mvsc'].includes(base)) {
    let p1 = ['lp','mp','hp'].map(k => displayKeyLabel(idx[k] || '')).filter(Boolean);
    let p2 = ['lk','mk','hk'].map(k => displayKeyLabel(idx[k] || '')).filter(Boolean);
    if (p1.length !== 3) p1 = ['KeyU','KeyI','KeyO'].map(displayKeyLabel);
    if (p2.length !== 3) p2 = ['KeyJ','KeyK','KeyL'].map(displayKeyLabel);
    parts.push('<div class="controls-line"><span class="key">' + p1.join('</span><span class="key">') + '</span> — Punch (L/M/H)</div>');
    parts.push('<div class="controls-line"><span class="key">' + p2.join('</span><span class="key">') + '</span> — Kick (L/M/H)</div>');
  } else {
    const hasF = idx.lp || idx.mp || idx.hp || idx.lk || idx.mk || idx.hk;
    if (hasF) {
      const p1 = ['lp','mp','hp'].map(k => displayKeyLabel(idx[k] || '')).filter(Boolean);
      const p2 = ['lk','mk','hk'].map(k => displayKeyLabel(idx[k] || '')).filter(Boolean);
      if (p1.length === 3) parts.push('<div class="controls-line"><span class="key">' + p1.join('</span><span class="key">') + '</span> — Punch (L/M/H)</div>');
      if (p2.length === 3) parts.push('<div class="controls-line"><span class="key">' + p2.join('</span><span class="key">') + '</span> — Kick (L/M/H)</div>');
    }
  }
  if (idx.hit) parts.push('<div class="controls-line"><span class="key">' + displayKeyLabel(idx.hit) + '</span> — Hit</div>');
  if (idx.jump) parts.push('<div class="controls-line"><span class="key">' + displayKeyLabel(idx.jump) + '</span> — Jump</div>');
  if (idx.fire) parts.push('<div class="controls-line"><span class="key">' + displayKeyLabel(idx.fire) + '</span> — Fire</div>');
  if (idx.coin) parts.push('<div class="controls-line"><span class="key">' + displayKeyLabel(idx.coin) + '</span> — Coin</div>');
  if (idx.service) parts.push('<div class="controls-line"><span class="key">' + displayKeyLabel(idx.service) + '</span> — Service</div>');
  box.innerHTML = parts.join('');
}

function backToRoom() {
  if (!state.currentRoom) return;
  try { GamepadBridge.stop(); } catch { }
  qs('#game-view').classList.add('hidden');
  qs('#theme-arcade').classList.add('hidden');
  qs('#theme-console').classList.add('hidden');
  qs('#emulator').innerHTML = '';
  qs('#emulator-console').innerHTML = '';
  try { document.getElementById('fs-controls')?.remove(); } catch {}
  try { document.getElementById('pad-overlay')?.remove(); } catch {}
  try { document.getElementById('gp-debug')?.remove(); } catch {}
  window.ROMNAME = undefined;
  window.ROMDATA = undefined;
  state.selectedGame = null;
  // Exit fullscreen if active
  try {
    if (document.fullscreenElement && document.exitFullscreen) {
      document.exitFullscreen().catch(() => { });
    }
    document.body.classList.remove('is-fullscreen');
    document.documentElement.classList.remove('is-fullscreen');
    const app = qs('#view-container') || qs('#app');
    app?.classList.remove('is-fullscreen');
  } catch { }
  showRoom(state.currentRoom);
}

async function startEmulator(core, file, theme) {
  if (String(core || '').toLowerCase() === 'n64') { await startN64FromFile(file, theme); return; }
  if (String(core || '').toLowerCase() === 'ds' || String(core || '').toLowerCase() === 'nds') { await startDSFromFile(file, theme); return; }
  try {
    const nm = file?.name || '';
    const ext = String(nm.split('.').pop() || '').toLowerCase();
    if (theme === 'arcade' && ext === 'zip') {
      const data = new Uint8Array(await file.arrayBuffer());
      setEmulatrixGlobals(nm || 'game.zip', data);
      mountMame2003Direct(theme, nm || 'game.zip');
      return;
    }
  } catch {}
  if (String(core || '').toLowerCase() === 'segacd' || String(core || '').toLowerCase() === 'sega cd') {
    const url = URL.createObjectURL(file);
    const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
    container.innerHTML = '';
    window.EJS_player = theme === 'arcade' ? '#emulator' : '#emulator-console';
    window.EJS_core = 'segaCD';
    window.EJS_gameUrl = url;
    window.EJS_biosUrl = new URL('bios_CD_U.bin', location.href).toString();
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
    window.EJS_enable_savestates = true;
    window.EJS_enable_sound = true;
    window.EJS_gamepad = true;
    window.EJS_threads = true;
    try { document.addEventListener('click', function () { try { if (window.EJS_emulator && typeof window.EJS_emulator.resumeAudio === 'function') window.EJS_emulator.resumeAudio(); } catch { } try { if (window.Module && window.Module.SDL2 && window.Module.SDL2.audioContext && typeof window.Module.SDL2.audioContext.resume === 'function') window.Module.SDL2.audioContext.resume(); } catch { } }); } catch { }
    const s = document.createElement('script');
    s.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    try { s.crossOrigin = 'anonymous'; } catch { }
    s.async = true;
    s.onload = () => console.log('Emulator loaded');
    document.body.appendChild(s);
    return;
  }
  const innerCandidate = await preferEmulatrix(core, file?.name);
  if (innerCandidate) { await startEmulatrixFromFile(file, theme, innerCandidate); return; }
  const url = URL.createObjectURL(file);
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  window.EJS_player = theme === 'arcade' ? '#emulator' : '#emulator-console';
  window.EJS_core = core;
  window.EJS_gameUrl = encodeURI(url);
  if (String(core || '').toLowerCase() === 'segacd' || String(core || '').toLowerCase() === 'sega cd') {
    window.EJS_biosUrl = encodeURI(new URL('bios_CD_E.bin', location.href).toString());
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
    try { fetch(window.EJS_biosUrl, { method: 'HEAD', cache: 'no-store' }).then(() => { }).catch(() => { }); } catch { }
  }
  window.EJS_enable_savestates = true;
  window.EJS_enable_sound = true;
  window.EJS_gamepad = true;
  const s = document.createElement('script');
  s.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
  try { s.crossOrigin = 'anonymous'; } catch { }
  s.async = true;
  s.onload = () => console.log('Emulator loaded');
  document.body.appendChild(s);
}

async function startEmulatorUrl(core, url, theme) {
  if (String(core || '').toLowerCase() === 'n64') { await startN64FromUrl(url, theme); return; }
  if (String(core || '').toLowerCase() === 'ds' || String(core || '').toLowerCase() === 'nds') { await startDSFromUrl(url, theme); return; }
  const coreLower = String(core || '').toLowerCase();
  if (coreLower === 'mame2003' || coreLower === 'mame32') {
    const absUrl = new URL(url, location.href).toString();
    await startArcadeEJSFromUrl(absUrl, theme);
    return;
  }
  if (String(core || '').toLowerCase() === 'segacd' || String(core || '').toLowerCase() === 'sega cd') {
    try {
      const u = new URL(url, location.href).toString();
      const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
      container.innerHTML = '';
      window.EJS_player = theme === 'arcade' ? '#emulator' : '#emulator-console';
      window.EJS_core = 'segaCD';
      window.EJS_gameUrl = u;
      window.EJS_biosUrl = new URL('bios_CD_U.bin', location.href).toString();
      window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
      window.EJS_enable_savestates = true;
      window.EJS_enable_sound = true;
      window.EJS_gamepad = true;
      window.EJS_threads = true;
      try { document.addEventListener('click', function () { try { if (window.EJS_emulator && typeof window.EJS_emulator.resumeAudio === 'function') window.EJS_emulator.resumeAudio(); } catch { } try { if (window.Module && window.Module.SDL2 && window.Module.SDL2.audioContext && typeof window.Module.SDL2.audioContext.resume === 'function') window.Module.SDL2.audioContext.resume(); } catch { } }); } catch { }
      const s = document.createElement('script');
      s.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
      try { s.crossOrigin = 'anonymous'; } catch { }
      s.async = true;
      s.onload = () => console.log('Emulator loaded');
      document.body.appendChild(s);
    } catch (e) {
      const t = qs('#game-title');
      if (t) t.textContent = 'Failed to start Sega CD (' + e.message + ')';
    }
    return;
  }
  const innerCandidate = await preferEmulatrix(core, url);
  function mapInner(coreName, path) {
    const ext = String(path || '').split('.').pop().toLowerCase();
    const c = String(coreName || '').toLowerCase();
    const map = {
      nes: 'Emulatrix_Nintendo.htm',
      snes: 'Emulatrix_SuperNintendo.htm',
      genesis: 'Emulatrix_SegaGenesis.htm',
      gba: 'Emulatrix_GameBoyAdvance.htm',
      gb: 'Emulatrix_GameBoy.htm',
      gbc: 'Emulatrix_GameBoy.htm',
      mame2003: 'Emulatrix_MAME2003.htm',
      mame32: 'Emulatrix_MAME32.htm',
    };
    return map[c] || (ext === 'zip' ? 'Emulatrix_MAME2003.htm' : null);
  }
  const fallbackInner = mapInner(core, url);
  if (innerCandidate || fallbackInner) { await startEmulatrixFromUrl(url, theme, innerCandidate || fallbackInner); return; }
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  window.EJS_player = theme === 'arcade' ? '#emulator' : '#emulator-console';
  window.EJS_core = core;
  window.EJS_gameUrl = encodeURI(new URL(url, location.href).toString());
  if (String(core || '').toLowerCase() === 'segacd' || String(core || '').toLowerCase() === 'sega cd') {
    window.EJS_biosUrl = encodeURI(new URL('bios_CD_E.bin', location.href).toString());
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
    try {
      const romRes = await fetch(window.EJS_gameUrl);
      const biosRes = await fetch(window.EJS_biosUrl);
      if (!romRes.ok) {
        try {
          const alt = 'https://raw.githubusercontent.com/12345keddie/Pac-Cade/main/' + encodeURIComponent(url);
          const altRes = await fetch(alt, { cache: 'no-store' });
          if (altRes.ok) { window.EJS_gameUrl = alt; romRes = altRes; } else { throw new Error('ROM HTTP ' + romRes.status); }
        } catch { throw new Error('ROM HTTP ' + romRes.status); }
      }
      if (!biosRes.ok) {
        try {
          const altB = 'https://raw.githubusercontent.com/12345keddie/Pac-Cade/main/' + encodeURIComponent('bios_CD_E.bin');
          const altBRes = await fetch(altB, { cache: 'no-store' });
          if (altBRes.ok) { window.EJS_biosUrl = altB; biosRes = altBRes; } else { throw new Error('BIOS HTTP ' + biosRes.status); }
        } catch { throw new Error('BIOS HTTP ' + biosRes.status); }
      }
      const head = await romRes.clone().arrayBuffer().then(b => String.fromCharCode.apply(null, Array.from(new Uint8Array(b).slice(0, 64)))).catch(() => "\u0000");
      if (/git-lfs/i.test(head)) throw new Error('ROM not available in deployment');
    } catch (e) {
      const t = qs('#game-title');
      if (t) t.textContent = 'Failed to load Sega CD (' + e.message + ')';
      return;
    }
  }
  window.EJS_enable_savestates = true;
  window.EJS_enable_sound = true;
  window.EJS_gamepad = true;
  const s = document.createElement('script');
  s.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
  try { s.crossOrigin = 'anonymous'; } catch { }
  s.async = true;
  s.onload = () => console.log('Emulator loaded');
  document.body.appendChild(s);
}

async function startArcadeEJSFromUrl(url, theme) {
  try {
    const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
    container.innerHTML = '';
    window.EJS_player = theme === 'arcade' ? '#emulator' : '#emulator-console';
    window.EJS_core = 'mame2003';
    window.EJS_gameUrl = url;
    window.EJS_pathtodata = 'https://cdn.emulatorjs.org/stable/data/';
    window.emulatorjs = window.emulatorjs || {};
    window.EJS_enable_savestates = true;
    window.EJS_enable_sound = true;
    window.EJS_gamepad = true;
    const name = url.split('/').pop().replace(/\.[^/.]+$/, "");
    window.EJS_gameName = name;
    
    const t = qs('#game-title'); if (t) t.textContent = 'Starting arcade emulator…';
    const s = document.createElement('script');
    s.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
    try { s.crossOrigin = 'anonymous'; } catch {}
    s.async = true;
    s.onload = () => { try { const t2 = qs('#game-title'); if (t2) t2.textContent = name; } catch {} };
    document.body.appendChild(s);
  } catch (e) {
    try { const t = qs('#game-title'); if (t) t.textContent = 'Arcade start error: ' + String(e?.message || e); } catch {}
  }
}

async function startEmulatrixFromData(name, data, theme, innerPage) {
  try {
    setEmulatrixGlobals(name, data);
    mountEmulatrix(theme, innerPage || 'Emulatrix_MAME2003.htm');
  } catch (e) {
    try { const t = qs('#game-title'); if (t) t.textContent = 'Local arcade engine error: ' + String(e?.message || e); } catch {}
  }
}

function setEmulatrixGlobals(name, data) {
  window.ROMNAME = name;
  window.ROMDATA = data;
  window.STRING_LOADING = 'Loading...';
  window.STRING_SAVING = 'Saving, please wait...';
  window.STRING_STARTINGEMULATOR = 'Starting Emulator';
  window.STATE_CHECK_TIMES = 2;
  window.goBackButtonResetIncrement = () => { };
}

function setRunnerGlobals(name, data) {
  window.ROMNAME = name;
  window.ROMDATA = data;
}

function mountEmulatrix(theme, innerPage) {
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.src = 'Emulatrix.htm';
  iframe.allow = 'gamepad; autoplay; fullscreen';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('frameborder', '0');
  iframe.addEventListener('load', () => {
    try {
      const cw = iframe.contentWindow;
      if (window.ROMDATA && window.ROMNAME) {
        console.log('[Arcade] Emulatrix iframe loaded; injecting ROM and UI overrides');
        cw.ROMDATA = window.ROMDATA;
        cw.ROMNAME = window.ROMNAME;
        try { cw.setBooleanSetting && cw.setBooleanSetting('GAME_SOUND_ENABLED', true); cw.updateSoundIcon && cw.updateSoundIcon(); } catch { }
        const gui = cw.document.getElementsByClassName('gui_container')[0];
        const inner = cw.document.getElementById('container');
        try { inner.setAttribute('allow', 'gamepad; autoplay; fullscreen'); inner.allow = 'gamepad; autoplay; fullscreen'; } catch { }
        const style = cw.document.createElement('style');
        const rw = (window.INNER_RATIO && window.INNER_RATIO.w) || 4;
        const rh = (window.INNER_RATIO && window.INNER_RATIO.h) || 3;
        style.textContent = `
          .gui_goback, .gui_goback_mobile, .gui_fullscreen, .gui_decrease, .gui_decrease_mobile,
          .gui_increase, .gui_increase_mobile, .gui_sound_on, #gui_sound_handler, #gui_sound_handler_mobile,
          .gui_download, .gui_download_mobile, .gui_uploadsave, .gui_uploadsave_mobile, .gui_reload, .gui_reload_mobile,
          .gui_how_mobile, .gui_safari, .gui_title, .gui_controls { display: none !important; pointer-events: none !important; }
          html, body { height: 100%; background: #000; }
          /* No inner sizing overrides; host page controls letterbox */
        `;
        cw.document.head.appendChild(style);
        if (gui) gui.style.display = 'none';
        if (inner) {
          inner.style.display = 'block';
          inner.focus();
          try { inner.src = new URL(innerPage, location.href).toString(); } catch { inner.src = innerPage; }
          inner.addEventListener('load', () => {
            try {
              const idoc = inner.contentDocument;
              try { const t = qs('#game-title'); if (t) t.textContent = 'Starting emulator…'; } catch {}
              console.log('[Arcade] NES inner document loaded; applying overlays + letterbox');
              const style2 = idoc.createElement('style');
                style2.textContent = `
                  .gui_nintendo_keyselect, .gui_nintendo_keystart, .gui_nintendo_keyb, .gui_nintendo_keya,
                  .gui_supernintendo_keyselect, .gui_supernintendo_keystart, .gui_supernintendo_keyb, .gui_supernintendo_keya, .gui_supernintendo_keyx, .gui_supernintendo_keyy, .gui_supernintendo_keyl, .gui_supernintendo_keyr,
                  .gui_joystick, .gui_saving { display: none !important; pointer-events: none !important; }
                  html, body { height: 100%; background: #000; }
                  #container { position: absolute; inset: 0; }
                  #canvas { display: block; width: 100% !important; height: 100% !important; }
                `;
                idoc.head.appendChild(style2);
              const canvas = idoc.getElementById('canvas');
              try {
                inner.contentWindow.addEventListener('error', (e) => {
                  try { const t = qs('#game-title'); if (t) t.textContent = 'Emulator error: ' + String(e?.message || ''); } catch {}
                });
                inner.contentWindow.addEventListener('unhandledrejection', (e) => {
                  try { const t = qs('#game-title'); if (t) t.textContent = 'Emulator promise error'; } catch {}
                });
              } catch {}
              try {
                const iw = inner.contentWindow;
                iw.startFileSystem && iw.startFileSystem();
                iw.loadRomIntoVD && iw.loadRomIntoVD();
                setTimeout(() => { try { iw.startEmulator && iw.startEmulator(); } catch {} }, 1200);
                } catch {}
                (async () => {
                  try {
                    const siteOpts = await loadSiteCoreOptions();
                    if (siteOpts && inner.contentWindow?.applyCoreOptions) inner.contentWindow.applyCoreOptions(siteOpts);
                  } catch { }
                })();
                attachInnerKeyMapper(inner.contentWindow);
                let checks = 0;
                const watcher = () => {
                  try {
                    const w = canvas?.width || 0;
                    const h = canvas?.height || 0;
                    if (w > 0 && h > 0) {
                      try { const t = qs('#game-title'); if (t) t.textContent = state.selectedGame?.name || 'Running'; } catch {}
                      console.log('[Arcade] Emulator canvas ready', w, h);
                      window.INNER_RATIO = { w, h };
                      idoc.documentElement.style.setProperty('--ratio-w', String(w));
                      idoc.documentElement.style.setProperty('--ratio-h', String(h));
                      const hostDoc = document;
                      hostDoc.documentElement.style.setProperty('--emu-aspect-w', String(w));
                      hostDoc.documentElement.style.setProperty('--emu-aspect-h', String(h));
                      const hostWrap = (theme === 'arcade' ? qs('#emulator') : qs('#emulator-console'));
                      if (hostWrap) hostWrap.style.setProperty('--emu-aspect', `${w} / ${h}`);
                      try {
                        const iw = inner.contentWindow;
                        const coreLower = String(state.selectedGame?.core || '').toLowerCase();
                        if (typeof iw.sendVirtualKey === 'function') {
                          if (coreLower === 'mame2003' || coreLower === 'mame32') {
                            iw.sendVirtualKey('keydown', 'Digit1');
                            iw.sendVirtualKey('keyup', 'Digit1');
                            setTimeout(() => { try { iw.sendVirtualKey('keydown', 'Enter'); iw.sendVirtualKey('keyup', 'Enter'); } catch {} }, 180);
                          } else {
                            iw.sendVirtualKey('keydown', 'Enter');
                            iw.sendVirtualKey('keyup', 'Enter');
                          }
                        }
                      } catch {}
                      return;
                    }
                    checks++;
                    console.warn('[Arcade] Emulator not ready, retry', checks);
                    if (checks === 2 && inner.contentWindow?.reloadROM) { console.log('[Arcade] Trigger reloadROM()'); inner.contentWindow.reloadROM(); }
                    if (checks === 4 && inner.contentWindow?.Module) {
                      try {
                        const nm = String(window.ROMNAME || 'game.nes');
                        const path = `/${nm}`;
                        console.log('[Arcade] Direct callMain fallback', path);
                        inner.contentWindow.Module.callMain(["-v", path]);
                      } catch (e) { console.warn('[Arcade] callMain fallback failed', e); }
                    }
                    if (checks < 6) setTimeout(watcher, 1500);
                    else {
                      try {
                        const host = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
                        if (host) {
                          host.innerHTML = '';
                          window.EJS_player = theme === 'arcade' ? '#emulator' : '#emulator-console';
                          window.EJS_core = 'mame2003';
                          const blobUrl = URL.createObjectURL(new Blob([window.ROMDATA], { type: 'application/zip' }));
                          window.EJS_gameUrl = blobUrl;
                          window.EJS_enable_savestates = true;
                          window.EJS_enable_sound = true;
                          window.EJS_gamepad = true;
                          const s = document.createElement('script');
                          s.src = 'https://cdn.emulatorjs.org/stable/data/loader.js';
                          try { s.crossOrigin = 'anonymous'; } catch {}
                          s.async = true;
                          s.onload = () => console.log('EJS fallback loaded');
                          document.body.appendChild(s);
                        }
                      } catch {}
                    }
                  } catch (e) {
                    console.warn('[Arcade] watcher error', e);
                  }
                };
                setTimeout(watcher, 1500);
                try { inner.contentWindow?.toggleSound?.(true); } catch { }
                try { inner.contentWindow?.Module?.SDL2?.audioContext?.resume?.(); } catch { }
                setTimeout(() => {
                  try {
                    const r = getComputedStyle(document.documentElement);
                    const aw = parseFloat(r.getPropertyValue('--emu-aspect-w')) || 4;
                    const ah = parseFloat(r.getPropertyValue('--emu-aspect-h')) || 3;
                    const hostWrap = (theme === 'arcade' ? qs('#emulator') : qs('#emulator-console'));
                    if (hostWrap) hostWrap.style.setProperty('--emu-aspect', `${aw} / ${ah}`);
                    const host = hostWrap?.querySelector('iframe');
                    const hostWin = host?.contentWindow;
                    const inner = hostWin?.document?.getElementById('container');
                    const innerWin = inner?.contentWindow || hostWin;
                    innerWin?.dispatchEvent(new innerWin.Event('resize'));
                    innerWin?.resizeEmulatorCanvas?.();
                    innerWin?.toggleSound?.(true);
                    try { innerWin?.Module?.SDL2?.audioContext?.resume?.(); } catch { }
                  } catch { }
                }, 2600);
              } catch { }
            });
        }
      }
    } catch (e) { }
  });
  container.appendChild(iframe);
}

function mountSonicCD(theme) {
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.allow = 'gamepad; autoplay; fullscreen';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('frameborder', '0');
  iframe.src = 'soniccd.html';
  container.appendChild(iframe);
}

function mountGenesisPlusGX(theme) {
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.allow = 'gamepad; autoplay; fullscreen';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('frameborder', '0');
  const html = `<!doctype html><html><head><meta charset="utf-8"><base href="${location.href}"><style>
    html,body{height:100%;margin:0;background:#000;color:#ddd;font-family:system-ui,Segoe UI,Arial,sans-serif}
    #container{position:absolute;inset:0}
    #canvas{display:block;width:100% !important;height:100% !important}
  </style>
  <script>
    window.Module = window.Module || {};
    Module.canvas = document.createElement('canvas');
    Module.locateFile = function(n){ if(n.endsWith('.wasm')) return 'genesis_plus_gx_libretro.wasm'; return n; };
    window.onerror = function(msg, src, line, col){ try { parent.qs && parent.qs('#game-title') && (parent.qs('#game-title').textContent = 'Sega CD Error: '+msg); } catch(e){} };
    try { window.addEventListener('error', function(e){ try { var t = parent.qs && parent.qs('#game-title'); if (t) t.textContent = 'Sega CD Error: ' + String(e?.message||'') + (e?.filename?(' @ '+e.filename):''); } catch{} }); } catch{}
  </script>
  </head><body>
    <div id="container"><canvas id="canvas" oncontextmenu="event.preventDefault()"></canvas></div>
    <script>(function(){
      var container_width, container_height; var settings_file=""; var settings_Checker;
      function loadRomIntoVD(){
        var dataView=new Uint8Array(parent.ROMDATA);
        var ext=String(parent.ROMNAME||'').split('.').pop().toLowerCase();
        var fn='game.'+(ext||'bin');
        FS.createDataFile('/', fn, dataView, true, false);
        FS.createFolder('/home/web_user','retroarch',true,true);
        FS.createFolder('/home/web_user/retroarch','userdata',true,true);
        FS.createFolder('/home/web_user/retroarch/userdata','system',true,true);
        settings_file += "rgui_browser_directory = /\n";
        settings_file += "system_directory = /home/web_user/retroarch/userdata/system\n";
        settings_file += "video_scale = 1\n";
        settings_file += "audio_latency = 128\n";
        settings_file += "menu_enable_widgets = false\n";
        FS.createDataFile('/home/web_user/retroarch/userdata','retroarch.cfg', settings_file, true, true);
      }
      function checkSettingsFile(){
        var mustStart=false; try { var myTempFile=FS.readFile('/home/web_user/retroarch/userdata/retroarch.cfg'); if (myTempFile.length==settings_file.length){ mustStart=true; } } catch(e){}
        if (mustStart==true){ clearInterval(settings_Checker); setTimeout(function(){ startEmulator(); }, 500); }
      }
      function startEmulator(){
        var base=String(parent.ROMNAME||'game.chd'); var ext=(base.split('.').pop()||'chd').toLowerCase(); var path='/game.'+ext;
        var biosList=['bios_CD_E.bin','bios_CD_U.bin','bios_CD_J.bin'];
        var dirs=['','assets/bios/','system/','assets/system/'];
        function fetchOne(name){
          return new Promise(function(resolve,reject){
            var idx=0;
            function next(){
              if(idx>=dirs.length){ reject(new Error('not found')); return; }
              var p=dirs[idx++]+name;
              var u; try { u=new URL(p, parent.location.href).toString(); } catch(e){ u=p; }
              fetch(u,{cache:'no-store'}).then(function(res){
                if(!res.ok){ next(); return; }
                return res.arrayBuffer().then(function(buf){ resolve(new Uint8Array(buf)); });
              }).catch(function(){ next(); });
            }
            next();
          });
        }
        Promise.allSettled(biosList.map(function(n){ return fetchOne(n).then(function(buf){ FS.createDataFile('/home/web_user/retroarch/userdata/system', n, buf, true, true); }); }))
          .then(function(results){
            var ok = results.some(function(r){ return r.status==='fulfilled'; });
            if(!ok){ try { parent.qs && parent.qs('#game-title') && (parent.qs('#game-title').textContent='Sega CD Error: BIOS not found'); } catch(e){} return; }
            Module.callMain(['-v', path]);
            resizeEmulatorCanvas(); setTimeout(function(){ resizeEmulatorCanvas(); }, 600);
          })
          .catch(function(){ try { parent.qs && parent.qs('#game-title') && (parent.qs('#game-title').textContent='Sega CD Error: BIOS load failed'); } catch(e){} });
      }
      function resizeEmulatorCanvas(){ try { container_width=document.getElementById('container').offsetWidth; container_height=document.getElementById('container').offsetHeight; Module.setCanvasSize(container_width, container_height, true); } catch(e){} }
      function toggleSound(v){ try{ if(v){ Module.SDL2.audioContext.resume(); } else { Module.SDL2.audioContext.suspend(); } }catch(e){} }
      function reloadROM(){ try{ var base=String(parent.ROMNAME||'game.chd'); var ext=(base.split('.').pop()||'chd').toLowerCase(); Module.callMain(['-v','/game.'+ext]); }catch(e){} }
      function applyCoreOptions(opts){}
      function wait(){ return new Promise(function(resolve){ function check(){ try { if (window.Module && window.FS && typeof Module.callMain==='function') { resolve(); return; } } catch(e){} setTimeout(check, 100); } check(); }); }
      window.onerror = function(msg, src, line, col){ try { parent.qs && parent.qs('#game-title') && (parent.qs('#game-title').textContent = 'Sega CD Error: '+msg+' '+(src||'')); } catch(e){} };
      window.addEventListener('load', function(){
        if (typeof Module==='object'){ Module.locateFile = function(n){ if(n.endsWith('.wasm')) return 'genesis_plus_gx_libretro.wasm'; return n; }; Module.canvas = document.getElementById('canvas'); }
        try {
          fetch('genesis_plus_gx_libretro.js',{cache:'no-store'})
            .then(function(res){
              try { var t = parent.qs && parent.qs('#game-title'); if (t) t.textContent = 'Fetching core... ' + (res.headers&&res.headers.get&&res.headers.get('content-type')||''); } catch{}
              if(!res.ok) throw new Error('Core HTTP '+res.status);
              return res.arrayBuffer();
            })
            .then(function(buf){
              var u8 = new Uint8Array(buf);
              try { var t = parent.qs && parent.qs('#game-title'); if (t) t.textContent = 'Core size: ' + u8.length; } catch{}
              var txt = '';
              try { txt = new TextDecoder('utf-8').decode(u8); } catch(e){ txt = ''; }
              if(!txt || /^\s*</.test(txt)) { throw new Error('Core returned non-JS bytes'); }
              var ok = false;
              try { new Function(txt); ok = true; } catch(parseErr){ throw new Error('Core SyntaxError: '+String(parseErr&&parseErr.message||parseErr)); }
              if(!ok) throw new Error('Core could not be validated');
              try {
                new Function(txt)();
                wait().then(function(){ loadRomIntoVD(); settings_Checker=setInterval(checkSettingsFile, 300); document.getElementById('container').focus(); });
              } catch(execErr){ throw new Error('Core exec error: '+String(execErr&&execErr.message||execErr)); }
            })
            .catch(function(e){ try { var t = parent.qs && parent.qs('#game-title'); if (t) t.textContent = 'Sega CD Error: '+String(e&&e.message||e); } catch{} });
        } catch(e) { console.error('Core load inject error', e); }
      });
    })();</script>
  </body></html>`;
  iframe.srcdoc = html;
  container.appendChild(iframe);
}

function mountN64(theme, romUrl) {
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.allow = 'gamepad; autoplay; fullscreen';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('frameborder', '0');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#000;color:#ddd;font-family:system-ui,Segoe UI,Arial,sans-serif}
    #canvasDiv{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
    #canvas{display:block;width:100% !important;height:100% !important}
    .hidden{display:none}
    #controlsZone{position:absolute;top:10px;left:0;z-index:10;width:12px;height:60vh}
    #controlsZone:hover{width:280px}
    #controlsBtn{position:absolute;top:0;left:0;background:#1e232f;color:#fff;border:1px solid rgba(255,255,255,0.2);padding:6px 10px;border-radius:6px;cursor:pointer;display:none}
    #controlsZone:hover #controlsBtn{display:block}
    #controlsPanel{position:absolute;top:36px;left:0;background:#0f1422;color:#e6e8ee;border:1px solid rgba(255,255,255,0.18);border-radius:8px;padding:10px;min-width:260px;max-height:60vh;overflow:auto}
    #controlsPanel .row{display:flex;align-items:center;gap:8px;margin:6px 0}
    #controlsPanel .row label{flex:0 0 110px;font-size:12px;opacity:0.85}
    #controlsPanel .row input{flex:1 1 auto;background:#121826;color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px}
  </style>
  <script>
    (function(){
      try {
        window.getSystemDarkMode = function(){
          try { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); } catch(e){ return false; }
        };
        function ensureInput(id){
          try {
            if (!document.getElementById(id)) {
              var input = document.createElement('input');
              input.type = 'file';
              input.id = id;
              input.className = 'hidden';
              document.body.appendChild(input);
            }
          } catch(e){}
        }
        document.addEventListener('DOMContentLoaded', function(){
          ensureInput('file-upload');
          ensureInput('file-upload-eep');
          ensureInput('file-upload-sra');
          ensureInput('file-upload-fla');
        });
      } catch (e) {}
    })();
  </script>
  <script src="https://code.jquery.com/jquery-3.6.0.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/rivets@0.9.6/dist/rivets.bundled.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/nipplejs@0.9.0/dist/nipplejs.min.js"></script>
  </head>
  <body>
    <div id="topPanel" class="hidden"></div>
    <div id="bottomPanel" class="hidden"></div>
    <div id="loginModal" class="hidden"></div>
    <div id="buttonsModal" class="hidden"></div>
    <div id="lblErrorOuter"><div id="lblError"></div></div>
    <div id="mobileBottomPanel" class="hidden"></div>
    <div id="mobileButtons" class="hidden">
      <button id="mobileA" class="hidden">A</button>
      <button id="mobileB" class="hidden">B</button>
      <button id="mobileStart" class="hidden">Start</button>
      <button id="mobileSelect" class="hidden">Select</button>
    </div>
    <div id="menuDiv" class="hidden"></div>
    <input id="file-upload" type="file" class="hidden" />
    <input id="file-upload-eep" type="file" class="hidden" />
    <input id="file-upload-sra" type="file" class="hidden" />
    <input id="file-upload-fla" type="file" class="hidden" />
    <div id="maindiv" class="hidden">
      <select id="romselect" class="hidden"></select>
      <select id="savestateSelect" class="hidden"></select>
    </div>
    <div id="dropArea" style="position:absolute;inset:0;outline:none">
      <div id="controlsZone"><button id="controlsBtn">Controls</button><div id="controlsPanel" class="hidden"></div></div>
      <div id="canvasDiv"><canvas id="canvas" width="640" height="480"></canvas></div>
    </div>
    <script>
      window.postLoad = function(){
        try {
          var romUrl = ${JSON.stringify(romUrl)};
          function wait(){
            return new Promise(function(resolve){
              function check(){
                try {
                  if (window.Module && window.Module.HEAP16 && typeof window.Module._neilGetSoundBufferResampledAddress==='function' && typeof window.Module.callMain==='function') { resolve(); return; }
                } catch(e){}
                setTimeout(check, 100);
              }
              check();
            });
          }
          wait().then(function(){
            return fetch(romUrl);
          }).then(function(res){
            if(!res.ok) throw new Error('HTTP '+res.status);
            return res.arrayBuffer();
          }).then(function(buf){
            var bytes = new Uint8Array(buf);
            try {
              var s = String.fromCharCode.apply(null, Array.from(bytes.slice(0, 64)));
              if (/git-lfs/i.test(s)) throw new Error('ROM not available in deployment');
            } catch(e){}
            try { window.myApp.rivetsData.showFPS = false; } catch(e){}
            try { window.myApp.setToLocalStorage('n64wasm-showfps','showFPS'); } catch(e){}
            try {
              var base = (typeof romUrl==='string' ? romUrl.split('/').pop() : 'game.z64');
              var bn = String(base||'').replace(/\.[^/.]+$/, '').toLowerCase();
              if (bn === 'banjo-kazooie' && window.myApp && window.myApp.rivetsData && window.myApp.rivetsData.inputController) {
                var km = window.myApp.rivetsData.inputController.KeyMappings;
                km.Mapping_Action_Analog_Up = 'w';
                km.Mapping_Action_Analog_Down = 's';
                km.Mapping_Action_Analog_Left = 'a';
                km.Mapping_Action_Analog_Right = 'd';
                km.Mapping_Action_CLEFT = 'j';
                km.Mapping_Action_CRIGHT = 'l';
                km.Mapping_Action_CUP = 'k';
                km.Mapping_Action_CDOWN = 'i';
                km.Mapping_Action_A = ' ';
                km.Mapping_Action_B = 'f';
                km.Mapping_Action_Z = 'ShiftLeft';
                km.Mapping_Action_R = 'r';
                km.Mapping_Action_Start = 'Enter';
                km.Mapping_Left = '';
                km.Mapping_Right = '';
                km.Mapping_Up = '';
                km.Mapping_Down = '';
                try { window.myApp.WriteConfigFile(); } catch(e){}
              }
            } catch(e){}
            try { window.myApp.rom_name = (typeof romUrl==='string' ? romUrl.split('/').pop() : 'game.z64'); } catch(e){}
            try { window.myApp.LoadEmulator(bytes); } catch(e){ console.error('LoadEmulator failed', e); }
          }).catch(function(err){ console.error('ROM fetch failed', err); });
        } catch (e) { console.error('postLoad error', e); }
      };
    <\/script>
    <script src="settings.js"></script>
    <script src="romlist.js"></script>
    <script src="script.js"></script>
    <script src="n64wasm.js"></script>
    <script>
      (function(){
        function patch(){
          try {
            if (window.myApp && typeof window.myApp.sendMobileControls !== 'function') {
              window.myApp.sendMobileControls = function(m, vx, vy){
                try { this._mobileString = String(m||''); this._vectorX = parseFloat(vx)||0; this._vectorY = parseFloat(vy)||0; } catch(e){}
              };
            }
          } catch(e){}
        }
        patch();
        document.addEventListener('DOMContentLoaded', patch);
        setTimeout(patch, 500);
        setTimeout(patch, 1500);
      })();
    <\/script>
    <script>
      (function(){
        function normKey(ev){ var k = ev.key; if ((ev.code==='Space')||k==='Spacebar'||k==='Space') k=' '; return k; }
        function build(){
          try{
            var app = window.myApp; if(!app||!app.rivetsData||!app.rivetsData.inputController) return;
            var maps = app.rivetsData.inputController.KeyMappings;
            var panel = document.getElementById('controlsPanel');
            var defs = [
              ['A','Mapping_Action_A'],
              ['B','Mapping_Action_B'],
              ['Z','Mapping_Action_Z'],
              ['Start','Mapping_Action_Start'],
              ['C-Up','Mapping_Action_CUP'],
              ['C-Down','Mapping_Action_CDOWN'],
              ['C-Left','Mapping_Action_CLEFT'],
              ['C-Right','Mapping_Action_CRIGHT'],
              ['Analog Left','Mapping_Action_Analog_Left'],
              ['Analog Right','Mapping_Action_Analog_Right']
            ];
            var html='';
            for(var i=0;i<defs.length;i++){ var d=defs[i]; var val = maps[d[1]]||''; html += '<div class="row"><label>'+d[0]+'</label><input data-key="'+d[1]+'" value="'+(val===' ' ? 'Space' : val)+'" readonly /></div>'; }
            panel.innerHTML = html;
            panel.querySelectorAll('input').forEach(function(inp){
              inp.addEventListener('focus', function(){ inp.value=''; function onKey(e){ e.preventDefault(); var v = normKey(e); inp.value = (v===' ' ? 'Space' : v); var kname = inp.getAttribute('data-key'); maps[kname]=v; try{ localStorage.setItem('n64wasm_mappings_v3', JSON.stringify(maps)); }catch(e){} try{ app.WriteConfigFile(); }catch(e){} document.removeEventListener('keydown', onKey, true); inp.blur(); }
                document.addEventListener('keydown', onKey, true);
              });
            });
            var btn = document.getElementById('controlsBtn');
            btn.onclick = function(){ panel.classList.toggle('hidden'); };
          }catch(e){}
        }
        function wait(){ if (window.myApp && window.myApp.rivetsData && window.myApp.rivetsData.inputController) { build(); } else { setTimeout(wait, 200); } }
        document.addEventListener('DOMContentLoaded', wait);
        setTimeout(wait, 1200);
      })();
    <\/script>
    <script>
      (function(){
        function resume(){ try { var ac = window.myApp && window.myApp.audioContext; if (ac && ac.state !== 'running') ac.resume(); } catch(e){} }
        try { document.addEventListener('click', resume, true); } catch(e){}
        try { document.addEventListener('keydown', resume, true); } catch(e){}
        try { document.addEventListener('pointerdown', resume, true); } catch(e){}
        try {
          var ov = document.createElement('div');
          ov.id = 'audio-overlay';
          ov.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(0,0,0,.6);color:#fff;font:14px system-ui;z-index:9999';
          ov.textContent = 'Click to enable sound';
          document.body.appendChild(ov);
          function check(){ try{ var ac = window.myApp && window.myApp.audioContext; if (ac && ac.state === 'running') { try{ ov.remove(); }catch(e){} document.removeEventListener('click', handler, true); document.removeEventListener('pointerdown', handler, true); document.removeEventListener('keydown', handler, true); } }catch(e){} }
          function handler(){ resume(); check(); }
          document.addEventListener('click', handler, true);
          document.addEventListener('pointerdown', handler, true);
          document.addEventListener('keydown', handler, true);
          setTimeout(check, 1500);
        } catch(e){}
      })();
    <\/script>
  </body></html>`;
  iframe.srcdoc = html;
  container.appendChild(iframe);

  try {
    function parentResume() { try { var host = iframe.contentWindow; var ac = host && host.myApp && host.myApp.audioContext; if (host && host.myApp && !host.myApp.audioInited) { host.myApp.initAudio(); } if (ac && ac.state !== 'running') ac.resume(); } catch (e) { } }
    document.addEventListener('click', parentResume, true);
    document.addEventListener('pointerdown', parentResume, true);
    document.addEventListener('keydown', parentResume, true);
  } catch (e) { }

  setTimeout(() => { try { attachInnerKeyMapper(iframe.contentWindow); } catch { } }, 1800);
  setTimeout(() => { try { notifyEmulatorResize(); } catch { } }, 2000);
}

async function startN64FromUrl(url, theme) {
  mountN64(theme, url);
}

async function startN64FromFile(file, theme) {
  const url = URL.createObjectURL(file);
  mountN64(theme, url);
}

function mountDS(theme, romUrl) {
  const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  container.innerHTML = '';
  const iframe = document.createElement('iframe');
  iframe.allow = 'gamepad; autoplay; fullscreen';
  iframe.setAttribute('allowfullscreen', 'true');
  iframe.setAttribute('frameborder', '0');
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>
    html,body{height:100%;margin:0;background:#000}
    #wrap{position:absolute;inset:0;display:flex;align-items:center;justify-content:center}
    desmond-player{display:block;width:100%;height:100%}
  </style></head><body>
    <div id="wrap"><desmond-player></desmond-player></div>
    <script src="desmond.js"></script>
    <script>
      (function(){
        var u = ${JSON.stringify(romUrl)};
        function go(){ try { var p = document.querySelector('desmond-player'); if(p && typeof p.loadURL==='function'){ p.loadURL(u); } } catch(e){} }
        if (document.readyState === 'loading') { document.addEventListener('DOMContentLoaded', go); } else { go(); }
      })();
    <\/script>
  </body></html>`;
  iframe.srcdoc = html;
  container.appendChild(iframe);
  setTimeout(() => { try { notifyEmulatorResize(); } catch { } }, 1200);
}

async function startDSFromUrl(url, theme) {
  mountDS(theme, url);
}

async function startDSFromFile(file, theme) {
  const url = URL.createObjectURL(file);
  mountDS(theme, url);
}

async function startEmulatrixFromUrl(url, theme, innerPage) {
  const name = url.split('/').pop() || 'game.nes';
  const safeUrl = new URL(url, location.href).toString();
  try {
    const t = qs('#game-title'); if (t) t.textContent = 'Loading ' + name + '...';
    const res = await fetch(safeUrl);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = new Uint8Array(await res.arrayBuffer());
    try {
      const head = String.fromCharCode.apply(null, Array.from(data.slice(0, 64)));
      if (/git-lfs/i.test(head)) throw new Error('ROM not available in deployment');
    } catch { }
    setEmulatrixGlobals(name, data);
    mountEmulatrix(theme, innerPage);
  } catch (e) {
    { const t = qs('#game-title'); if (t) t.textContent = 'Failed to load ROM (' + e.message + ')'; }
  }
}

async function startEmulatrixFromFile(file, theme, innerPage) {
  const data = new Uint8Array(await file.arrayBuffer());
  setEmulatrixGlobals(file.name || 'game.nes', data);
  mountEmulatrix(theme, innerPage);
}

function setupNavigation() {
  qsa('.switch-btn').forEach(btn => {
    btn.addEventListener('click', () => showRoom(btn.dataset.room));
  });

  const arcadeList = qs('#arcade-list');
  const consoleList = qs('#console-list');
  arcadeList.addEventListener('click', (e) => {
    const el = e.target.closest('.retro-frame');
    if (!el) return;
    state.selectedGame = { name: el.dataset.name, core: el.dataset.core, rom: el.dataset.rom, aspect: el.dataset.aspect };
    toGameView('arcade');
  });
  consoleList.addEventListener('click', (e) => {
    const el = e.target.closest('.cartridge');
    if (!el) return;
    state.selectedGame = { name: el.dataset.name, core: el.dataset.core, rom: el.dataset.rom, aspect: el.dataset.aspect };
    toGameView('console');
  });

  { const b = qs('#back-to-room'); if (b) b.addEventListener('click', backToRoom); }

  function getFsContainer() {
    return state.theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
  }
  function getFsIframe() {
    return getFsContainer()?.querySelector('iframe');
  }
  async function enterFullscreen(el) {
    try {
      if (el.requestFullscreen) { try { return await el.requestFullscreen(); } catch { return; } }
      if (el.webkitRequestFullscreen) return el.webkitRequestFullscreen();
      if (el.msRequestFullscreen) return el.msRequestFullscreen();
    } catch { }
  }
  async function exitFullscreen() {
    try {
      if (document.exitFullscreen) return document.exitFullscreen();
      if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
      if (document.msExitFullscreen) return document.msExitFullscreen();
    } catch { }
  }
  function isFullscreen() {
    return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
  }
  function updateFsUI() {
    const active = isFullscreen();
    const btn = qs('#fullscreen-btn');
    if (btn) {
      btn.textContent = active ? 'Exit Fullscreen' : 'Fullscreen';
      btn.classList.toggle('active', active);
    }
    const appEl = qs('#view-container') || qs('#app');
    if (appEl) appEl.classList.toggle('is-fullscreen', active);
    document.body.classList.toggle('is-fullscreen', active);
    document.documentElement.classList.toggle('is-fullscreen', active);
    setBezel();
    notifyEmulatorResize();
    setTimeout(focusEmulator, 50);
    ensureFsControls(active);

    if (!active && state.currentView === 'game') {
      backToRoom();
    }
  }
  ['fullscreenchange', 'webkitfullscreenchange', 'msfullscreenchange'].forEach(evt => {
    document.addEventListener(evt, updateFsUI);
  });
  ['fullscreenerror', 'webkitfullscreenerror', 'msfullscreenerror'].forEach(evt => {
    document.addEventListener(evt, () => {
      console.warn('Fullscreen error');
    });
  });
  { const fsBtn = qs('#fullscreen-btn'); if (fsBtn) { fsBtn.addEventListener('click', async () => { const el = qs('#view-container') || qs('#app') || document.documentElement; if (!el) return; if (isFullscreen()) await exitFullscreen(); else await enterFullscreen(el); updateFsUI(); }); } }
  { const tvFsBtn = qs('#fullscreen-tv-btn'); if (tvFsBtn) { tvFsBtn.addEventListener('click', async () => { const el = qs('#view-container') || qs('#app') || document.documentElement; if (!el) return; if (isFullscreen()) await exitFullscreen(); else await enterFullscreen(el); updateFsUI(); }); } }

  const videoBtn = qs('#video-btn');
  const videoModal = qs('#video-modal');
  const videoClose = qs('#video-close');
  const scaleSelect = qs('#scale-mode');
  function openVideo() { videoModal.classList.remove('hidden'); }
  function closeVideo() { videoModal.classList.add('hidden'); }
  function setScaleMode(mode) {
    const m = mode === 'stretch' ? 'stretch' : 'fit';
    document.documentElement.setAttribute('data-scale-mode', m);
    try { localStorage.setItem('scale-mode', m); } catch { }
    notifyEmulatorResize();
  }
  try {
    const saved = localStorage.getItem('scale-mode');
    if (saved) { scaleSelect.value = saved; setScaleMode(saved); }
  } catch { }
  if (videoBtn && videoModal) videoBtn.addEventListener('click', openVideo);
  if (videoClose && videoModal) videoClose.addEventListener('click', closeVideo);
  if (scaleSelect) scaleSelect.addEventListener('change', (e) => setScaleMode(e.target.value));

  function debounce(fn, ms) {
    let t;
    return function () { clearTimeout(t); const a = arguments; t = setTimeout(() => fn.apply(this, a), ms); };
  }
  const debouncedResize = debounce(() => {
    try {
      const r = getComputedStyle(document.documentElement);
      const aw = parseFloat(r.getPropertyValue('--emu-aspect-w')) || 4;
      const ah = parseFloat(r.getPropertyValue('--emu-aspect-h')) || 3;
      const wrap = getFsContainer();
      if (wrap) wrap.style.setProperty('--emu-aspect', `${aw} / ${ah}`);
      notifyEmulatorResize();
    } catch { }
  }, 140);
  window.addEventListener('resize', debouncedResize);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) setTimeout(debouncedResize, 50); });

  function notifyEmulatorResize() {
    try {
      const host = getFsContainer()?.querySelector('iframe');
      const hostWin = host?.contentWindow;
      hostWin?.dispatchEvent(new hostWin.Event('resize'));
      const inner = hostWin?.document?.getElementById('container');
      const innerWin = inner?.contentWindow || hostWin;
      innerWin?.dispatchEvent(new innerWin.Event('resize'));
      try {
        const rect = host?.getBoundingClientRect();
        if (rect && innerWin?.setContainerSize) innerWin.setContainerSize(Math.floor(rect.width), Math.floor(rect.height));
      } catch { }
      if (innerWin?.resizeEmulatorCanvas) innerWin.resizeEmulatorCanvas();
    } catch (e) {
      console.warn('Resize notify failed', e);
    }
  }

  try { window.notifyEmulatorResize = notifyEmulatorResize; } catch (e) { }

  const GamepadBridge = (() => {
    let running = false;
    let pressed = new Set();
    let padType = 'generic';
    function base() { return String((state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '')).toLowerCase(); }
    function core() { return String(state.selectedGame?.core || '').toLowerCase(); }
    function isSF() { const b = base(); return ['ssf2t', 'mvsc'].includes(b); }
    function detectPadType() {
      try {
        const gp = navigator.getGamepads ? navigator.getGamepads()[0] : null;
        const id = String(gp?.id || '').toLowerCase();
        if (/sony|dualshock|dualsense|wireless controller/.test(id)) return 'ps';
        if (/xbox|xinput/.test(id)) return 'xbox';
        if (/nintendo|switch|joy-con|pro controller/.test(id)) return 'switch';
        return 'generic';
      } catch { return 'generic'; }
    }
    function ensurePadOverlay() {
      // Disabled: do not create or show the pad overlay at all
      return;
    }
    function ensureGpDebugPanel() {
      let el = document.getElementById('gp-debug');
      if (!el) {
        const style = document.createElement('style');
        style.textContent = `.gp-debug{position:fixed;left:12px;top:12px;background:rgba(12,16,24,.92);color:#e6e8ee;border:1px solid rgba(255,255,255,.18);border-radius:10px;padding:8px 10px;font:12px/1.2 system-ui;z-index:9999;min-width:240px;max-width:60vw}
        .gp-debug h4{margin:0 0 6px 0;font-weight:600;font-size:12px}
        .gp-debug pre{margin:0;white-space:pre-wrap}`;
        document.head.appendChild(style);
        el = document.createElement('div');
        el.id = 'gp-debug';
        el.className = 'gp-debug';
        el.style.display = 'none';
        el.innerHTML = `<h4>Gamepad</h4><pre id="gp-debug-pre">No gamepad</pre>`;
        document.body.appendChild(el);
        window.addEventListener('keydown', (e) => { if (e.key === 'F8') { el.style.display = (el.style.display === 'none' ? 'block' : 'none'); } });
      }
      return el;
    }
    function updateGpDebug(gp) {
      const el = ensureGpDebugPanel();
      if (el.style.display === 'none') return;
      const pre = el.querySelector('#gp-debug-pre');
      const axes = gp?.axes ? Array.from(gp.axes).map(v => v.toFixed(2)) : [];
      const btns = gp?.buttons ? Array.from(gp.buttons).map((b, i) => `${i}:${(b.pressed ? '1' : '0')}/${(b.value || 0).toFixed(2)}`) : [];
      const id = String(gp?.id || '');
      pre.textContent = `id: ${id}\nconnected: ${!!gp}\naxes: [${axes.join(', ')}]\nbuttons: [${btns.join(', ')}]`;
    }
    function map() {
      const c = core();
      if (c === 'mame32' || c === 'mame2003') {
        if (isSF()) {
          // PlayStation layout semantics mapped to common MAME 6-button defaults
          return { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', square: 'KeyQ', triangle: 'KeyW', r1: 'KeyE', cross: 'KeyA', circle: 'KeyS', r2: 'KeyD', start: 'Enter', select: 'Digit1' };
        }
        return { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'KeyA', b: 'KeyS', x: 'KeyQ', y: 'KeyW', lb: 'KeyD', rb: 'KeyE', start: 'Enter', select: 'Digit1' };
      }
      if (c === 'n64') {
        // Map to n64wasm defaults: analog WASD, C keys IJKL, A Space, B F, Z ShiftLeft, R R, Start Enter
        return {
          up: 'KeyW', down: 'KeyS', left: 'KeyA', right: 'KeyD',
          a: 'Space', b: 'KeyF', x: 'KeyK', y: 'KeyI',
          lb: 'ShiftLeft', rb: 'KeyR', start: 'Enter', select: 'Digit1'
        };
      }
      return { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', a: 'KeyX', b: 'KeyZ', x: 'KeyX', y: 'KeyZ', lb: 'ShiftRight', rb: 'Enter', start: 'Enter', select: 'ShiftRight' };
    }
    function key(code, down) {
      const type = down ? 'keydown' : 'keyup';
      const k = codeToKey(code);
      const kc = keyCodeFromCode(code);
      const ev = new KeyboardEvent(type, { code: code, key: k, bubbles: true, cancelable: true });
      try { Object.defineProperty(ev, 'keyCode', { get: () => kc }); } catch { }
      try { Object.defineProperty(ev, 'which', { get: () => kc }); } catch { }
      try {
        const targetWin = getEmulatorTargetWindow();
        const targetDoc = targetWin?.document;
        if (typeof targetWin.sendVirtualKey === 'function') {
          targetWin.sendVirtualKey(type, code);
        } else {
          const canvas = targetDoc?.getElementById('canvas');
          try { canvas?.focus(); } catch { }
          try { targetDoc?.body?.dispatchEvent(ev); } catch { }
          try { canvas?.dispatchEvent(ev); } catch { }
          try { targetDoc?.dispatchEvent(ev); } catch { }
          try { targetWin?.dispatchEvent(ev); } catch { }
        }
      } catch {
        window.dispatchEvent(ev);
      }
    }
    function tick() {
      if (!running) return;
      const c = core();
      if (c === 'ds' || c === 'nds') { requestAnimationFrame(tick); return; }
      const tWin = (() => { try { return getEmulatorTargetWindow(); } catch { return window; } })();
      const pads = (tWin.navigator?.getGamepads && tWin.navigator.getGamepads()) || (navigator.getGamepads && navigator.getGamepads()) || (navigator.webkitGetGamepads && navigator.webkitGetGamepads()) || [];
      const gp = pads && Array.from(pads).find(p => p && p.connected) || pads[0] || null;
      updateGpDebug(gp);
      const mp = map();
      const cur = new Set();
      const overlay = document.getElementById('pad-overlay');
      function setActive(k, on) { const el = overlay?.querySelector(`[data-k="${k}"]`); if (el) el.classList.toggle('active', !!on); }
      function isDown(btn) { return !!(btn && (btn.pressed || (btn.value || 0) > 0.5)); }
      if (gp) {
        if (gp.axes[0] < -0.5) cur.add(mp.left);
        if (gp.axes[0] > 0.5) cur.add(mp.right);
        if (gp.axes[1] < -0.5) cur.add(mp.up);
        if (gp.axes[1] > 0.5) cur.add(mp.down);
        if (isDown(gp.buttons[12])) cur.add(mp.up);
        if (isDown(gp.buttons[13])) cur.add(mp.down);
        if (isDown(gp.buttons[14])) cur.add(mp.left);
        if (isDown(gp.buttons[15])) cur.add(mp.right);
        if (isSF()) {
          setActive('lp', false); setActive('mp', false); setActive('hp', false); setActive('lk', false); setActive('mk', false); setActive('hk', false); setActive('start', false);
          if (isDown(gp.buttons[2])) { cur.add(mp.square); setActive('lp', true); }
          if (isDown(gp.buttons[3])) { cur.add(mp.triangle); setActive('mp', true); }
          if (isDown(gp.buttons[5])) { cur.add(mp.r1); setActive('hp', true); }
          if (isDown(gp.buttons[0])) { cur.add(mp.cross); setActive('lk', true); }
          if (isDown(gp.buttons[1])) { cur.add(mp.circle); setActive('mk', true); }
          if (isDown(gp.buttons[7])) { cur.add(mp.r2); setActive('hk', true); }
          if (isDown(gp.buttons[9])) { cur.add(mp.start); setActive('start', true); }
        } else {
          if (isDown(gp.buttons[0])) cur.add(mp.a);
          if (isDown(gp.buttons[1])) cur.add(mp.b);
          if (isDown(gp.buttons[2])) cur.add(mp.x);
          if (isDown(gp.buttons[3])) cur.add(mp.y);
          if (isDown(gp.buttons[4])) cur.add(mp.lb);
          if (isDown(gp.buttons[5])) cur.add(mp.rb);
          if (isDown(gp.buttons[9])) cur.add(mp.start);
          if (isDown(gp.buttons[8])) cur.add(mp.select);
        }
        // Coin on guide/home/platform buttons
        const coinCode = 'Digit1';
        if (isDown(gp.buttons[16])) cur.add(coinCode);
        if (isDown(gp.buttons[17])) cur.add(coinCode);
        if (gp.buttons.length > 18 && isDown(gp.buttons[18])) cur.add(coinCode);
      }
      cur.forEach(code => { if (!pressed.has(code)) { pressed.add(code); key(code, true); } });
      Array.from(pressed).forEach(code => { if (!cur.has(code)) { pressed.delete(code); key(code, false); } });
      requestAnimationFrame(tick);
    }
    function start() { if (running) return; padType = detectPadType(); ensurePadOverlay(); ensureGpDebugPanel(); running = true; pressed.clear(); requestAnimationFrame(tick); }
    function stop() { running = false; pressed.clear(); }
    return { start, stop };
  })();
  try { window.GamepadBridge = GamepadBridge; } catch { }
  // Fallback: auto-start bridge when any gamepad is detected even if no event fires
  try {
    let gpScanTimer = setInterval(() => {
      try {
        const pads = (navigator.getGamepads && navigator.getGamepads()) || (navigator.webkitGetGamepads && navigator.webkitGetGamepads()) || [];
        const gp = pads && Array.from(pads).find(p => p && p.connected);
        if (gp) { GamepadBridge.start(); clearInterval(gpScanTimer); gpScanTimer = null; showGpNotice('Controller connected: ' + detectPadTypeFromId(gp.id)); }
      } catch { }
    }, 1000);
  } catch { }
  function detectPadTypeFromId(id) { try { const s = String(id || '').toLowerCase(); if (/sony|dualshock|dualsense|wireless controller/.test(s)) return 'PlayStation'; if (/xbox|xinput/.test(s)) return 'Xbox'; if (/nintendo|switch|joy-con|pro controller/.test(s)) return 'Switch'; return 'Controller'; } catch { return 'Controller'; } }
  function ensureGpNotice() { let el = document.getElementById('gp-notice'); if (!el) { const st = document.createElement('style'); st.id = 'gp-notice-style'; st.textContent = `.gp-notice{position:fixed;left:50%;top:16px;transform:translateX(-50%);background:rgba(20,24,36,.92);color:#e6e8ee;border:1px solid rgba(255,255,255,.18);border-radius:12px;padding:10px 14px;font:13px/1.2 system-ui;z-index:10000;display:none}.gp-notice.visible{display:block}`; document.head.appendChild(st); el = document.createElement('div'); el.id = 'gp-notice'; el.className = 'gp-notice'; document.body.appendChild(el); } return el; }
  function showGpNotice(msg) { const el = ensureGpNotice(); el.textContent = msg; el.classList.add('visible'); setTimeout(() => { el.classList.remove('visible'); }, 3000); }
  try { window.addEventListener('gamepadconnected', (e) => { try { GamepadBridge.start(); showGpNotice('Controller connected: ' + detectPadTypeFromId(e?.gamepad?.id)); } catch { } }); } catch { }
  try { window.addEventListener('gamepaddisconnected', (e) => { try { GamepadBridge.stop(); showGpNotice('Controller disconnected'); } catch { } }); } catch { }

  function focusEmulator() {
    try {
      const host = getFsContainer()?.querySelector('iframe');
      const hostWin = host?.contentWindow;
      const inner = hostWin?.document?.getElementById('container');
      const innerWin = inner?.contentWindow || hostWin;
      innerWin?.focus();
      const canvas = innerWin?.document?.getElementById('canvas');
      canvas?.focus();
      try { innerWin?.RA?.context?.resume?.(); } catch { }
      try { innerWin?.Module?.SDL2?.audioContext?.resume?.(); } catch { }
    } catch (e) {
      console.warn('Focus emulator failed', e);
    }
  }

  function setBezel() {
    try {
      const r = getComputedStyle(document.documentElement);
      const aw = parseFloat(r.getPropertyValue('--emu-aspect-w')) || 4;
      const ah = parseFloat(r.getPropertyValue('--emu-aspect-h')) || 3;
      const vertical = ah > aw;
      const name = (state.selectedGame?.name || '').toLowerCase();
      const showBezel = false;
      const app = qs('#view-container') || qs('#app') || document.body;
      if (app) app.classList.toggle('has-bezel', showBezel);
      if (!showBezel) { clearBezelImage(); return; }
      document.documentElement.style.setProperty('--bezel-bg', '#2a2d33');
      document.documentElement.style.setProperty('--bezel-bg2', '#23262d');
      document.documentElement.style.setProperty('--bezel-stroke', '#0e1016');
    } catch { }
  }

  async function setPacmanBezelImage() {
    try {
      const url = 'assets/pacman_bezel.png';
      const res = await fetch(url, { cache: 'no-store' });
      if (res.ok) {
        document.documentElement.style.setProperty('--bezel-image-url', `url(${url})`);
        const app = qs('#view-container') || qs('#app');
        app?.classList.add('bezel-img');
      } else {
        clearBezelImage();
      }
    } catch {
      clearBezelImage();
    }
  }
  function clearBezelImage() {
    document.documentElement.style.removeProperty('--bezel-image-url');
    const app = qs('#view-container') || qs('#app');
    app?.classList.remove('bezel-img');
  }

  {
    const romInput = qs('#rom-input');
    if (romInput) {
      romInput.addEventListener('change', (e) => {
        const file = e.target.files?.[0];
        if (!file || !state.selectedGame) return;
        startEmulator(state.selectedGame.core, file, state.theme);
      });
    }
  }

  const accountModal = qs('#account-modal');
  function openAccountModal() {
    accountModal.classList.remove('hidden');
    const defGame = window.ROMNAME || state.selectedGame?.rom || '';
    const sg = qs('#saves-game');
    if (sg && !sg.value) sg.value = defGame;
    Account.uiRefresh();
  }
  function closeAccountModal() {
    accountModal.classList.add('hidden');
  }
  const accountBtn = qs('#account-btn');
  const accountClose = qs('#account-close');
  if (accountBtn) accountBtn.addEventListener('click', openAccountModal);
  if (accountClose) accountClose.addEventListener('click', closeAccountModal);

  qsa('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      qsa('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      qsa('.tab-pane').forEach(p => p.classList.remove('active'));
      const pane = qs('#tab-' + btn.dataset.tab);
      if (pane) pane.classList.add('active');
      if (btn.dataset.tab === 'controllers') renderControllerMapping();
    });
  });

  function normCode(s) {
    return String(s || '').toUpperCase().replace(/\s+/g, '');
  }
  const loginBtn = qs('#login-btn');
  const createBtn = qs('#create-btn');
  const logoutBtn = qs('#logout-btn');
  const loginCode = qs('#login-code');
  const loginWarn = qs('#login-warning');
  if (loginBtn) loginBtn.addEventListener('click', async () => {
    try {
      const code = normCode(loginCode?.value);
      await Account.login(code);
      Account.uiRefresh();
    } catch (e) {
      if (loginWarn) loginWarn.textContent = String(e.message || e);
    }
  });
  if (createBtn) createBtn.addEventListener('click', async () => {
    try {
      const code = await Account.createAccount();
      loginCode.value = code;
      await Account.login(code);
      Account.uiRefresh();
    } catch (e) {
      if (loginWarn) loginWarn.textContent = String(e.message || e);
    }
  });
  if (logoutBtn) logoutBtn.addEventListener('click', () => {
    Account.logout();
    Account.uiRefresh();
  });

  const saveCap = qs('#save-capture');
  const saveLoad = qs('#save-load');
  const savesGame = qs('#saves-game');
  const savesSlot = qs('#saves-slot');
  if (saveCap) saveCap.addEventListener('click', async () => {
    const g = (savesGame?.value || window.ROMNAME || '').replace(/\.[^/.]+$/, '');
    const slot = parseInt(savesSlot?.value || '0', 10) || 0;
    await Account.saveState(g, slot);
    await Account.uiRefresh();
  });
  if (saveLoad) saveLoad.addEventListener('click', async () => {
    const g = (savesGame?.value || window.ROMNAME || '').replace(/\.[^/.]+$/, '');
    const slot = parseInt(savesSlot?.value || '0', 10) || 0;
    await Account.loadState(g, slot);
  });

  const friendAdd = qs('#friend-add');
  const friendCode = qs('#friend-code');
  const msgSend = qs('#message-send');
  const msgText = qs('#message-text');
  if (friendAdd) friendAdd.addEventListener('click', async () => {
    const code = normCode(friendCode?.value);
    if (!code) return;
    await Account.addFriend(code);
    await Account.uiRefresh();
  });
  if (msgSend) msgSend.addEventListener('click', async () => {
    const code = normCode(friendCode?.value);
    const text = String(msgText?.value || '').trim();
    if (!code || !text) return;
    await Account.sendMessage(code, text);
    await Account.uiRefresh();
  });

  const profUpdate = qs('#profile-update');
  if (profUpdate) profUpdate.addEventListener('click', async () => {
    const profile = {
      displayName: String(qs('#display-name')?.value || ''),
      statusMessage: String(qs('#status-message')?.value || ''),
      avatarUrl: String(qs('#avatar-url')?.value || ''),
    };
    await Account.updateProfile(profile);
    await Account.uiRefresh();
  });

  const backupExport = qs('#backup-export');
  const backupImport = qs('#backup-import');
  if (backupExport) backupExport.addEventListener('click', async () => {
    const data = await Account.exportAll();
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arcade_backup_' + new Date().toISOString().replace(/[:.]/g, '-') + '.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 0);
  });
  if (backupImport) backupImport.addEventListener('change', async (e) => {
    const f = e.target.files?.[0];
    if (!f) return;
    const text = await f.text();
    const json = JSON.parse(text);
    await Account.importAll(json);
    await Account.uiRefresh();
  });

  function renderControllerMapping() {
    const grid = qs('#controller-mapping');
    if (!grid) return;
    const actions = ['Up', 'Down', 'Left', 'Right', 'A', 'B', 'Start', 'Select'];
    const defaults = { Up: 'KeyW', Down: 'KeyS', Left: 'KeyA', Right: 'KeyD', A: 'Space', B: 'KeyZ', Start: 'Enter', Select: 'ShiftRight' };
    grid.innerHTML = actions.map(a => {
      const id = 'map-' + a.toLowerCase();
      const val = defaults[a] || '';
      return `<label>${a}<input id="${id}" value="${val}" /></label>`;
    }).join('');
    const cg = qs('#controller-game');
    const g = (state.selectedGame?.rom || window.ROMNAME || '').replace(/\.[^/.]+$/, '');
    if (cg) cg.value = g;
    const chk = qs('#profile-game-only');
    if (chk) chk.checked = !!g;
    if (g && Account && Account.getGameController) {
      Account.getGameController(g).then(map => {
        if (!map) return;
        qs('#map-up').value = map.up || qs('#map-up').value;
        qs('#map-down').value = map.down || qs('#map-down').value;
        qs('#map-left').value = map.left || qs('#map-left').value;
        qs('#map-right').value = map.right || qs('#map-right').value;
        qs('#map-a').value = map.a || qs('#map-a').value;
        qs('#map-b').value = map.b || qs('#map-b').value;
        qs('#map-start').value = map.start || qs('#map-start').value;
        qs('#map-select').value = map.select || qs('#map-select').value;
      });
    }
  }

  function gameActionTemplate() {
    const base = String((state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '')).toLowerCase();
    const core = String(state.selectedGame?.core || '').toLowerCase();
    if (core === 'n64') {
      return [
        { name: 'Analog Up', target: 'KeyW', default: 'KeyW' },
        { name: 'Analog Down', target: 'KeyS', default: 'KeyS' },
        { name: 'Analog Left', target: 'KeyA', default: 'KeyA' },
        { name: 'Analog Right', target: 'KeyD', default: 'KeyD' },
        { name: 'C-Up', target: 'KeyI', default: 'KeyI' },
        { name: 'C-Down', target: 'KeyK', default: 'KeyK' },
        { name: 'C-Left', target: 'KeyJ', default: 'KeyJ' },
        { name: 'C-Right', target: 'KeyL', default: 'KeyL' },
        { name: 'A', target: 'KeyX', default: 'Space' },
        { name: 'B', target: 'KeyF', default: 'KeyF' },
        { name: 'Z', target: 'ShiftLeft', default: 'ShiftLeft' },
        { name: 'R', target: 'KeyR', default: 'KeyR' },
        { name: 'Start', target: 'Enter', default: 'Enter' },
      ];
    }
    if (core === 'mame32' || core === 'mame2003') {
      if (base === 'mario') {
        return [
          { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
          { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
          { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
          { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
          { name: 'Jump', target: 'KeyS', default: 'Space' },
          { name: 'Start', target: 'Enter', default: 'Enter' },
          { name: 'Coin', target: 'Digit1', default: 'Digit1' },
          { name: 'Service', target: 'F2', default: 'KeyP' },
        ];
      }
      if (base === 'ssf2t') {
        return [
          { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
          { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
          { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
          { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
          { name: 'LP', target: 'KeyU', default: 'KeyQ' },
          { name: 'MP', target: 'KeyI', default: 'KeyW' },
          { name: 'HP', target: 'KeyO', default: 'KeyE' },
          { name: 'LK', target: 'KeyJ', default: 'KeyA' },
          { name: 'MK', target: 'KeyK', default: 'KeyS' },
          { name: 'HK', target: 'KeyL', default: 'KeyD' },
          { name: 'Start', target: 'Enter', default: 'Enter' },
          { name: 'Coin', target: 'Digit1', default: 'Digit1' },
          { name: 'Service', target: 'F2', default: 'KeyP' },
        ];
      }
      if (base === 'mvsc') {
        return [
          { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
          { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
          { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
          { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
          { name: 'LP', target: 'KeyU', default: 'KeyQ' },
          { name: 'MP', target: 'KeyI', default: 'KeyW' },
          { name: 'HP', target: 'KeyO', default: 'KeyE' },
          { name: 'LK', target: 'KeyJ', default: 'KeyA' },
          { name: 'MK', target: 'KeyK', default: 'KeyS' },
          { name: 'HK', target: 'KeyL', default: 'KeyD' },
          { name: 'Start', target: 'Enter', default: 'Enter' },
          { name: 'Coin', target: 'Digit1', default: 'Digit1' },
          { name: 'Service', target: 'F2', default: 'KeyP' },
        ];
      }
      if (base === 'simpsons2p') {
        return [
          { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
          { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
          { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
          { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
          { name: 'Hit', target: 'KeyA', default: 'KeyJ' },
          { name: 'Jump', target: 'KeyS', default: 'Space' },
          { name: 'Start', target: 'Enter', default: 'Enter' },
          { name: 'Coin', target: 'Digit1', default: 'Digit1' },
          { name: 'Service', target: 'F2', default: 'KeyP' },
        ];
      }
      
      if (base === 'invaders') {
        return [
          { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
          { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
          { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
          { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
          { name: 'Fire', target: 'KeyS', default: 'Space' },
          { name: 'Start', target: 'Enter', default: 'Enter' },
          { name: 'Coin', target: 'Digit5', default: 'Digit1' },
          { name: 'Service', target: 'F2', default: 'KeyP' },
        ];
      }
      if (base === 'dkong' || base === 'dkongjr') {
        return [
          { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
          { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
          { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
          { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
          { name: 'Jump', target: 'KeyS', default: 'Space' },
          { name: 'Start', target: 'Enter', default: 'Enter' },
          { name: 'Coin', target: 'Digit1', default: 'Digit1' },
        ];
      }
      return [
        { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
        { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
        { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
        { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
        { name: 'Fire', target: 'KeyS', default: 'Space' },
        { name: 'Start', target: 'Enter', default: 'Enter' },
        { name: 'Coin', target: 'Digit1', default: 'Digit1' },
      ];
    }
    return [
      { name: 'Up', target: 'ArrowUp', default: 'KeyW' },
      { name: 'Down', target: 'ArrowDown', default: 'KeyS' },
      { name: 'Left', target: 'ArrowLeft', default: 'KeyA' },
      { name: 'Right', target: 'ArrowRight', default: 'KeyD' },
      { name: 'A', target: 'KeyX', default: 'Space' },
      { name: 'B', target: 'KeyZ', default: 'KeyZ' },
      { name: 'Start', target: 'Enter', default: 'Enter' },
      { name: 'Select', target: 'ShiftRight', default: 'ShiftRight' },
    ];
  }

  function defaultGameMappingFromTemplate(template) {
    const out = {};
    template.forEach(it => { if (it.default && it.target) out[it.default] = it.target; });
    return out;
  }

  async function renderGameControllerPanel() {
    const panel = qs('#controller-panel');
    const grid = qs('#controller-grid');
    if (!panel || !grid) return;
    const tpl = gameActionTemplate();
    grid.innerHTML = tpl.map(it => {
      const id = 'gc-' + it.name.toLowerCase();
      return `<div class="panel-item"><label>${it.name}</label><input id="${id}" value="${it.default}" /></div>`;
    }).join('');
    tpl.forEach(it => {
      const id = 'gc-' + it.name.toLowerCase();
      const el = qs('#' + id);
      if (!el) return;
      el.addEventListener('keydown', (e) => { e.preventDefault(); e.stopPropagation(); el.value = e.code; });
    });
    const g = (state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '');
    const saved = await Account.getGameController(g);
    if (saved) {
      tpl.forEach(it => {
        const id = 'gc-' + it.name.toLowerCase();
        const input = Object.keys(saved).find(k => saved[k] === it.target);
        const el = qs('#' + id);
        if (el && input) el.value = input;
      });
    }
  }

  function openControllerPanel() { qs('#controller-panel')?.classList.remove('hidden'); }
  function closeControllerPanel() { qs('#controller-panel')?.classList.add('hidden'); }
  qs('#controller-btn')?.addEventListener('click', () => { renderGameControllerPanel(); openControllerPanel(); });
  qs('#controller-close')?.addEventListener('click', () => closeControllerPanel());
  qs('#controller-save')?.addEventListener('click', async () => {
    const tpl = gameActionTemplate();
    const mapping = {};
    tpl.forEach(it => {
      const id = 'gc-' + it.name.toLowerCase();
      const raw = String(qs('#' + id)?.value || '').trim();
      const val = valueToCode(raw);
      if (val) mapping[val] = it.target;
    });
    const g = (state.selectedGame?.rom || '').replace(/\.[^/.]+$/, '');
    if (g) await Account.saveGameController(g, mapping);
    if (KeyMapper && KeyMapper.set) KeyMapper.set(mapping);
    closeControllerPanel();
  });
  const profSave = qs('#profile-save');
  if (profSave) profSave.addEventListener('click', async () => {
    const name = String(qs('#profile-name')?.value || '').trim();
    const gameOnly = !!qs('#profile-game-only')?.checked;
    const g = String(qs('#controller-game')?.value || (state.selectedGame?.rom || '')).replace(/\.[^/.]+$/, '');
    if (!name && !gameOnly) return;
    const mapping = {
      up: String(qs('#map-up')?.value || ''),
      down: String(qs('#map-down')?.value || ''),
      left: String(qs('#map-left')?.value || ''),
      right: String(qs('#map-right')?.value || ''),
      a: String(qs('#map-a')?.value || ''),
      b: String(qs('#map-b')?.value || ''),
      start: String(qs('#map-start')?.value || ''),
      select: String(qs('#map-select')?.value || ''),
    };
    if (gameOnly && g) {
      const tpl = gameActionTemplate();
      const idx = {};
      tpl.forEach(it => { idx[it.name.toLowerCase()] = it.target; });
      const m2 = {};
      Object.entries(mapping).forEach(([k, v]) => {
        const code = valueToCode(v);
        const target = idx[k];
        if (code && target) m2[code] = target;
      });
      await Account.saveGameController(g, m2);
    } else {
      await Account.saveProfile(name, mapping);
    }
    await Account.uiRefresh();
  });
}

setupNavigation();
loadGames().then(() => {
  renderRooms();
  wireScreenImages();
  showRoom('arcade');
});

async function loadGames() {
  try {
    const res = await fetch('games.json', { cache: 'no-store' });
    if (!res.ok) throw new Error('games.json not found');
    const json = await res.json();
    state.games.arcade = Array.isArray(json.arcade) ? json.arcade : DEFAULT_GAMES.arcade;
    state.games.console = Array.isArray(json.console) ? json.console : DEFAULT_GAMES.console;
  } catch (e) {
    state.games.arcade = DEFAULT_GAMES.arcade;
    state.games.console = DEFAULT_GAMES.console;
  }
}

function renderRooms() {
  const arcadeList = qs('#arcade-list');
  const consoleList = qs('#console-list');
  arcadeList.innerHTML = state.games.arcade.map(g => cabinetHTML(g)).join('');
  consoleList.innerHTML = state.games.console.map(g => gameBoxHTML(g)).join('');
}

function titleImagePathFor(g) {
  const override = String(g.image || '').trim();
  if (override) return override;
  const rom = String(g.rom || '').trim();
  if (!rom) return '';
  const base = rom.replace(/\.[^/.]+$/, '');
  return `assets/titles/${base}.png`;
}

function cabinetHTML(g) {
  const img = titleImagePathFor(g);
  const content = img 
    ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(g.name)}" class="frame-img">` 
    : '<div class="frame-placeholder">Select to play</div>';
    
  return `
    <button class="retro-frame" data-core="${g.core}" data-name="${escapeHtml(g.name)}" data-rom="${escapeHtml(g.rom)}" data-aspect="${escapeHtml(g.aspect || '')}">
      <div class="frame-body">
        <div class="frame-bezel">
          ${content}
          <div class="frame-glare"></div>
        </div>
      </div>
      <div class="frame-title">${escapeHtml(g.name)}</div>
    </button>
  `;
}

function gameBoxHTML(g) {
  const img = titleImagePathFor(g);
  const labelContent = img 
    ? `<img src="${escapeHtml(img)}" alt="${escapeHtml(g.name)}" class="cart-label-img">`
    : `<span class="game-title">${escapeHtml(g.name)}</span>`;
    
  return `
    <button class="cartridge" data-core="${g.core}" data-name="${escapeHtml(g.name)}" data-rom="${escapeHtml(g.rom)}" data-aspect="${escapeHtml(g.aspect || '')}">
      <div class="cart-shell">
        <div class="cart-label-area">
          ${labelContent}
        </div>
        <div class="cart-grip-area">
          <div class="cart-grip-slot"></div>
        </div>
      </div>
      <div class="cart-text-name">${escapeHtml(g.name)}</div>
    </button>
  `;
}

function escapeHtml(s = '') {
  return String(s).replace(/[&<>"]+/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function wireScreenImages() {
  qsa('.retro-frame .frame-img, .cabinet .screen img').forEach(img => {
    const sc = img.parentElement;
    if (!sc) return;
    img.addEventListener('error', () => {
      sc.innerHTML = '<div class="frame-placeholder">Select to play</div>';
    }, { once: true });
  });
}
async function preferEmulatrix(core, path) {
  const ext = (path?.split('.').pop() || '').toLowerCase();
  const coreLower = (core || '').toLowerCase();
  const map = {
    nes: 'Emulatrix_Nintendo.htm',
    snes: 'Emulatrix_SuperNintendo.htm',
    genesis: 'Emulatrix_SegaGenesis.htm',
    gba: 'Emulatrix_GameBoyAdvance.htm',
    gb: 'Emulatrix_GameBoy.htm',
    gbc: 'Emulatrix_GameBoy.htm',
    mame2003: 'Emulatrix_MAME2003.htm',
    mame32: 'Emulatrix_MAME32.htm',
  };
  let candidate = map[coreLower];
  if (!candidate && ext === 'zip') candidate = 'Emulatrix_MAME2003.htm';
  return candidate || null;
}

// Global fullscreen helpers for overlay code outside navigation scope
function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement || document.msFullscreenElement);
}
async function exitFullscreen() {
  try {
    if (document.exitFullscreen) return document.exitFullscreen();
    if (document.webkitExitFullscreen) return document.webkitExitFullscreen();
    if (document.msExitFullscreen) return document.msExitFullscreen();
  } catch { }
}
let fsControlsTimer = null;
function ensureFsControls(active) {
  const root = document.body;
  if (!root) return;
  let bar = document.getElementById('fs-controls');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'fs-controls';
    bar.className = 'fs-controls';
    const exit = document.createElement('button');
    exit.className = 'fs-btn';
    exit.id = 'fs-exit';
    exit.textContent = 'Exit Fullscreen';
    const back = document.createElement('button');
    back.className = 'fs-btn';
    back.id = 'fs-back';
    back.textContent = 'Back';
    bar.appendChild(exit);
    bar.appendChild(back);
    root.appendChild(bar);
    exit.addEventListener('click', async () => { if (isFullscreen()) await exitFullscreen(); });
    back.addEventListener('click', () => backToRoom());
    document.addEventListener('mousemove', onFsMouseMove);
  }
  try { bar.style.display = active ? 'block' : 'none'; } catch {}
  bar.classList.toggle('visible', !!active);
  if (!active) { clearTimeout(fsControlsTimer); fsControlsTimer = null; }
}

function onFsMouseMove() {
  if (!isFullscreen()) return;
  const bar = document.getElementById('fs-controls');
  if (!bar) return;
  bar.classList.add('visible');
  if (fsControlsTimer) clearTimeout(fsControlsTimer);
  fsControlsTimer = setTimeout(() => { bar.classList.remove('visible'); }, 5000);
}
function isFocusInsideEmulator() {
  try {
    const active = document.activeElement;
    if (!active || String(active.tagName).toUpperCase() !== 'IFRAME') return false;
    const pid = active.parentElement?.id || '';
    return pid === 'emulator' || pid === 'emulator-console';
  } catch { return false; }
}
function getEmulatorTargetWindow() {
  try {
    const host = (state.theme === 'arcade' ? qs('#emulator') : qs('#emulator-console'))?.querySelector('iframe');
    const hostWin = host?.contentWindow;
    const inner = hostWin?.document?.getElementById('container');
    const innerWin = inner?.contentWindow || hostWin;
    return innerWin || window;
  } catch { return window; }
}
function codeToKey(c) {
  const m = String(c).match(/^Key([A-Z])$/); if (m) return m[1].toLowerCase();
  const d = String(c).match(/^Digit(\d)$/); if (d) return d[1];
  if (c === 'Space') return ' ';
  if (c === 'ShiftLeft' || c === 'ShiftRight') return 'Shift';
  if (c === 'ControlLeft' || c === 'ControlRight') return 'Control';
  if (c === 'AltLeft' || c === 'AltRight') return 'Alt';
  return c;
}
function keyCodeFromCode(code) {
  const s = String(code);
  const m = s.match(/^Key([A-Z])$/);
  if (m) return m[1].toUpperCase().charCodeAt(0);
  const d = s.match(/^Digit(\d)$/);
  if (d) return 48 + parseInt(d[1], 10);
  if (s === 'Space') return 32;
  if (s === 'Enter') return 13;
  if (s === 'ShiftLeft' || s === 'ShiftRight' || s === 'Shift') return 16;
  if (s === 'ControlLeft' || s === 'ControlRight' || s === 'Control') return 17;
  if (s === 'AltLeft' || s === 'AltRight' || s === 'Alt') return 18;
  if (s === 'ArrowUp') return 38;
  if (s === 'ArrowDown') return 40;
  if (s === 'ArrowLeft') return 37;
  if (s === 'ArrowRight') return 39;
  return 0;
}
function valueToCode(val) {
  const s = String(val || '').trim();
  if (!s) return '';
  if (/^Key[A-Z]$/.test(s)) return s;
  if (/^Digit\d$/.test(s)) return s;
  if (/^Arrow(Up|Down|Left|Right)$/.test(s)) return s;
  const upper = s.toUpperCase();
  if (upper.length === 1 && /[A-Z]/.test(upper)) return 'Key' + upper;
  if (/^[0-9]$/.test(s)) return 'Digit' + s;
  if (/^SPACE$/i.test(s)) return 'Space';
  if (/^ENTER$/i.test(s)) return 'Enter';
  if (/^(CTRL|CONTROL|LCTRL|LEFTCTRL|LEFT\s*CONTROL)$/i.test(s)) return 'ControlLeft';
  if (/^(RCTRL|RIGHTCTRL|RIGHT\s*CONTROL)$/i.test(s)) return 'ControlRight';
  return s;
}
const KeyMapper = (() => {
  let mapping = null;
  let forwarding = false;
  function set(map) { mapping = map || null; }
  function translate(code) { if (!mapping) return code; const k = Object.keys(mapping).find(k => k.toLowerCase() === code.toLowerCase()); return k ? mapping[k] : code; }
  function onEv(e) {
    try {
      const tgt = e.target;
      const isEditable = !!tgt && (tgt.isContentEditable || (/^(INPUT|TEXTAREA|SELECT)$/i.test(String(tgt.tagName || ''))));
      const panel = document.getElementById('controller-panel');
      const panelActive = !!panel && !panel.classList.contains('hidden');
      const controllersTab = document.getElementById('tab-controllers');
      const controllersActive = !!controllersTab && controllersTab.classList.contains('active');
      const inputId = String(tgt?.id || '');
      const isConfigInput = /^gc-|^map-/i.test(inputId);
      if ((panelActive || controllersActive) && isEditable && isConfigInput) return;
      const nc = translate(e.code);
      const forward = state.currentView === 'game' && !isFocusInsideEmulator();
      if (!forward && nc === e.code) return;
      if (forwarding) return;
      e.preventDefault();
      e.stopPropagation();
      const targetWin = getEmulatorTargetWindow();
      const targetDoc = targetWin?.document;
      forwarding = true;
      try {
        if (typeof targetWin.sendVirtualKey === 'function') {
          targetWin.sendVirtualKey(e.type, nc);
        } else {
          const ev = new KeyboardEvent(e.type, { key: codeToKey(nc), code: nc, repeat: e.repeat, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
          try { targetDoc?.body?.dispatchEvent(ev); } catch { }
          try { targetDoc?.dispatchEvent(ev); } catch { }
        }
      } finally {
        forwarding = false;
      }
    } catch { }
  }
  ['keydown', 'keyup'].forEach(t => window.addEventListener(t, onEv, true));
  return { set, translate };
})();

function attachInnerKeyMapper(innerWin) {
  try {
    if (!innerWin || innerWin.__kmAttached) return;
    innerWin.__kmAttached = true;
    function onInner(e) {
      if (!e.isTrusted) return;
      const nc = KeyMapper.translate(e.code);
      if (nc === e.code) return;
      e.preventDefault();
      e.stopPropagation();
      if (typeof innerWin.sendVirtualKey === 'function') {
        innerWin.sendVirtualKey(e.type, nc);
      } else {
        const ev = new KeyboardEvent(e.type, { key: codeToKey(nc), code: nc, repeat: e.repeat, altKey: e.altKey, ctrlKey: e.ctrlKey, shiftKey: e.shiftKey, metaKey: e.metaKey, bubbles: true, cancelable: true });
        try { innerWin.document?.body?.dispatchEvent(ev); } catch { }
        try { innerWin.document?.dispatchEvent(ev); } catch { }
        try { innerWin.dispatchEvent(ev); } catch { }
      }
    }
    ['keydown', 'keyup'].forEach(t => innerWin.addEventListener(t, onInner, true));
  } catch { }
}

// Initialize games from games.json
async function initializeGames() {
  let gamesData;
  try {
    const response = await fetch('games.json', { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    gamesData = await response.json();
  } catch (error) {
    gamesData = DEFAULT_GAMES;
  }
  state.games = gamesData;
  renderRooms();
  wireScreenImages();
}

// Initialize on page load
document.addEventListener('DOMContentLoaded', async () => {
  await initializeGames();

  // Set up room switching
  qsa('.switch-btn[data-room]').forEach(btn => {
    btn.addEventListener('click', () => {
      const room = btn.getAttribute('data-room');
      if (room) showRoom(room);
    });
  });

  // Set up back button
  const backBtn = qs('#back-to-room');
  if (backBtn) {
    backBtn.addEventListener('click', backToRoom);
  }

  // Set up account button
  const accountBtn = qs('#account-btn');
  const accountModal = qs('#account-modal');
  const accountClose = qs('#account-close');
  if (accountBtn && accountModal) {
    accountBtn.addEventListener('click', () => {
      accountModal.classList.remove('hidden');
      Account.uiRefresh();
    });
  }
  if (accountClose && accountModal) {
    accountClose.addEventListener('click', () => {
      accountModal.classList.add('hidden');
    });
  }

  // Set up account actions
  const createBtn = qs('#create-btn');
  const loginBtn = qs('#login-btn');
  const logoutBtn = qs('#logout-btn');
  const loginCode = qs('#login-code');

  if (createBtn) {
    createBtn.addEventListener('click', async () => {
      try {
        const code = await Account.createAccount();
        await Account.login(code);
        await Account.uiRefresh();
        alert(`Account created! Your code is: ${code}\n\nSave this code - it's your only way to access your account.`);
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });
  }

  if (loginBtn && loginCode) {
    loginBtn.addEventListener('click', async () => {
      try {
        await Account.login(loginCode.value.trim());
        await Account.uiRefresh();
        loginCode.value = '';
      } catch (e) {
        alert('Error: ' + e.message);
      }
    });
  }

  if (logoutBtn) {
    logoutBtn.addEventListener('click', () => {
      Account.logout();
      Account.uiRefresh();
    });
  }

  

  // Set up controller button
  const controllerBtn = qs('#controller-btn');
  const controllerPanel = qs('#controller-panel');
  const controllerClose = qs('#controller-close');
  if (controllerBtn && controllerPanel) {
    controllerBtn.addEventListener('click', () => {
      controllerPanel.classList.toggle('hidden');
    });
  }
  if (controllerClose && controllerPanel) {
    controllerClose.addEventListener('click', () => {
      controllerPanel.classList.add('hidden');
    });
  }

  // Set up video button
  const videoBtn = qs('#video-btn');
  const videoModal = qs('#video-modal');
  const videoClose = qs('#video-close');

  console.log('Video Modal Setup:', { videoBtn, videoModal, videoClose });

  if (videoBtn && videoModal) {
    videoBtn.addEventListener('click', () => {
      console.log('Video button clicked');
      videoModal.classList.remove('hidden');
    });
  }
  if (videoClose && videoModal) {
    videoClose.addEventListener('click', () => {
      console.log('Video close clicked');
      videoModal.classList.add('hidden');
    });
  }

  // Auto-close on selection
  const scaleSelect = qs('#scale-mode');
  if (scaleSelect && videoModal) {
    scaleSelect.addEventListener('change', () => {
      console.log('Scale mode changed');
      // Give a small delay so user sees the change
      setTimeout(() => {
        console.log('Auto-closing modal');
        videoModal.classList.add('hidden');
      }, 300);
    });
  }

  // Show arcade room by default
  showRoom('arcade');
});
function mountArcadeDirect(theme, romName, htmlFile) {
  try {
    const container = theme === 'arcade' ? qs('#emulator') : qs('#emulator-console');
    container.innerHTML = '';
    const iframe = document.createElement('iframe');
    iframe.src = htmlFile || 'Emulatrix_MAME2003.htm';
    iframe.allow = 'gamepad; autoplay; fullscreen';
    iframe.setAttribute('allowfullscreen', 'true');
    iframe.setAttribute('frameborder', '0');
    container.appendChild(iframe);
  } catch {}
}

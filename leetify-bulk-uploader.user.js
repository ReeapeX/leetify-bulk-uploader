// ==UserScript==
// @name         Leetify Bulk Demo Uploader
// @namespace    denopeak.leetify.bulkupload
// @version      3.5.0
// @author       ReeapeX
// @homepageURL  https://github.com/ReeapeX/leetify-bulk-uploader
// @supportURL   https://github.com/ReeapeX/leetify-bulk-uploader/issues
// @updateURL    https://raw.githubusercontent.com/ReeapeX/leetify-bulk-uploader/main/leetify-bulk-uploader.user.js
// @downloadURL  https://raw.githubusercontent.com/ReeapeX/leetify-bulk-uploader/main/leetify-bulk-uploader.user.js
// @description  Sucht vollautomatisch alle offenen "Upload Demo"-Matches auf Leetify (geht selbst die Zeiträume durch) und lädt sie über deine Upload-Extension hoch – mit Parallel-Limit, Pausen, Timeouts, Auto-Pause, Tutorial, KI-Analyse der letzten Matches (Liste + Leetify-API).
// @match        https://leetify.com/*
// @grant        GM_openInTab
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addValueChangeListener
// @grant        GM_registerMenuCommand
// @grant        GM_notification
// @grant        GM_xmlhttpRequest
// @grant        unsafeWindow
// @grant        window.close
// @connect      api-public.cs-prod.leetify.com
// @run-at       document-start
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  // Version kommt aus dem Header (@version) – nur noch an EINER Stelle pflegen
  const VERSION = (() => { try { return GM_info.script.version; } catch (_) { return '3.5.0'; } })();
  // Muss ganz am Anfang passieren: die CSNADES-Extension entfernt ihre URL-Parameter kurz nach dem Laden
  const BOOT_URL = location.href;
  const BOOT_HISTLEN = history.length;
  const TAB_ID = Math.random().toString(36).slice(2, 10);
  const now = () => Date.now();
  const mono = () => (typeof performance !== 'undefined' && performance.now ? performance.now() : Date.now());
  const PAGE_LOADED = now();

  // ═════════════ Helfer-Modus (läuft in den von uns geöffneten Tabs) ═════════════
  // Der CSNADES-Ablauf schließt den Tab nach dem Upload NICHT, sondern leitet auf
  // /app/match-details/<id>?faceit-to-leetify=done zurück → hier melden und Tab schließen.
  (function helper() {
    let u;
    try { u = new URL(BOOT_URL); } catch (_) { return; }
    const m = u.pathname.match(/^\/app\/match-details\/([^/?#]+)/);
    if (!m || u.searchParams.get('faceit-to-leetify') !== 'done') return;
    if (now() > (GM_getValue('activeUntil', 0) || 0)) return; // gerade kein Lauf aktiv → normaler Tab des Users
    if (BOOT_HISTLEN > 2) return; // Tab hat Vorgeschichte → hat der User selbst geöffnet
    GM_setValue('signal', {
      leetifyId: m[1],
      old: u.searchParams.get('faceit-to-leetify-is-old') === 'true',
      t: now(),
      n: Math.random(),
    });
    setTimeout(() => { try { window.close(); } catch (_) { /* Haupt-Tab schließt per Handle */ } }, 400);
  })();

  // ═════════════ Modi & Einstellungen ═════════════
  const SPEED_KEYS = ['concurrency', 'minDelay', 'maxDelay', 'pauseEvery', 'pauseSec', 'timeoutSec', 'maxPerRun', 'maxFails'];
  const AUTO_KEYS = ['autoRange', 'daysBack', 'windowDays', 'autoPasses', 'repeatMin', 'retryFailed'];
  const MODES = {
    auto: {
      label: '🤖 Vollautomatisch (empfohlen)',
      concurrency: 2, minDelay: 10, maxDelay: 20, pauseEvery: 15, pauseSec: 180, timeoutSec: 180, maxPerRun: 0, maxFails: 3,
      autoRange: true, daysBack: 60, windowDays: 7, autoPasses: 2, repeatMin: 0, retryFailed: true,
    },
    safe: {
      label: '🐢 Sehr sicher (vollautomatisch, langsam)',
      concurrency: 1, minDelay: 25, maxDelay: 45, pauseEvery: 10, pauseSec: 300, timeoutSec: 180, maxPerRun: 40, maxFails: 2,
      autoRange: true, daysBack: 60, windowDays: 7, autoPasses: 2, repeatMin: 0, retryFailed: true,
    },
    fast: {
      label: '⚡ Schnell (vollautomatisch, mehr Risiko)',
      concurrency: 3, minDelay: 4, maxDelay: 8, pauseEvery: 25, pauseSec: 90, timeoutSec: 240, maxPerRun: 0, maxFails: 4,
      autoRange: true, daysBack: 60, windowDays: 7, autoPasses: 2, repeatMin: 0, retryFailed: true,
    },
    view: {
      label: '👁 Nur aktuelle Ansicht (ohne Autopilot)',
      concurrency: 2, minDelay: 10, maxDelay: 20, pauseEvery: 15, pauseSec: 180, timeoutSec: 180, maxPerRun: 60, maxFails: 3,
      autoRange: false, daysBack: 60, windowDays: 7, autoPasses: 1, repeatMin: 0, retryFailed: true,
    },
  };
  // [Schlüssel, Label, min, max, Tooltip]
  const SPEED_FIELDS = [
    ['concurrency', 'Gleichzeitige Tabs', 1, 5, 'Wie viele Upload-Tabs gleichzeitig offen sein dürfen. Mehr = schneller, aber mehr Captcha-Anfragen bei FACEIT auf einmal (= höheres Risiko für Captcha/Sperre).'],
    ['minDelay', 'Abstand min (s)', 1, 600, 'Kürzeste Wartezeit zwischen zwei Uploads. Die echte Wartezeit wird zufällig zwischen min und max gewählt, damit es nicht nach Bot aussieht.'],
    ['maxDelay', 'Abstand max (s)', 1, 900, 'Längste Wartezeit zwischen zwei Uploads (zufällig zwischen min und max).'],
    ['pauseEvery', 'Pause alle X Demos (0=aus)', 0, 500, 'Nach so vielen Uploads macht das Script eine längere Pause. 0 = keine Pausen.'],
    ['pauseSec', 'Pausenlänge (s)', 0, 3600, 'Wie lange die geplante Pause dauert.'],
    ['timeoutSec', 'Tab-Timeout (s)', 30, 1800, 'Schließt sich ein Upload-Tab bis dahin nicht von selbst, gilt der Upload als fehlgeschlagen und der Tab wird geschlossen.'],
    ['maxPerRun', 'Max pro Lauf (0=∞)', 0, 2000, 'Höchstens so viele Uploads pro Start. 0 = unbegrenzt.'],
    ['maxFails', 'Auto-Pause nach Fehlern', 1, 20, 'Nach so vielen Fehlern hintereinander pausiert das Script automatisch (meist Captcha, Rate-Limit oder ausgeloggt).'],
  ];
  const AUTO_FIELDS = [
    ['daysBack', 'Autopilot: Tage zurück', 1, 730, 'Wie weit der Autopilot in die Vergangenheit sucht. Leetify verarbeitet ältere FACEIT-Demos meist nicht mehr (ca. 30–60 Tage), weiter zurück bringt also wenig.'],
    ['windowDays', 'Autopilot: Tage pro Schritt', 1, 60, 'So viele Tage wählt der Autopilot pro Schritt im Kalender aus. Werden es mehr als 120 Matches, teilt er den Zeitraum automatisch.'],
    ['autoPasses', 'Durchgänge', 1, 5, 'Wie oft alles durchgegangen wird. 2 = am Ende ein zweiter Durchgang, der prüft, ob noch etwas offen ist und Fehlgeschlagene nochmal versucht.'],
    ['repeatMin', 'Danach alle X min neu suchen (0=aus)', 0, 1440, 'Nach dem Fertigwerden in diesem Abstand automatisch erneut suchen (z.B. für neue Matches). Der Leetify-Tab muss dafür offen bleiben. 0 = aus.'],
  ];
  const FILTER_FIELDS = [
    ['maxAgeDays', 'Nur jünger als X Tage (0=alle)', 0, 3650, 'Matches, die älter sind, werden übersprungen. 0 = kein Filter.'],
  ];

  const RECHECK_AFTER_MS = 30 * 60e3; // ≥30 min nach Upload neu geladen und noch "Upload Demo" → fehlgeschlagen
  const MAX_OK_ATTEMPTS = 3;
  const HIST_KEEP_MS = 90 * 864e5;
  const TICK_MS = 500;
  const FAST_CLOSE_MS = 3000;

  const DEFAULTS = { mode: 'auto', activeTab: false, keepFailedTabs: false, maxAgeDays: 0, faceitOnly: true, ...MODES.auto };
  delete DEFAULTS.label;
  let cfg = (() => {
    const saved = GM_getValue('cfg', {}) || {};
    if (!saved.v3) { // alte Version: nur Filter übernehmen, Rest neu
      const keep = {};
      ['activeTab', 'keepFailedTabs', 'maxAgeDays', 'faceitOnly'].forEach((k) => { if (k in saved) keep[k] = saved[k]; });
      return { ...DEFAULTS, ...keep, v3: true };
    }
    return { ...DEFAULTS, ...saved };
  })();
  const saveCfg = () => GM_setValue('cfg', { ...cfg, v3: true });
  function applyMode(key) {
    const m = MODES[key];
    if (!m) return;
    [...SPEED_KEYS, ...AUTO_KEYS].forEach((k) => { cfg[k] = m[k]; });
  }

  // ═════════════ Verlauf (tab-übergreifend, read-modify-write) ═════════════
  let hist = GM_getValue('hist', {}) || {};
  (function prune() {
    let changed = false;
    for (const [k, v] of Object.entries(hist)) {
      if (!v || now() - (v.t || 0) > HIST_KEEP_MS) { delete hist[k]; changed = true; }
    }
    if (changed) GM_setValue('hist', hist);
  })();
  GM_addValueChangeListener('hist', (_n, _o, v, remote) => { if (remote) hist = v || {}; });
  function histSet(key, patch, incField) {
    const cur = GM_getValue('hist', {}) || {};
    const prev = cur[key] || {};
    cur[key] = { ...prev, ...patch, t: now() };
    if (incField) cur[key][incField] = (prev[incField] || 0) + 1;
    GM_setValue('hist', cur);
    hist = cur;
  }

  // ═════════════ Dauerhaftes Protokoll (übersteht Neuladen, Grundlage für den Bericht) ═════════════
  const RUNLOG_KEY = 'runlog';
  const RUNLOG_MAX = 5000;
  const pendingLog = [];
  let logFlushTimer = null;
  function ev(type, msg, data) {
    const e = { t: now(), y: type, m: msg || '' };
    if (data !== undefined) e.d = data;
    pendingLog.push(e);
    if (!logFlushTimer) logFlushTimer = setTimeout(flushLog, 3000);
  }
  function flushLog() {
    if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
    if (!pendingLog.length) return;
    const cur = GM_getValue(RUNLOG_KEY, []) || [];
    cur.push(...pendingLog.splice(0));
    if (cur.length > RUNLOG_MAX) cur.splice(0, cur.length - RUNLOG_MAX);
    GM_setValue(RUNLOG_KEY, cur);
  }
  const readLog = () => { flushLog(); return GM_getValue(RUNLOG_KEY, []) || []; };

  // ═════════════ Laufzeit-Zustand ═════════════
  const queue = []; // { key, leetifyId, status, tries, started, via, url }
  const liveEls = new Map(); // key -> { el, kind } (nur aktuell sichtbare Zeilen)
  const skipInfo = new Map(); // key -> Grund
  const logLines = [];
  const state = {
    running: false, paused: false, busy: false, testMode: false, switching: false,
    active: new Map(), started: 0,
    nextAt: 0, pauseUntil: 0, sleepUntil: 0, consecFails: 0,
    runOk: 0, runFail: 0,
    windows: [], winIdx: -1, pass: 1, passOpened: 0, truncSeen: 0,
    // Überwachung
    gen: 0, lastProgress: 0, lastHb: 0, stalls: 0, runStart: 0, openedTotal: 0,
    windowKeys: new Set(), windowReloads: 0, reloadsTotal: 0, firstRowCheckDone: false,
  };
  const progress = () => { state.lastProgress = now(); };
  let panel = null;

  // Timer über einen Worker: Chrome drosselt Timer in Hintergrund-Tabs (bis zu 1×/Minute), Worker-Timer nicht.
  // Jeder Timer läuft zusätzlich als normaler setTimeout – wer zuerst feuert, gewinnt (falls die CSP den Worker blockiert).
  const timerCbs = new Map();
  let timerId = 0;
  let onWorkerTick = null;
  const timerWorker = (() => {
    try {
      const src = 'const T=new Map();let ti;onmessage=e=>{const d=e.data;'
        + "if(d.c==='set'){T.set(d.id,setTimeout(()=>{T.delete(d.id);postMessage({id:d.id})},d.ms))}"
        + "else if(d.c==='tick'){clearInterval(ti);ti=setInterval(()=>postMessage({tick:1}),d.ms)}}";
      const w = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      w.onmessage = (e) => {
        if (e.data && e.data.tick) { if (onWorkerTick) onWorkerTick(); return; }
        const cb = timerCbs.get(e.data && e.data.id);
        if (cb) cb();
      };
      w.onerror = () => { /* Fallback-Timer übernehmen */ };
      return w;
    } catch (_) { return null; }
  })();
  function wtimeout(fn, ms) {
    const id = ++timerId;
    let done = false;
    const run = () => { if (done) return; done = true; timerCbs.delete(id); fn(); };
    timerCbs.set(id, run);
    if (timerWorker) { try { timerWorker.postMessage({ c: 'set', id, ms }); } catch (_) { /* ignore */ } }
    setTimeout(run, ms);
  }

  const rand = (a, b) => a + Math.random() * Math.max(0, b - a);
  const fmtS = (ms) => { const s = Math.max(0, Math.ceil(ms / 1000)); return s >= 120 ? `${Math.ceil(s / 60)} min` : `${s}s`; };
  const short = (s) => (String(s).length > 72 ? `${String(s).slice(0, 69)}…` : String(s));
  const sleep = (ms) => new Promise((r) => wtimeout(r, ms));
  const pad = (n) => String(n).padStart(2, '0');
  const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const dm = (d) => `${pad(d.getDate())}.${pad(d.getMonth() + 1)}.`;
  const addDays = (d, n) => { const x = new Date(d.getFullYear(), d.getMonth(), d.getDate()); x.setDate(x.getDate() + n); return x; };
  const today0 = () => { const d = new Date(now()); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); };
  const textOf = (el) => (el && el.textContent ? el.textContent.replace(/\s+/g, ' ').trim() : '');

  function log(msg) {
    logLines.unshift(`[${new Date().toLocaleTimeString('de-DE')}] ${msg}`);
    if (logLines.length > 120) logLines.length = 120;
    console.log('[LDU]', msg);
    ev('log', msg);
    renderLog();
  }

  async function waitFor(fn, ms) {
    const t0 = mono();
    for (;;) {
      let v = null;
      try { v = fn(); } catch (_) { v = null; }
      if (v) return v;
      if (mono() - t0 > ms) return null;
      await sleep(100);
    }
  }

  // ═════════════ Zeilen finden ═════════════
  const UPLOAD_RE = /^\s*upload demo\s*$/i;
  const onMatchesPage = () => /^\/app\/matches/.test(location.pathname);

  const listRoot = () => document.querySelector('app-matches-list, app-matches-list-v2') || document.body;
  function findUploadElements() {
    const out = [];
    // CSNADES-Button zuerst, damit er bei gleicher Zeile Vorrang hat
    document.querySelectorAll('.__faceit-to-leetify button:not([disabled])').forEach((b) => out.push({ el: b, kind: 'csnades' }));
    if (!document.body) return out;
    const walker = document.createTreeWalker(listRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.length < 40 && UPLOAD_RE.test(n.nodeValue)
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    let n;
    while ((n = walker.nextNode())) {
      const el = n.parentElement;
      if (el && !el.closest('#ldu-panel')) out.push({ el, kind: 'native' });
    }
    return out;
  }

  const rowOf = (el) => el.closest('tr') || el.closest('a') || el.parentElement;
  // Textknoten mit Leerzeichen verbinden – textContent klebt Zellen zusammen ("Upload Demo2026-10-24")
  function rowText(el) {
    const row = rowOf(el);
    if (!row) return '';
    const parts = [];
    const tw = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
    let n;
    while ((n = tw.nextNode())) parts.push(n.nodeValue);
    return parts.join(' ').replace(/\s+/g, ' ').trim();
  }

  function matchIdFrom(el) {
    const row = rowOf(el);
    const a = el.closest('a[href*="/match-details/"]')
      || row?.querySelector('a[href*="/match-details/"]')
      || row?.parentElement?.closest('a[href*="/match-details/"]');
    const m = a && a.href.match(/match-details\/([^/?#]+)/);
    return m ? m[1] : null;
  }

  const fallbackIds = new WeakMap();
  let fallbackCounter = 0;
  function keyOf(el) {
    const id = matchIdFrom(el);
    if (id) return `L:${id}`;
    const a = el.closest('a[href]');
    if (a && /^https?:/.test(a.href)) return `U:${a.href}`;
    const txt = rowText(el).replace(/\b(\d+|an?|a few)\s+(seconds?|minutes?|hours?|days?)\s+ago\b/gi, '').trim();
    if (txt.length > 15) return `T:${txt.slice(0, 140)}`;
    if (!fallbackIds.has(el)) fallbackIds.set(el, `X:${++fallbackCounter}`);
    return fallbackIds.get(el);
  }

  function rowAgeDays(el) {
    const txt = rowText(el);
    const d = txt.match(/(?<!\d)(20\d{2})-(\d{2})-(\d{2})(?!\d)/);
    if (d) return (now() - new Date(+d[1], +d[2] - 1, +d[3]).getTime()) / 864e5;
    if (/\bago\b/i.test(txt)) return 0;
    return null;
  }

  // 'faceit' | 'other' | 'unknown' – bei 'unknown' wird nicht gefiltert
  function sourceOf(el) {
    const row = rowOf(el);
    if (!row) return 'unknown';
    const imgs = [...row.querySelectorAll('img')].map((i) => `${i.src} ${i.alt} ${i.title}`.toLowerCase()).join(' ');
    const txt = rowText(el);
    if (/faceit/i.test(txt) || imgs.includes('faceit')) return 'faceit';
    if (/matchmaking|premier|wingman|competitive|gamers ?club|renown|esea/i.test(txt) || /steam|valve|matchmaking|gamersclub|esea/.test(imgs)) return 'other';
    return 'unknown';
  }

  function skipReason(key, el) {
    const h = hist[key];
    if (h) {
      if (h.s === 'running' && now() - h.t < (cfg.timeoutSec + 90) * 1000) return 'running';
      if (h.s === 'old') return 'old';
      if ((h.okN || 0) >= MAX_OK_ATTEMPTS) return 'gaveup';
      if (h.s === 'ok' && PAGE_LOADED - h.t < RECHECK_AFTER_MS) return 'ok';
      if ((h.s === 'timeout' || h.s === 'error') && !cfg.retryFailed) return 'failed';
    }
    if (cfg.faceitOnly && sourceOf(el) === 'other') return 'notFaceit';
    if (cfg.maxAgeDays > 0) {
      const age = rowAgeDays(el);
      if (age !== null && age > cfg.maxAgeDays) return 'tooOld';
    }
    return null;
  }

  // Der "Upload Demo"-Button ist ein normaler Link auf den FACEIT-Raum (…?leetifyExtension=importAndClose).
  // Den merken wir uns sofort – Leetify baut die Liste nach jedem Import neu auf, danach ist die Zeile oft weg.
  function preUrlOf(el, kind) {
    if (kind !== 'native') return null;
    const a = el.closest('a[href]');
    return a && /^https?:/.test(a.href) && !/\/match-details\//.test(a.href) ? a.href : null;
  }
  // bereit = sichtbar ODER Link schon bekannt
  const isReady = (q) => liveEls.has(q.key) || !!q.pre;

  function scan() {
    liveEls.clear();
    skipInfo.clear();
    const items = findUploadElements();
    let added = 0;
    for (const { el, kind } of items) {
      const key = keyOf(el);
      if (liveEls.has(key)) continue;
      liveEls.set(key, { el, kind });
      const qi = queue.findIndex((i) => i.key === key);
      // Wartende Einträge jedes Mal neu prüfen (Verlauf aus anderem Tab, geänderte Filter)
      if (qi === -1 || queue[qi].status === 'queued') {
        const why = skipReason(key, el);
        if (why) {
          skipInfo.set(key, why);
          if (qi !== -1) queue.splice(qi, 1);
        } else if (qi === -1) {
          queue.push({ key, leetifyId: matchIdFrom(el), status: 'queued', tries: 0, pre: preUrlOf(el, kind) });
          added++;
        } else if (!queue[qi].pre) queue[qi].pre = preUrlOf(el, kind);
      }
      decorate(el, key);
    }
    return { found: liveEls.size, added };
  }

  // ═════════════ URL ermitteln (= was ein Mittelklick öffnen würde) ═════════════
  let ORIG_OPEN = null;
  let captureChain = Promise.resolve();

  // Synthetischer Mittelklick; ruft die Seite dabei window.open auf, fangen wir die URL ab statt zu öffnen.
  function captureOpen(el, waitMs = 1200) {
    const run = () => new Promise((resolve) => {
      const w = unsafeWindow;
      if (!ORIG_OPEN) ORIG_OPEN = w.open;
      let done = false;
      const finish = (url) => {
        if (done) return;
        done = true;
        try { w.open = ORIG_OPEN; } catch (_) { /* ignore */ }
        let abs = null;
        try { if (url && !/^about:blank/i.test(url)) abs = new URL(String(url), location.href).href; } catch (_) { /* ignore */ }
        resolve(abs);
      };
      const hook = function (url) {
        if (url && !/^about:blank/i.test(String(url))) { finish(url); return null; }
        const loc = { assign: finish, replace: finish };
        Object.defineProperty(loc, 'href', { set: finish, get: () => 'about:blank' });
        const fake = { close() {}, focus() {}, blur() {}, document: {}, closed: false };
        Object.defineProperty(fake, 'location', { get: () => loc, set: finish });
        return fake;
      };
      try {
        w.open = (typeof exportFunction === 'function') ? exportFunction(hook, w) : hook;
      } catch (_) { done = true; resolve(null); return; }
      const opts = { bubbles: true, cancelable: true, composed: true, button: 1, buttons: 4 };
      try {
        const P = typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
        el.dispatchEvent(new P('pointerdown', opts));
        el.dispatchEvent(new MouseEvent('mousedown', opts));
        el.dispatchEvent(new P('pointerup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('mouseup', { ...opts, buttons: 0 }));
        el.dispatchEvent(new MouseEvent('auxclick', { ...opts, buttons: 0 }));
      } catch (_) { /* ignore */ }
      wtimeout(() => finish(null), waitMs);
    });
    const p = captureChain.then(run, run);
    captureChain = p.catch(() => {});
    return p;
  }

  const faceitIdCache = new Map();
  async function viaApi(leetifyId) {
    let fid = faceitIdCache.get(leetifyId);
    if (!fid) {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 10000);
      try {
        const r = await fetch(`https://api.leetify.com/api/games/${encodeURIComponent(leetifyId)}/external-match-id`, { signal: ac.signal });
        if (!r.ok) throw new Error(`Leetify-API HTTP ${r.status}`);
        fid = await r.json();
        if (fid && typeof fid === 'object') fid = fid.id || fid.matchId || fid.externalMatchId;
      } catch (e) {
        throw new Error(e.name === 'AbortError' ? 'Leetify-API antwortet nicht (10 s)' : e.message);
      } finally { clearTimeout(to); }
      if (!fid || typeof fid !== 'string') throw new Error('Leetify-API lieferte keine FACEIT-ID');
      faceitIdCache.set(leetifyId, fid);
    }
    return `https://www.faceit.com/en/cs2/room/${encodeURIComponent(fid)}?faceit-to-leetify=auto`;
  }

  async function resolveUrl(item) {
    if (item.pre) return { url: item.pre, via: 'link' };
    const live = liveEls.get(item.key);
    const el = live && document.contains(live.el) ? live.el : null;
    if (!el) throw Object.assign(new Error('Zeile nicht mehr sichtbar'), { code: 'HIDDEN' });
    if (live.kind === 'csnades') {
      if (!item.leetifyId) throw new Error('CSNADES-Button ohne Leetify-ID');
      return { url: await viaApi(item.leetifyId), via: 'api' };
    }
    const captured = await captureOpen(el);
    if (captured) return { url: captured, via: 'handler' };
    const a = el.closest('a[href]');
    if (a && /^https?:/.test(a.href)) return { url: a.href, via: 'link' };
    if (item.leetifyId) return { url: await viaApi(item.leetifyId), via: 'api' };
    throw new Error('Kein Link gefunden – bitte "Diagnose" drücken und schicken');
  }

  // ═════════════ Autopilot: Leetifys Datumswähler bedienen ═════════════
  const MONTH_IDX = { jan: 0, feb: 1, mar: 2, 'mär': 2, apr: 3, may: 4, mai: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, okt: 9, nov: 10, dec: 11, dez: 11 };
  function parseMonth(txt) {
    const m = String(txt).trim().match(/^([A-Za-zÄÖÜäöü]{3,})\.?\s+(\d{4})$/);
    if (!m) return null;
    const i = MONTH_IDX[m[1].slice(0, 3).toLowerCase()];
    return i === undefined ? null : new Date(+m[2], i, 1);
  }
  const sameMonth = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth();
  const layoutAvailable = () => !!(document.body && document.body.getClientRects().length);
  function isVisible(el) {
    if (!el || !el.isConnected) return false;
    if (layoutAvailable()) return el.getClientRects().length > 0;
    for (let e = el; e && e.nodeType === 1; e = e.parentElement) {
      const cs = getComputedStyle(e);
      if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    }
    return true;
  }
  const outsidePanel = (e) => !e.closest('#ldu-panel');

  const RANGE_RE = /^\s*(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})\s*$/;
  function findRangeField() {
    const inputs = [...document.querySelectorAll('input')].filter((i) => RANGE_RE.test(i.value || '') && outsidePanel(i));
    if (inputs.length) return inputs[0]; // erstes Feld = "Current period"
    return [...document.querySelectorAll('div, span, button')]
      .find((e) => outsidePanel(e) && e.children.length === 0 && RANGE_RE.test(e.textContent || '')) || null;
  }
  const fieldText = (f) => (!f ? '' : (f.tagName === 'INPUT' ? f.value : textOf(f)));
  const normRange = (s) => { const m = String(s).match(RANGE_RE); return m ? `${m[1]} - ${m[2]}` : String(s).trim(); };

  function deepestWithText(root, re) {
    const all = [...root.querySelectorAll('*')].filter((e) => re.test(textOf(e)));
    return all.find((e) => ![...e.children].some((c) => re.test(textOf(c)))) || null;
  }
  function findCalendars(root) {
    const out = [];
    root.querySelectorAll('table').forEach((table) => {
      const header = [...table.querySelectorAll('th, td, div, span')]
        .find((e) => parseMonth(textOf(e)) && ![...e.children].some((c) => parseMonth(textOf(c))));
      if (header) out.push({ table, header, month: parseMonth(textOf(header)) });
    });
    return out;
  }
  function findPicker() {
    const climb = (start) => {
      for (let p = start.parentElement; p && p !== document.documentElement; p = p.parentElement) {
        if (findCalendars(p).length) return p;
      }
      return null;
    };
    const applies = [...document.querySelectorAll('button, a, [role=button]')]
      .filter((e) => /^apply$/i.test(textOf(e)) && outsidePanel(e) && isVisible(e));
    for (const b of applies) { const root = climb(b); if (root) return { root, apply: b }; }
    const customs = [...document.querySelectorAll('li, button, a, span, div')]
      .filter((e) => /^custom range$/i.test(textOf(e)) && outsidePanel(e) && isVisible(e));
    for (const c of customs) { const root = climb(c); if (root) return { root, apply: null }; }
    return null;
  }
  function arrows(cal) {
    const cell = cal.header.closest('th, td') || cal.header;
    const kids = cell.parentElement ? [...cell.parentElement.children] : [];
    const i = kids.indexOf(cell);
    let prev = i > 0 ? kids[i - 1] : null;
    let next = i >= 0 && i < kids.length - 1 ? kids[i + 1] : null;
    if (!prev) prev = cal.table.querySelector('.prev, [class*="prev"]');
    if (!next) next = cal.table.querySelector('.next, [class*="next"]');
    return { prev, next };
  }
  // Tag d = d-te Zelle ab der ersten "1" (Tage des Vor-/Folgemonats werden so automatisch übergangen)
  function dayCell(cal, day) {
    const cells = [...cal.table.querySelectorAll('tbody td')];
    const list = cells.length ? cells : [...cal.table.querySelectorAll('td')];
    const first = list.findIndex((c) => textOf(c) === '1');
    if (first < 0) return null;
    const c = list[first + day - 1];
    return c && textOf(c) === String(day) ? c : null;
  }
  function isDisabledCell(c) {
    if (/\bdisabled\b/i.test(c.className || '')) return true;
    try {
      const deco = (e) => (e ? getComputedStyle(e).textDecorationLine || getComputedStyle(e).textDecoration || '' : '');
      return /line-through/.test(deco(c)) || /line-through/.test(deco(c.firstElementChild));
    } catch (_) { return false; }
  }
  function clickEl(el, mode) {
    if (!el) return;
    if (mode === 'simple') { el.click(); return; }
    const o = { bubbles: true, cancelable: true, button: 0, buttons: 1 };
    el.dispatchEvent(new MouseEvent('mousedown', o));
    el.dispatchEvent(new MouseEvent('mouseup', { ...o, buttons: 0 }));
    el.click();
  }
  function closePicker() {
    try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (_) { /* ignore */ }
    try {
      document.body.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    } catch (_) { /* ignore */ }
  }

  async function navigateTo(pref, target) {
    let stuck = 0;
    let lastSig = '';
    for (let i = 0; i < 40; i++) {
      const pk = findPicker();
      if (!pk) throw new Error('Kalender hat sich unerwartet geschlossen');
      const cals = findCalendars(pk.root);
      if (!cals.length) throw new Error('Kein Monatskalender gefunden');
      const order = pref === 1 ? [...cals].reverse() : cals;
      const hit = order.find((c) => sameMonth(c.month, target));
      if (hit) return hit;
      const cal = cals[Math.min(pref, cals.length - 1)];
      const { prev, next } = arrows(cal);
      const btn = target < cal.month ? prev : next;
      if (!btn) throw new Error('Blätter-Pfeil im Kalender nicht gefunden');
      const sig = cals.map((c) => ymd(c.month)).join();
      if (sig === lastSig) { if (++stuck > 3) throw new Error('Kalender lässt sich nicht blättern'); } else stuck = 0;
      lastSig = sig;
      clickEl(btn, 'simple');
      await sleep(150);
    }
    throw new Error('Zielmonat im Kalender nicht erreichbar');
  }

  // "2026-11-07 - 2026-11-12" → [Date, Date] oder null
  function parseRange(t) {
    const m = String(t || '').match(/(20\d{2})-(\d{2})-(\d{2})\s*-\s*(20\d{2})-(\d{2})-(\d{2})/);
    return m ? [new Date(+m[1], +m[2] - 1, +m[3]), new Date(+m[4], +m[5] - 1, +m[6])] : null;
  }

  // Letzter wählbarer Tag ≤ end (Leetify sperrt z.B. den heutigen Tag)
  async function clampEnd(end, depth = 0) {
    const cal = await navigateTo(1, end);
    for (let d = end.getDate(); d >= 1; d--) {
      const c = dayCell(cal, d);
      if (c && !isDisabledCell(c)) return new Date(end.getFullYear(), end.getMonth(), d);
    }
    if (depth >= 1) throw new Error(`Im Kalender ist um ${ymd(end)} kein Tag wählbar`);
    return clampEnd(new Date(end.getFullYear(), end.getMonth(), 0), depth + 1); // letzter Tag des Vormonats
  }

  async function setRange(start, end, { force = false } = {}) {
    const want0 = `${ymd(start)} - ${ymd(end)}`;
    let field = findRangeField();
    if (!field) throw new Error('Datumsfeld ("Current period") nicht gefunden');
    if (normRange(fieldText(field)) === want0) {
      if (!force) return { how: 'unverändert', start, end };
      // gleiche Auswahl lädt nichts neu → kurz einen anderen Tag wählen und zurück
      const tmp = start.getTime() === end.getTime() ? addDays(start, -1) : end;
      await setRange(tmp, tmp);
      await sleep(300);
    }
    let lastErr = null;
    for (const mode of ['full', 'simple']) { // 2 Klick-Varianten, falls der Kalender auf eine nicht reagiert
      try {
        field = findRangeField() || field;
        if (!findPicker()) {
          try { field.focus(); } catch (_) { /* ignore */ }
          clickEl(field, mode);
        }
        const pk = await waitFor(findPicker, 4000);
        if (!pk) throw new Error('Kalender öffnet sich nicht');
        const custom = deepestWithText(pk.root, /^custom range$/i);
        if (custom) { clickEl(custom, mode); await sleep(200); }
        const origEnd = end;
        end = await clampEnd(origEnd);
        if (start > end) start = end;
        const clamped = end.getTime() !== origEnd.getTime();
        if (end.getTime() !== origEnd.getTime() && mode === 'full') log(`   (${dm(origEnd)} ist im Kalender noch gesperrt → bis ${dm(end)})`);
        const want = `${ymd(start)} - ${ymd(end)}`;
        const c1 = await navigateTo(0, start);
        const d1 = dayCell(c1, start.getDate());
        if (!d1) throw new Error(`Tag ${ymd(start)} im Kalender nicht gefunden`);
        if (isDisabledCell(d1)) throw new Error(`Tag ${ymd(start)} ist im Kalender gesperrt`);
        clickEl(d1, mode);
        await sleep(200);
        const c2 = await navigateTo(1, end);
        const d2 = dayCell(c2, end.getDate());
        if (!d2) throw new Error(`Tag ${ymd(end)} im Kalender nicht gefunden`);
        if (isDisabledCell(d2)) throw new Error(`Tag ${ymd(end)} ist im Kalender gesperrt`);
        clickEl(d2, mode);
        await sleep(200);
        const pk2 = findPicker();
        if (pk2 && pk2.apply) clickEl(pk2.apply, mode);
        // Leetify zeigt bei gekürztem Ende (heute gesperrt) das Ende teils 1–3 Tage früher an.
        // Wir akzeptieren das und arbeiten mit dem TATSÄCHLICH eingestellten Zeitraum weiter (unabhängig vom Datum).
        const slack = clamped ? 3 : 0;
        const check = () => {
          const t = parseRange(fieldText(findRangeField() || field));
          if (!t) return null;
          if (ymd(t[0]) !== ymd(start)) return null;
          const lag = Math.round((end - t[1]) / 864e5);
          return lag >= 0 && lag <= slack ? t : null;
        };
        const ok = await waitFor(() => !!check(), 4000);
        if (ok) {
          const t = check();
          const realEnd = t[1];
          if (realEnd.getTime() !== end.getTime()) log(`   ⚠️ Leetify zeigt nur bis ${dm(realEnd)} statt ${dm(end)} (Kalender-Eigenheit) – ${dm(end)} ist ggf. nicht in der Liste`);
          if (findPicker()) closePicker();
          return { how: 'ok', start, end: realEnd };
        }
        lastErr = new Error(`Datumsfeld zeigt "${fieldText(findRangeField() || field)}" statt "${want}"`);
      } catch (e) { lastErr = e; }
      closePicker();
      await sleep(400);
    }
    throw lastErr || new Error('Zeitraum ließ sich nicht setzen');
  }

  // Alle Datums-Texte (JJJJ-MM-TT) in der Match-Liste
  const DATE_RE = /^\s*20\d{2}-\d{2}-\d{2}\s*$/;
  function listDates() {
    const out = [];
    if (!document.body) return out;
    const tw = document.createTreeWalker(listRoot(), NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.nodeValue && n.nodeValue.length < 16 && DATE_RE.test(n.nodeValue) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP),
    });
    let n;
    while ((n = tw.nextNode())) { const p = n.parentElement; if (p && outsidePanel(p)) out.push(n.nodeValue.trim()); }
    return out;
  }
  // Warten, bis die Liste wirklich den neuen Zeitraum zeigt (≥80 % der Datumsangaben passen) UND stabil ist.
  // "Keine DOM-Änderung" allein reicht nicht: während Leetify lädt, ändert sich oft gar nichts → alte Liste.
  const listSig = () => `${listDates().join(',')}|${findUploadElements().length}`;
  async function waitListReady(win, sigBefore, maxMs = 20000) {
    const span = Math.round((win.end - win.start) / 864e5) + 1;
    const lo = ymd(addDays(win.start, -span - 1)); // Liste zeigt aktuellen + vorherigen Zeitraum
    const hi = ymd(win.end);
    const t0 = mono();
    let lastSig = null;
    let stableSince = mono();
    let seenChange = false;
    let last = {};
    await sleep(400);
    for (;;) {
      const dates = listDates();
      const uploads = findUploadElements().length;
      const inRange = dates.filter((d) => d >= lo && d <= hi).length;
      const sig = `${dates.length}|${dates[0]}|${dates[dates.length - 1]}|${uploads}`;
      if (sig !== lastSig) { lastSig = sig; stableSince = mono(); }
      if (`${dates.join(',')}|${uploads}` !== sigBefore) seenChange = true;
      // Erst wenn sich die Liste nachweislich geändert hat (oder 8 s gleich blieb – dann ist es wirklich dieselbe)
      const changedOrSame = seenChange || mono() - t0 > 8000;
      const stable = mono() - stableSince;
      last = { dates: dates.length, inRange, uploads, changed: seenChange, waitedMs: Math.round(mono() - t0) };
      if (changedOrSame && dates.length && inRange / dates.length >= 0.8 && stable > 1500) return { ok: true, ...last };
      if (changedOrSame && !dates.length && stable > 4000) return { ok: true, empty: true, ...last };
      if (mono() - t0 >= maxMs) break; // Abbruch erst NACH der Prüfung
      await sleep(250);
    }
    return { ok: false, ...last };
  }
  const isTruncated = () => /limited to the most recent/i.test(document.body.textContent || '');

  function buildWindows() {
    const t = today0();
    const oldest = addDays(t, -(cfg.daysBack - 1));
    const wins = [];
    let end = t;
    while (end >= oldest) {
      let start = addDays(end, -(cfg.windowDays - 1));
      if (start < oldest) start = oldest;
      wins.push({ start, end });
      end = addDays(start, -1);
    }
    return wins;
  }

  function advanceWindow(opts = {}) {
    state.busy = true;
    state.switching = true;
    state.switchStarted = mono();
    const gen = state.gen;
    let w = null;
    let lastReadyUploads = 0;
    (async () => {
      if (!opts.reload) { state.winIdx++; state.windowReloads = 0; }
      for (let guard = 0; guard < 10; guard++) {
        w = state.windows[state.winIdx];
        log(opts.reload
          ? `🔄 Lade Zeitraum ${dm(w.start)} – ${dm(w.end)} neu`
          : `📅 Zeitraum ${state.winIdx + 1}/${state.windows.length}: ${dm(w.start)} – ${dm(w.end)}${state.pass > 1 ? ` (Durchgang ${state.pass})` : ''}`);
        state.rangeTouched = true;
        const sigBefore = listSig();
        const res = await setRange(w.start, w.end, { force: !!opts.reload && guard === 0 });
        if (!state.running || gen !== state.gen) return;
        w.start = res.start; // evtl. gekürzt (gesperrter Tag)
        w.end = res.end;
        const rd = await waitListReady(w, res.how === 'unverändert' ? null : sigBefore);
        if (!state.running || gen !== state.gen) return;
        lastReadyUploads = rd.uploads || 0;
        if (!rd.ok) {
          log('   ⚠ Liste hat den Zeitraum nach 20 s nicht sauber geladen – mache trotzdem weiter');
          ev('list_not_ready', '', { start: ymd(w.start), end: ymd(w.end), ...rd });
        }
        const span = Math.round((w.end - w.start) / 864e5) + 1;
        if (isTruncated() && span > 1) {
          const mid = addDays(w.start, Math.floor(span / 2) - 1);
          state.windows.splice(state.winIdx, 1, { start: addDays(mid, 1), end: w.end }, { start: w.start, end: mid });
          state.truncSeen++;
          log('   Mehr als 120 Matches im Zeitraum – teile ihn auf.');
          continue;
        }
        break;
      }
      let r = scan();
      for (let k = 0; k < 3 && r.found === 0 && lastReadyUploads > 0; k++) {
        log('   Liste wird gerade umgebaut (eben noch Zeilen da) – warte kurz und scanne erneut');
        await sleep(2000);
        const rd2 = await waitListReady(w, null, 15000);
        if (!state.running || gen !== state.gen) return;
        lastReadyUploads = rd2.uploads || 0;
        r = scan();
      }
      const openKeys = queue.filter((q) => q.status === 'queued' && liveEls.has(q.key)).map((q) => q.key);
      state.windowKeys = new Set(openKeys);
      log(`   ${r.found} "Upload Demo" sichtbar → ${openKeys.length} offen, ${skipInfo.size} übersprungen`);
      ev('window', '', {
        idx: state.winIdx + 1, of: state.windows.length, pass: state.pass, start: ymd(w.start), end: ymd(w.end),
        found: r.found, open: openKeys.length, skipped: skipInfo.size, reload: !!opts.reload,
      });
    })().catch((e) => {
      if (gen !== state.gen) return;
      closePicker();
      state.rangeTouched = false; // Kalender macht Probleme → nicht nochmal anfassen
      ev('autopilot_error', e.message, w ? { start: ymd(w.start), end: ymd(w.end) } : undefined);
      endRun(`Autopilot gestoppt: ${e.message}. Stell den Zeitraum per Hand ein (z.B. "Last 30 Days") und nimm Modus "Nur aktuelle Ansicht" – oder schick mir "Diagnose".`, true);
    }).finally(() => { if (gen === state.gen) { state.busy = false; state.switching = false; progress(); } });
  }

  function startPass(n) {
    state.pass = n;
    state.passOpened = 0;
    state.windows = buildWindows();
    state.winIdx = -1;
    if (cfg.retryFailed) {
      queue.forEach((q) => { if ((q.status === 'timeout' || q.status === 'error') && q.tries < 3) q.status = 'queued'; });
    }
  }

  // ═════════════ Ablauf ═════════════
  function failItem(item, msg) {
    item.status = 'error';
    histSet(item.key, { s: 'error' }, 'failN');
    state.runFail++;
    log(`✖ ${short(item.key)}: ${msg}`);
    ev('fail', msg, { key: item.key, attempt: item.tries });
    progress();
    updateBadge(item.key);
    registerFail();
    if (state.testMode && state.running) endRun('Test fehlgeschlagen – siehe Log', true);
    return false;
  }

  function rowDateStr(el) {
    const m = rowText(el).match(/(?<!\d)(20\d{2}-\d{2}-\d{2})(?!\d)/);
    return m ? m[1] : (/\bago\b/i.test(rowText(el)) ? 'heute' : '?');
  }

  // Wie verändert sich die Liste direkt nach dem Öffnen? (für den Bericht / Fehlersuche)
  function checkAfterOpen(item, before, el, htmlBefore) {
    wtimeout(() => {
      const after = findUploadElements().length;
      const still = !!(el && el.isConnected);
      const data = { key: item.key, uploadsBefore: before, uploadsAfter: after, rowStillInDom: still, rowTextAfter: still ? short(rowText(el)) : null };
      if (!state.firstRowCheckDone) {
        state.firstRowCheckDone = true;
        data.rowHTMLBefore = htmlBefore;
        data.rowHTMLAfter = still ? (rowOf(el)?.outerHTML || '').slice(0, 2500) : null;
      }
      ev('rowcheck', '', data);
      if (after < before - 1) log(`ℹ Nach dem Öffnen: "Upload Demo"-Zeilen ${before} → ${after} (Liste wurde umgebaut)`);
    }, 2500);
  }

  async function startItem(item, gen) {
    item.status = 'opening';
    item.tries++;
    updateBadge(item.key);
    const live0 = liveEls.get(item.key);
    const el0 = live0 ? live0.el : null;
    const before = findUploadElements().length;
    const htmlBefore = el0 && !state.firstRowCheckDone ? (rowOf(el0)?.outerHTML || '').slice(0, 2500) : null;
    const matchDate = el0 ? rowDateStr(el0) : '?';
    let res;
    try { res = await resolveUrl(item); } catch (e) {
      if (e.code === 'HIDDEN') { item.status = 'queued'; item.tries--; updateBadge(item.key); return false; }
      return failItem(item, e.message);
    }
    if (!state.running || state.paused || gen !== state.gen) { // während der Link-Ermittlung gestoppt/pausiert/zurückgesetzt
      item.status = 'queued';
      item.tries--;
      updateBadge(item.key);
      return false;
    }
    let tab;
    try { tab = GM_openInTab(res.url, { active: !!cfg.activeTab, insert: true }); } catch (e) { tab = null; }
    if (!tab) return failItem(item, 'Tab konnte nicht geöffnet werden');

    Object.assign(item, { status: 'running', started: now(), via: res.via, url: res.url });
    const entry = { item, tab, old: false };
    state.active.set(item.key, entry);
    state.passOpened++;
    state.openedTotal++;
    histSet(item.key, { s: 'running' });
    ev('open', '', { key: item.key, date: matchDate, url: res.url, via: res.via, attempt: item.tries, prevOk: (hist[item.key] || {}).okN || 0 });
    progress();
    checkAfterOpen(item, before, el0, htmlBefore);
    GM_setValue('activeUntil', now() + (cfg.timeoutSec + 90) * 1000);
    try { tab.onclose = () => finishItem(entry, 'closed'); } catch (_) { /* Polling übernimmt */ }
    log(`▶ geöffnet (${res.via}): ${short(res.url)}`);
    updateBadge(item.key);
    return true;
  }

  function finishItem(entry, outcome) {
    const { item } = entry;
    if (!state.active.has(item.key)) return;
    state.active.delete(item.key);
    const dur = now() - item.started;
    ev('finish', '', { key: item.key, outcome: outcome === 'closed' ? (entry.old ? 'old' : 'ok') : 'timeout', dur, via: item.via });
    progress();
    if (outcome === 'closed') {
      state.consecFails = 0;
      if (entry.old) {
        item.status = 'old';
        histSet(item.key, { s: 'old' });
        log(`⌛ Hochgeladen, aber laut Extension zu alt für Leetify – ${short(item.key)}`);
      } else {
        item.status = 'ok';
        histSet(item.key, { s: 'ok' }, 'okN');
        state.runOk++;
        log(`✔ Tab nach ${fmtS(dur)} zu – ${short(item.key)}`);
        if (dur < FAST_CLOSE_MS) log('   ↳ Sehr schnell zu. Zeigt die Zeile nach dem Neuladen noch "Upload Demo", hat es nicht geklappt.');
      }
    } else {
      item.status = 'timeout';
      histSet(item.key, { s: 'timeout' }, 'failN');
      state.runFail++;
      log(`⚠ Timeout nach ${fmtS(dur)} – ${short(item.key)}${cfg.keepFailedTabs ? ' (Tab bleibt offen)' : ' (Tab geschlossen)'}`);
      if (item.via === 'link') log('   ↳ Es wurde nur die Match-Seite geöffnet. Startet dort kein Upload, bitte "Diagnose" schicken.');
      registerFail();
    }
    updateBadge(item.key);
    if (state.testMode && state.running && !state.active.size) {
      endRun(outcome === 'closed' ? 'Test erfolgreich – jetzt kannst du "Start" drücken' : 'Test fehlgeschlagen – siehe Log', true);
    }
  }

  function registerFail() {
    state.consecFails++;
    state.nextAt = Math.max(state.nextAt, now() + Math.min(state.consecFails * 60e3, 600e3)); // Backoff
    if (state.running && !state.paused && state.consecFails >= cfg.maxFails) {
      state.paused = true;
      log(`⏸ Auto-Pause: ${state.consecFails} Fehler in Folge – vermutlich Captcha, Rate-Limit oder ausgeloggt. `
        + 'Öffne einen Match per Hand und schau, ob es normal klappt, dann "Fortsetzen".');
      notify(`Auto-Pause nach ${state.consecFails} Fehlern in Folge`);
      ev('autopause', '', { consecFails: state.consecFails });
    }
  }

  function startRun(testMode) {
    const lock = GM_getValue('lock', null);
    if (lock && lock.id !== TAB_ID && now() - lock.t < 6000) {
      log('✋ Läuft bereits in einem anderen Leetify-Tab – dort stoppen oder den Tab schließen.');
      return;
    }
    if (!onMatchesPage()) { log('Bitte zuerst die Match-Liste öffnen.'); return; }
    Object.assign(state, {
      running: true, paused: false, testMode: !!testMode, started: 0,
      nextAt: 0, pauseUntil: 0, sleepUntil: 0, consecFails: 0, runOk: 0, runFail: 0, truncSeen: 0,
      stalls: 0, runStart: now(), openedTotal: 0, reloadsTotal: 0, lastHb: 0, firstRowCheckDone: false,
    });
    state.gen++;
    progress();
    startPass(1);
    const f0 = findRangeField();
    state.origRange = f0 ? normRange(fieldText(f0)) : null; // nach dem Lauf wiederherstellen
    state.rangeTouched = false;
    const { found } = scan();
    GM_setValue('lock', { id: TAB_ID, t: now() });
    const what = testMode ? 'Test mit 1 Demo' : `Start – ${MODES[cfg.mode]?.label || 'Custom'}`;
    log(`▶ ${what}${cfg.autoRange ? ` · Autopilot: letzte ${cfg.daysBack} Tage in ${state.windows.length} Schritten` : ` · ${found} sichtbar`}`);
    const cfgCopy = { ...cfg };
    ev('run_start', what, { version: VERSION, test: !!testMode, cfg: cfgCopy });
    render();
  }

  function endRun(msg, natural) {
    const wasRunning = state.running;
    state.running = false;
    state.gen++;
    state.busy = false;
    state.switching = false;
    state.paused = false;
    state.testMode = false;
    state.sleepUntil = 0;
    queue.forEach((q) => { if (q.status === 'opening') { q.status = 'queued'; q.tries = Math.max(0, q.tries - 1); } });
    const lock = GM_getValue('lock', null);
    if (lock && lock.id === TAB_ID) GM_setValue('lock', null);
    if (msg) log(`■ ${msg}`);
    if (wasRunning) {
      const summary = {
        minutes: Math.round((now() - state.runStart) / 60e3), opened: state.openedTotal, ok: state.runOk, fail: state.runFail,
        reloads: state.reloadsTotal, stalls: state.stalls, leftOpen: queue.filter((q) => q.status === 'queued').length,
      };
      ev('run_end', msg, summary);
      log(`   Zusammenfassung: ${summary.minutes} min · ${summary.opened} geöffnet · ✅ ${summary.ok} · ⚠️ ${summary.fail}${summary.reloads ? ` · ${summary.reloads}× Zeitraum neu geladen` : ''}${summary.stalls ? ` · ${summary.stalls} Hänger` : ''}`);
    }
    if (natural) notify(`${msg} (✅ ${state.runOk} · ⚠️ ${state.runFail})`);
    flushLog();
    render();
    restoreRange();
  }

  function restoreRange() {
    const m = state.rangeTouched && state.origRange && state.origRange.match(RANGE_RE);
    state.rangeTouched = false;
    if (!m) return;
    const toDate = (s) => { const [a, b, c] = s.split('-').map(Number); return new Date(a, b - 1, c); };
    setTimeout(() => {
      if (state.running) return;
      setRange(toDate(m[1]), toDate(m[2]))
        .then(() => log('↩ Ursprünglichen Zeitraum wiederhergestellt'))
        .catch(() => { closePicker(); });
    }, 300);
  }

  function notify(text) {
    try { GM_notification({ title: 'Leetify Bulk Upload', text: short(text), silent: true, tag: 'ldu' }); } catch (_) { /* ignore */ }
  }

  let lastTick = 0;
  let lastBeat = 0;
  function tick() {
    lastTick = now();
    try { tickInner(); } catch (e) { console.error('[LDU] tick', e); }
  }

  function onNothingLeft(t) {
    if (state.active.size) return; // erst laufende Tabs abwarten
    if (cfg.retryFailed && !state.testMode) {
      const retry = queue.filter((q) => (q.status === 'timeout' || q.status === 'error') && q.tries < 2 && isReady(q));
      if (retry.length) {
        retry.forEach((q) => { q.status = 'queued'; updateBadge(q.key); });
        state.nextAt = t + 60e3;
        log(`↻ ${retry.length} fehlgeschlagene in 60 s noch einmal`);
        return;
      }
    }
    if (cfg.autoRange) {
      // Offene Zeilen dieses Zeitraums sind aus der Liste verschwunden (Leetify/Extension hat umgebaut) → neu laden statt überspringen
      const missing = queue.filter((q) => q.status === 'queued' && state.windowKeys.has(q.key) && !isReady(q));
      if (missing.length && state.winIdx >= 0 && state.windowReloads < 2) {
        state.windowReloads++;
        state.reloadsTotal++;
        log(`⚠ ${missing.length} offene Zeile(n) sind aus der Liste verschwunden – lade Zeitraum neu (${state.windowReloads}/2)`);
        ev('vanished', '', { count: missing.length, keys: missing.slice(0, 10).map((q) => q.key) });
        advanceWindow({ reload: true });
        return;
      }
      if (state.winIdx + 1 < state.windows.length) { advanceWindow(); return; }
      if (state.testMode) { endRun('Test: in den letzten Tagen keine offene Demo gefunden', true); return; }
      if (state.pass < cfg.autoPasses && state.passOpened > 0) {
        startPass(state.pass + 1);
        log(`🔁 Durchgang ${state.pass}/${cfg.autoPasses}: prüfe nochmal alles auf offene Demos`);
        return;
      }
      if (cfg.repeatMin > 0) {
        state.sleepUntil = t + cfg.repeatMin * 60e3;
        state.started = 0;
        startPass(1);
        log(`💤 Alles erledigt (✅ ${state.runOk} · ⚠️ ${state.runFail}). Nächste Suche um ${new Date(state.sleepUntil).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })}`);
        return;
      }
      const left = queue.filter((q) => q.status === 'queued' && !isReady(q)).length;
      endRun(left
        ? `Fertig, aber ${left} gefundene Demo(s) konnten nicht bearbeitet werden (Zeilen waren nicht mehr sichtbar) – nochmal "Start" drücken oder Bericht schicken.`
        : `Fertig: letzte ${cfg.daysBack} Tage komplett durchsucht. Seite in ~30 min neu laden, um zu prüfen, ob alles verarbeitet wurde.`, true);
      return;
    }
    const hidden = queue.filter((q) => q.status === 'queued' && !isReady(q)).length;
    endRun(`Fertig mit allen sichtbaren Matches${hidden ? ` (${hidden} in der Queue gerade nicht sichtbar)` : ''}.`, true);
  }

  function tickInner() {
    const t = now();
    for (const entry of [...state.active.values()]) {
      let closed = false;
      try { closed = !!entry.tab.closed; } catch (_) { /* ignore */ }
      if (closed) finishItem(entry, 'closed');
      else if (t - entry.item.started > cfg.timeoutSec * 1000) {
        finishItem(entry, 'timeout');
        if (!cfg.keepFailedTabs) { try { entry.tab.close(); } catch (_) { /* ignore */ } }
      }
    }
    if (state.running && t - lastBeat > 2000) { GM_setValue('lock', { id: TAB_ID, t }); lastBeat = t; }
    if (state.running && t - state.lastHb > 60e3) { // Lebenszeichen fürs Protokoll – Lücken = Script lief nicht
      state.lastHb = t;
      ev('hb', '', {
        openVisible: queue.filter((q) => q.status === 'queued' && isReady(q)).length, queued: queue.filter((q) => q.status === 'queued').length,
        active: state.active.size, ok: state.runOk, fail: state.runFail, win: state.winIdx + 1, of: state.windows.length, pass: state.pass,
        paused: state.paused, sleeping: t < state.sleepUntil, switching: state.switching, hidden: document.hidden,
      });
    }
    // User ist kurz auf einer anderen Leetify-Seite (SPA) → das ist kein Hänger, sonst Auto-Pause nach ~12 min
    if (state.running && !onMatchesPage()) progress();
    if (state.running && !state.paused) {
      if (state.switching) {
        // Zeitraumwechsel hat eigene Timeouts (max. ~1 min) – nach 3 min echter Laufzeit gilt er als hängend
        if (mono() - state.switchStarted > 180e3) recoverStall(mono() - state.switchStarted);
      } else {
        const idleSince = Math.max(state.lastProgress, state.pauseUntil, state.sleepUntil, state.nextAt);
        if (t - idleSince > Math.max(4 * 60e3, cfg.timeoutSec * 1000 + 60e3)) recoverStall(t - state.lastProgress);
      }
    }
    render();
    updateTitle();

    if (!state.running || state.paused || state.busy) return;
    if (!onMatchesPage()) return; // SPA: User ist kurz auf einer anderen Leetify-Seite → warten
    if (t < state.sleepUntil || t < state.pauseUntil || t < state.nextAt) return;
    if (state.active.size >= cfg.concurrency) return;

    const limit = state.testMode ? 1 : cfg.maxPerRun;
    if (limit > 0 && state.started >= limit) {
      if (!state.active.size) endRun(state.testMode ? 'Test beendet' : `Limit von ${limit} Demos für diesen Lauf erreicht`, true);
      return;
    }

    hist = GM_getValue('hist', {}) || {}; // frisch lesen, falls ein Change-Event verpasst wurde
    // Autopilot: erst den ersten Zeitraum einstellen, bevor irgendwas hochgeladen wird
    if (cfg.autoRange && state.winIdx < 0) { advanceWindow(); return; }
    scan();
    const item = queue.find((q) => q.status === 'queued' && isReady(q));
    if (!item) { onNothingLeft(t); return; }

    state.busy = true;
    const gen = state.gen;
    startItem(item, gen).then((opened) => {
      if (gen !== state.gen) return;
      if (opened) {
        state.started++;
        if (cfg.pauseEvery > 0 && state.started % cfg.pauseEvery === 0 && state.running) {
          state.pauseUntil = now() + cfg.pauseSec * 1000;
          log(`☕ Geplante Pause ${fmtS(cfg.pauseSec * 1000)} nach ${state.started} Demos`);
        }
      }
      state.nextAt = Math.max(state.nextAt, now() + rand(cfg.minDelay, cfg.maxDelay) * 1000);
    }).catch((e) => {
      console.error('[LDU]', e);
      if (item.status === 'opening') failItem(item, `Interner Fehler: ${e.message}`);
    }).finally(() => { if (gen === state.gen) state.busy = false; });
  }

  // Hänger: lange kein Fortschritt, obwohl nichts zu warten ist → aktuellen Schritt neu aufsetzen
  function recoverStall(ms) {
    state.stalls++;
    state.gen++;
    state.busy = false;
    state.switching = false;
    closePicker();
    queue.forEach((q) => { if (q.status === 'opening') { q.status = 'queued'; q.tries = Math.max(0, q.tries - 1); } });
    if (cfg.autoRange && state.winIdx >= 0) state.winIdx--; // aktuellen Zeitraum neu laden
    progress();
    log(`⚠ Hänger erkannt: ${fmtS(ms)} kein Fortschritt – setze den aktuellen Schritt neu auf (${state.stalls}/3)`);
    ev('stall', '', { ms, stalls: state.stalls });
    if (state.stalls >= 3) {
      state.paused = true;
      log('⏸ Auto-Pause: Script ist mehrfach hängen geblieben – bitte Bericht schicken.');
      notify('Auto-Pause: Script hing mehrfach');
      ev('autopause', 'stalls', { stalls: state.stalls });
    }
  }

  // Signal aus einem Helfer-Tab (CSNADES-Redirect)
  GM_addValueChangeListener('signal', (_n, _o, sig, remote) => {
    if (!sig || !remote) return;
    const entry = [...state.active.values()].find((e) => e.item.leetifyId === sig.leetifyId);
    if (sig.old) {
      if (entry) entry.old = true;
      else histSet(`L:${sig.leetifyId}`, { s: 'old' });
    }
    if (entry) setTimeout(() => { if (state.active.has(entry.item.key)) { try { entry.tab.close(); } catch (_) { /* ignore */ } } }, 2500);
  });

  // ═════════════ Zeilen-Markierung (nur Attribute + CSS, kein Text im DOM) ═════════════
  const BADGE = {
    queued: ['⏳', 'In der Queue'],
    opening: ['…', 'Wird geöffnet'],
    running: ['🔄', 'Läuft'],
    ok: ['✅', 'Hochgeladen – Leetify braucht 2–15 min'],
    old: ['⌛', 'Laut Extension zu alt für Leetify'],
    timeout: ['⚠️', 'Timeout'],
    error: ['✖', 'Fehler – siehe Log'],
    'skip:ok': ['✓', 'Schon hochgeladen – Seite ≥30 min später neu laden, um zu prüfen, ob es geklappt hat'],
    'skip:running': ['🔄', 'Läuft noch (anderer Lauf)'],
    'skip:old': ['⌛', 'Zu alt für Leetify (Verlauf)'],
    'skip:failed': ['⚠️', 'Früher fehlgeschlagen – "Fehlgeschlagene erneut versuchen" aktivieren'],
    'skip:gaveup': ['⛔', `${MAX_OK_ATTEMPTS}× hochgeladen, Leetify verarbeitet ihn nicht – aufgegeben`],
    'skip:tooOld': ['⌛', 'Älter als dein Altersfilter'],
    'skip:notFaceit': ['', ''],
  };
  function decorate(el, key) {
    if (el.dataset.lduK !== key) el.dataset.lduK = key;
    setBadge(el, key);
  }
  function setBadge(el, key) {
    const q = queue.find((i) => i.key === key);
    const st = q ? q.status : (skipInfo.has(key) ? `skip:${skipInfo.get(key)}` : null);
    const [ic, tip] = BADGE[st] || ['', ''];
    if (el.dataset.ldu !== ic) el.dataset.ldu = ic;
    if (el.dataset.lduTip !== tip) { el.dataset.lduTip = tip; if (tip) el.title = tip; }
  }
  function updateBadge(key) {
    document.querySelectorAll('[data-ldu-k]').forEach((el) => { if (el.dataset.lduK === key) setBadge(el, key); });
  }

  // ═════════════ UI ═════════════
  const TIPS = {
    'ldu-mode': 'Wie das Script arbeitet. "Vollautomatisch" geht selbst alle Zeiträume im Kalender durch, lädt alle offenen Demos hoch und prüft am Ende in einem 2. Durchgang, ob noch was offen ist. Die anderen Modi sind gleich, nur langsamer/schneller. "Nur aktuelle Ansicht" nimmt nur, was gerade angezeigt wird.',
    'ldu-start': 'Startet mit dem gewählten Modus. Danach einfach diesen Tab offen lassen.',
    'ldu-pause': 'Hält nach dem aktuellen Upload an. Laufende Tabs laufen fertig. Nochmal drücken = weitermachen (setzt auch die Auto-Pause zurück).',
    'ldu-stop': 'Beendet den Lauf. Bereits offene Upload-Tabs laufen fertig und werden weiter überwacht.',
    'ldu-test': 'Sucht die erste offene Demo (mit Autopilot auch in älteren Zeiträumen) und lädt nur diese eine hoch. Ideal, um zu prüfen, ob alles bei dir funktioniert.',
    'ldu-scan': 'Sucht in der aktuellen Ansicht nach "Upload Demo"-Zeilen und markiert sie, ohne etwas hochzuladen.',
    'ldu-ai': 'Liest die Matches aus der aktuellen Leetify-Liste (Spalten werden über die Kopfzeile erkannt) und baut einen fertigen Text für Claude/ChatGPT/Gemini: Gesamt, Vergleiche (z. B. letzte 10 vs. 10 davor), 10er-Blöcke, Maps, Tilt-Check, Ausreißer. Der Text verlangt Diagnose statt Tipps. Es wird nichts gesendet.',
    'ldu-ai-api': 'Wie links, aber mit den Daten der Leetify-API: pro Match zusätzlich Reaktionszeit, Preaim, Kopf-/Spray-Accuracy, Counter-Strafing, Flashes, HE-Schaden, Trades, Multi-Kills, CT/T-Rating – plus dein aktuelles Skill-Profil. Braucht deine Steam64-ID (Einstellungen → KI-Analyse). Hängt nicht von der Seitenansicht ab.',
    'ldu-ai-n': 'Wie viele Matches maximal in die Analyse kommen. Wird automatisch erhöht, wenn die Vergleiche mehr brauchen. Bei der Listen-Analyse zählt nur, was im gewählten Zeitraum sichtbar ist.',
    'ldu-ai-compare': 'Vergleichsfenster, getrennt durch Komma. 10/10 = letzte 10 gegen die 10 davor. 30~60 = letzte 30 gegen die letzten 60 insgesamt. Beispiel: 10/10, 30/30, 30~60',
    'ldu-ai-steam': 'Deine Steam64-ID (17 Ziffern, steht in der Steam-Profil-URL …/profiles/7656…). Nur für die API-Analyse. Wird lokal in Tampermonkey gespeichert.',
    'ldu-ai-key': 'Optional: Leetify-API-Key (leetify.com/app/developer). Ohne Key gelten strengere Rate-Limits. Wird nur lokal in Tampermonkey gespeichert, steht nie im Bericht und nie im Code.',
    'ldu-ai-profile': 'Freitext über dich (Rolle, Level/Elo, Maps, Setup, Ziel …). Steht in jedem Export und hilft der KI, die Zahlen einzuordnen. Wird lokal gespeichert, nicht im Code.',
    'ldu-diag': 'Sammelt technische Infos (Zeile, Link, Kalender) und kopiert sie in die Zwischenablage. Schick sie mir, wenn etwas nicht klappt.',
    'ldu-reset': 'Vergisst, welche Matches schon hochgeladen wurden oder fehlgeschlagen sind. Danach wird alles, was noch "Upload Demo" zeigt, erneut versucht.',
    'ldu-help': 'Kurzes Tutorial anzeigen',
    'ldu-report': 'Lädt einen Bericht als Textdatei herunter: Zusammenfassung jedes Laufs (wie viele hochgeladen, Timeouts, Hänger, Lücken), welche Matches mehrfach versucht wurden, und das komplette Protokoll mit Uhrzeiten. Das Protokoll übersteht Neuladen.',
    'ldu-clearlog': 'Löscht das gespeicherte Protokoll (nicht den Verlauf der hochgeladenen Matches).',
    'ldu-faceit': 'Überspringt Zeilen von Matchmaking/Premier/Wingman – dort funktioniert der FACEIT-Upload nicht.',
    'ldu-retry': 'Fehlgeschlagene Uploads werden später automatisch noch einmal versucht (am Ende eines Zeitraums und im 2. Durchgang).',
    'ldu-keep': 'Hängt ein Upload-Tab, bleibt er nach dem Timeout offen, damit du nachsehen kannst, was los ist (z.B. Captcha).',
    'ldu-active': 'Öffnet die Upload-Tabs im Vordergrund statt im Hintergrund. Nur zum Nachsehen/Debuggen.',
    'ldu-auto': 'Autopilot: Das Script stellt selbst nacheinander die Zeiträume im Leetify-Kalender ein, damit alle offenen Demos gefunden werden (Leetify zeigt pro Ansicht nur 120 Matches). Während er läuft, bitte nicht selbst im Kalender klicken.',
    'ldu-stats': 'Offen bereit = noch hochzuladen und Link bekannt · gesamt = alle gefundenen, noch nicht bearbeiteten · Läuft = Upload-Tabs gerade offen · ✅ hochgeladen · ⚠️ fehlgeschlagen · ⌛ zu alt für Leetify',
    'ldu-log': 'Protokoll – das Neueste steht oben.',
  };
  [...SPEED_FIELDS, ...AUTO_FIELDS, ...FILTER_FIELDS].forEach(([k, , , , tip]) => { TIPS[`ldu-${k}`] = tip; });

  const TOUR = [
    ['👋 Willkommen', 'Dieses Script sucht auf Leetify alle Matches mit <b>"Upload Demo"</b> und lädt sie automatisch über deine Upload-Extension hoch – so, als würdest du jede einzeln mit Mittelklick öffnen.'],
    ['✅ Voraussetzungen', '• Deine Upload-Extension (die bei Mittelklick auf "Upload Demo" funktioniert) ist installiert.<br>• Du bist im selben Browser bei <b>Leetify und FACEIT eingeloggt</b>.'],
    ['🧪 Erst testen', 'Drück einmal <b>"1 testen"</b>. Das Script sucht die erste offene Demo und lädt nur diese hoch. Im Log sollte dann "Test erfolgreich" stehen.'],
    ['🤖 Dann alles automatisch', 'Modus <b>"Vollautomatisch"</b> lassen und <b>Start</b> drücken. Das Script stellt selbst die Zeiträume im Kalender ein, lädt alles hoch und prüft am Ende nochmal. <b>Diesen Tab offen lassen</b> – Fortschritt siehst du auch im Tab-Titel.'],
    ['🛟 Wenn was hakt', 'Bei mehreren Fehlern hintereinander pausiert das Script von selbst (meist Captcha oder ausgeloggt). Fahr mit der Maus über jeden Button für eine Erklärung.'],
    ['📋 Hinterher prüfen', 'Alles wird dauerhaft protokolliert. Mit <b>"📋 Bericht"</b> bekommst du eine Textdatei: pro Lauf wie viel geklappt hat, Timeouts, Hänger, Lücken und welche Matches mehrfach versucht wurden. Bei Problemen Bericht oder <b>"Diagnose"</b> schicken.'],
    ['🧠 KI-Analyse', 'Unter <b>⚙ Einstellungen → KI-Analyse</b> trägst du Profil, Vergleiche (z. B. 10/10, 30~60) und für die API-Variante deine Steam64-ID ein. Dann <b>"KI-Analyse"</b> drücken, Text kopieren und in Claude/ChatGPT einfügen. Der Text verlangt Diagnose statt Tipps.'],
  ];

  const CSS = `
  #ldu-panel{position:fixed;right:16px;bottom:16px;z-index:2147483646;width:350px;background:#17171c;color:#e8e8ee;
    font:12px/1.4 system-ui,sans-serif;border:1px solid #f84982;border-radius:10px;box-shadow:0 8px 30px #0008}
  #ldu-panel *{box-sizing:border-box}
  #ldu-head{display:flex;justify-content:space-between;align-items:center;gap:8px;padding:8px 10px;cursor:pointer;font-weight:700;background:#f8498222;border-radius:10px 10px 0 0;user-select:none}
  #ldu-head .hbtn{display:inline-flex;align-items:center;justify-content:center;width:20px;height:20px;border-radius:50%;background:#ffffff1a;font-size:12px;cursor:pointer}
  #ldu-head .hbtn:hover{background:#f84982}
  #ldu-body{position:relative;padding:8px 10px;display:flex;flex-direction:column;gap:6px;max-height:78vh;overflow:auto}
  #ldu-panel.min #ldu-body{display:none}
  #ldu-panel select,#ldu-panel input[type=number],#ldu-panel input[type=text],#ldu-panel input[type=password],#ldu-panel textarea{background:#24242c;color:#fff;border:1px solid #3a3a46;border-radius:5px;padding:4px 5px;width:100%;font:inherit}
  #ldu-panel textarea{resize:vertical;min-height:70px}
  #ldu-panel .fl{display:block;margin-top:6px;color:#c9c9d6}
  #ldu-panel .grid{display:grid;grid-template-columns:1fr 72px;gap:4px 8px;align-items:center;margin-top:6px}
  #ldu-panel .row{display:flex;gap:6px;flex-wrap:wrap}
  #ldu-panel label.cb{display:flex;gap:6px;align-items:center;cursor:pointer}
  #ldu-panel [title]{cursor:help}
  #ldu-panel button[title],#ldu-panel label.cb[title],#ldu-panel select[title]{cursor:pointer}
  #ldu-panel button{flex:1;background:#2c2c36;color:#fff;border:1px solid #444;border-radius:6px;padding:6px;cursor:pointer;font:600 12px system-ui,sans-serif}
  #ldu-panel button:hover:not(:disabled){filter:brightness(1.25)}
  #ldu-panel button.pri{background:#f84982;border-color:#f84982;font-size:13px}
  #ldu-panel button:disabled{opacity:.45;cursor:default}
  #ldu-panel details{background:#1d1d24;border-radius:6px;padding:4px 6px}
  #ldu-panel details summary{cursor:pointer;color:#c9c9d6}
  #ldu-panel .sect{color:#9a9aa8;font-size:11px;margin-top:6px;text-transform:uppercase;letter-spacing:.04em}
  #ldu-stats{background:#202027;border-radius:6px;padding:6px;font-variant-numeric:tabular-nums}
  #ldu-log{background:#0e0e12;border-radius:6px;padding:6px;height:150px;overflow:auto;white-space:pre-wrap;font:11px/1.35 ui-monospace,monospace;margin:0}
  #ldu-panel .hint{color:#9a9aa8;font-size:11px}
  #ldu-tour{position:absolute;inset:0;background:#17171cf5;display:flex;flex-direction:column;justify-content:center;gap:10px;padding:16px;z-index:2;border-radius:0 0 10px 10px}
  #ldu-tour h3{margin:0;font-size:15px;color:#fff}
  #ldu-tour p{margin:0;font-size:13px;line-height:1.5;color:#dcdce6}
  #ldu-tour .dots{color:#f84982;letter-spacing:4px}
  [data-ldu]:not([data-ldu=""])::after{content:" " attr(data-ldu);font-size:12px}
  `;
  const $ = (sel) => panel && panel.querySelector(sel);
  const numRow = ([k, l, mi, ma]) => `<label for="ldu-${k}">${l}</label><input type="number" id="ldu-${k}" min="${mi}" max="${ma}">`;

  function buildPanel() {
    if (panel) {
      if (!document.contains(panel)) document.body.appendChild(panel);
      return;
    }
    const st = document.createElement('style');
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);

    panel = document.createElement('div');
    panel.id = 'ldu-panel';
    if (GM_getValue('minimized', false)) panel.classList.add('min');
    panel.innerHTML = `
      <div id="ldu-head"><span>⬆ Leetify Bulk Upload <span id="ldu-headstat" style="font-weight:400;opacity:.8"></span></span>
        <span><span class="hbtn" id="ldu-help">?</span> <span class="hbtn" id="ldu-mini" title="Ein-/Ausklappen">–</span></span></div>
      <div id="ldu-body">
        <select id="ldu-mode">
          ${Object.entries(MODES).map(([k, m]) => `<option value="${k}">${m.label}</option>`).join('')}
          <option value="custom">🛠 Eigene Einstellungen</option>
        </select>
        <div class="row">
          <button class="pri" id="ldu-start">▶ Start</button>
          <button id="ldu-pause">Pause</button>
          <button id="ldu-stop">Stop</button>
        </div>
        <div class="row">
          <button id="ldu-test">🧪 1 testen</button>
          <button id="ldu-scan">🔍 Scan</button>
          <button id="ldu-diag">🩺 Diagnose</button>
          <button id="ldu-reset">🗑 Verlauf</button>
          <button id="ldu-report">📋 Bericht</button>
        </div>
        <div class="row">
          <button id="ldu-ai">🧠 KI-Analyse (Liste)</button>
          <button id="ldu-ai-api">🧠 KI-Analyse (API)</button>
        </div>
        <div id="ldu-stats"></div>
        <pre id="ldu-log"></pre>
        <details>
          <summary>⚙ Einstellungen</summary>
          <div class="sect">Autopilot</div>
          <label class="cb" id="ldu-auto-l"><input type="checkbox" id="ldu-auto"> Zeiträume automatisch durchgehen</label>
          <div class="grid">${AUTO_FIELDS.map(numRow).join('')}</div>
          <div class="sect">Tempo & Sicherheit</div>
          <div class="grid">${SPEED_FIELDS.map(numRow).join('')}</div>
          <div class="sect">Filter & Verhalten</div>
          <div class="grid">${FILTER_FIELDS.map(numRow).join('')}</div>
          <label class="cb" id="ldu-faceit-l"><input type="checkbox" id="ldu-faceit"> Nur FACEIT-Matches</label>
          <label class="cb" id="ldu-retry-l"><input type="checkbox" id="ldu-retry"> Fehlgeschlagene erneut versuchen</label>
          <label class="cb" id="ldu-keep-l"><input type="checkbox" id="ldu-keep"> Hängende Tabs offen lassen</label>
          <label class="cb" id="ldu-active-l"><input type="checkbox" id="ldu-active"> Tabs im Vordergrund öffnen (Debug)</label>
          <div class="sect">KI-Analyse</div>
          <div class="grid"><label for="ldu-ai-n">Max. Matches</label><input type="number" id="ldu-ai-n" min="10" max="300"></div>
          <label class="fl" for="ldu-ai-compare">Vergleiche (10/10 = letzte 10 vs. 10 davor · 30~60 = letzte 30 vs. letzte 60)</label>
          <input type="text" id="ldu-ai-compare" spellcheck="false">
          <label class="fl" for="ldu-ai-steam">Steam64-ID (für die API-Analyse)</label>
          <input type="text" id="ldu-ai-steam" spellcheck="false" placeholder="7656119…">
          <label class="fl" for="ldu-ai-key">Leetify-API-Key (optional, bleibt lokal)</label>
          <input type="password" id="ldu-ai-key" autocomplete="off" spellcheck="false">
          <label class="fl" for="ldu-ai-profile">Mein Profil (steht in jedem Export)</label>
          <textarea id="ldu-ai-profile" rows="6" spellcheck="false" placeholder="z. B. Rolle, Level/Elo, Hauptmaps, Setup (DPI/Sens), Ziel, wie oft du spielst …"></textarea>
          <div class="row" style="margin-top:6px"><button id="ldu-clearlog">🧹 Protokoll löschen</button></div>
        </details>
        <div class="hint">Diesen Tab offen lassen. Über jeden Button fahren = Erklärung. <b>?</b> oben = Tutorial.</div>
      </div>`;
    document.body.appendChild(panel);

    // Tooltips an Elemente und ihre Labels hängen
    Object.entries(TIPS).forEach(([id, tip]) => {
      const el = panel.querySelector(`#${id}`);
      if (el) el.title = tip;
      const lab = panel.querySelector(`label[for="${id}"]`) || panel.querySelector(`#${id}-l`);
      if (lab) lab.title = tip;
    });

    $('#ldu-head').onclick = (e) => {
      if (e.target.id === 'ldu-help') return;
      panel.classList.toggle('min');
      GM_setValue('minimized', panel.classList.contains('min'));
    };
    $('#ldu-help').onclick = (e) => { e.stopPropagation(); panel.classList.remove('min'); showTour(0); };
    $('#ldu-mode').onchange = (e) => {
      cfg.mode = e.target.value;
      applyMode(cfg.mode);
      saveCfg();
      fillInputs();
      log(`Modus: ${MODES[cfg.mode]?.label || 'Eigene Einstellungen'}`);
      scan();
      render();
    };
    const numInput = ([k, , mi, ma], markCustom) => {
      $(`#ldu-${k}`).onchange = (e) => {
        let v = Math.round(Number(e.target.value));
        if (!Number.isFinite(v)) v = cfg[k];
        cfg[k] = Math.min(ma, Math.max(mi, v));
        if (cfg.minDelay > cfg.maxDelay) cfg.maxDelay = cfg.minDelay;
        if (markCustom) cfg.mode = 'custom';
        saveCfg();
        fillInputs();
        scan();
        render();
      };
    };
    SPEED_FIELDS.forEach((f) => numInput(f, true));
    AUTO_FIELDS.forEach((f) => numInput(f, true));
    FILTER_FIELDS.forEach((f) => numInput(f, false));
    const cb = (id, k, markCustom) => {
      $(id).onchange = (e) => {
        cfg[k] = e.target.checked;
        if (markCustom) cfg.mode = 'custom';
        saveCfg();
        fillInputs();
        scan();
        render();
      };
    };
    cb('#ldu-auto', 'autoRange', true);
    cb('#ldu-retry', 'retryFailed', true);
    cb('#ldu-faceit', 'faceitOnly', false);
    cb('#ldu-keep', 'keepFailedTabs', false);
    cb('#ldu-active', 'activeTab', false);

    $('#ldu-start').onclick = () => startRun(false);
    $('#ldu-test').onclick = () => startRun(true);
    $('#ldu-pause').onclick = () => {
      if (!state.running) return;
      state.paused = !state.paused;
      if (!state.paused) { state.consecFails = 0; state.nextAt = 0; state.stalls = 0; progress(); }
      log(state.paused ? '⏸ Pausiert' : '▶ Fortgesetzt');
      render();
    };
    $('#ldu-stop').onclick = () => endRun('Gestoppt – offene Tabs laufen fertig und werden weiter überwacht', false);
    $('#ldu-scan').onclick = () => {
      const r = scan();
      log(`Scan: ${r.found} "Upload Demo" sichtbar, ${queue.filter((q) => q.status === 'queued').length} in der Queue, ${skipInfo.size} übersprungen.`
        + (r.found ? '' : (cfg.autoRange ? ' Tipp: "Start" sucht automatisch auch in älteren Zeiträumen.' : ' Tipp: Zeitraum oben ändern.')));
      render();
    };
    $('#ldu-reset').onclick = () => {
      if (state.running) { log('Erst stoppen, dann Verlauf löschen.'); return; }
      if (!confirm('Verlauf löschen? Matches, die noch "Upload Demo" zeigen, werden dann wieder versucht.')) return;
      GM_setValue('hist', {});
      hist = {};
      queue.length = 0;
      log('Verlauf gelöscht.');
      scan();
      render();
    };
    $('#ldu-diag').onclick = diagnose;
    $('#ldu-report').onclick = report;
    wireAi();
    $('#ldu-clearlog').onclick = () => {
      if (!confirm('Protokoll löschen? (Der Verlauf der hochgeladenen Matches bleibt.)')) return;
      pendingLog.length = 0;
      GM_setValue(RUNLOG_KEY, []);
      log('🧹 Protokoll gelöscht.');
    };
    fillInputs();
    render();
    renderLog();
    if (!GM_getValue('tourDone', false)) showTour(0);
  }

  function showTour(i) {
    const body = $('#ldu-body');
    if (!body) return;
    let ov = $('#ldu-tour');
    if (!ov) { ov = document.createElement('div'); ov.id = 'ldu-tour'; body.appendChild(ov); }
    const [title, html] = TOUR[i];
    ov.innerHTML = `
      <div class="dots">${TOUR.map((_, j) => (j === i ? '●' : '○')).join('')}</div>
      <h3>${title}</h3><p>${html}</p>
      <div class="row" style="margin-top:6px">
        ${i > 0 ? '<button id="ldu-tprev">← Zurück</button>' : '<button id="ldu-tskip">Überspringen</button>'}
        <button class="pri" id="ldu-tnext">${i < TOUR.length - 1 ? 'Weiter →' : "Los geht's"}</button>
      </div>`;
    body.scrollTop = 0;
    const close = () => { ov.remove(); GM_setValue('tourDone', true); };
    ov.querySelector('#ldu-tnext').onclick = () => (i < TOUR.length - 1 ? showTour(i + 1) : close());
    const p = ov.querySelector('#ldu-tprev');
    if (p) p.onclick = () => showTour(i - 1);
    const s = ov.querySelector('#ldu-tskip');
    if (s) s.onclick = close;
  }

  function fillInputs() {
    if (!panel) return;
    $('#ldu-mode').value = MODES[cfg.mode] ? cfg.mode : 'custom';
    [...SPEED_FIELDS, ...AUTO_FIELDS, ...FILTER_FIELDS].forEach(([k]) => { $(`#ldu-${k}`).value = cfg[k]; });
    $('#ldu-auto').checked = !!cfg.autoRange;
    $('#ldu-retry').checked = !!cfg.retryFailed;
    $('#ldu-faceit').checked = !!cfg.faceitOnly;
    $('#ldu-keep').checked = !!cfg.keepFailedTabs;
    $('#ldu-active').checked = !!cfg.activeTab;
  }

  function statusText() {
    const t = now();
    if (!state.running) return state.active.size ? `🔄 ${state.active.size} Tab(s) laufen noch` : 'Bereit';
    if (state.paused) return '⏸ Pausiert';
    if (!onMatchesPage()) return '↩ Zurück zur Match-Liste wechseln';
    if (state.switching) return '📅 Stelle Zeitraum ein…';
    if (t < state.sleepUntil) return `💤 Nächste Suche in ${fmtS(state.sleepUntil - t)}`;
    if (t < state.pauseUntil) return `☕ Pause noch ${fmtS(state.pauseUntil - t)}`;
    if (state.active.size >= cfg.concurrency) return `🔄 ${state.active.size} Tab(s) laufen`;
    if (t < state.nextAt) return `Nächster Upload in ${fmtS(state.nextAt - t)}`;
    return 'Arbeitet…';
  }

  function render() {
    if (!panel || !document.contains(panel)) return;
    const c = (s) => queue.filter((q) => q.status === s).length;
    const limit = state.testMode ? 1 : cfg.maxPerRun;
    const auto = state.running && cfg.autoRange && state.windows.length
      ? `<br>Zeitraum ${Math.max(0, state.winIdx + 1)}/${state.windows.length}${cfg.autoPasses > 1 ? ` · Durchgang ${state.pass}/${cfg.autoPasses}` : ''}` : '';
    const html = `<b>${statusText()}</b><br>
      Offen ${queue.filter((q) => q.status === 'queued' && isReady(q)).length} bereit / ${c('queued')} gesamt · Läuft ${state.active.size} · ✅ ${c('ok')} · ⚠️ ${c('timeout') + c('error')}${c('old') ? ` · ⌛ ${c('old')}` : ''}<br>
      Dieser Lauf ${state.started}${limit ? `/${limit}` : ''} · Fehler in Folge ${state.consecFails}${auto}`;
    const s = $('#ldu-stats');
    if (s.innerHTML !== html) s.innerHTML = html;
    const hs = $('#ldu-headstat');
    const head = state.running ? (state.paused ? '⏸' : `· ✅ ${c('ok')}`) : '';
    if (hs.textContent !== head) hs.textContent = head;
    $('#ldu-start').disabled = state.running;
    $('#ldu-test').disabled = state.running;
    $('#ldu-pause').disabled = !state.running;
    $('#ldu-pause').textContent = state.paused ? 'Fortsetzen' : 'Pause';
    $('#ldu-stop').disabled = !state.running;
    $('#ldu-mode').disabled = state.running;
  }
  function renderLog() {
    const l = $('#ldu-log');
    if (l) l.textContent = logLines.join('\n');
  }

  const TITLE_RE = /^\[(?:⬆|⏸|💤)[^\]]*\] /;
  function updateTitle() {
    if (!document.title && !state.running) return;
    const clean = document.title.replace(TITLE_RE, '');
    let want = clean;
    if (state.running) {
      const ok = queue.filter((q) => q.status === 'ok').length;
      const icon = state.paused ? '⏸' : (now() < state.sleepUntil ? '💤' : '⬆');
      want = `[${icon} ✅${ok}${cfg.autoRange && state.windows.length ? ` 📅${Math.max(0, state.winIdx + 1)}/${state.windows.length}` : ''}] ${clean}`;
    }
    if (document.title !== want) document.title = want;
  }

  // ═════════════ Bericht ═════════════
  const fmtDT = (t) => new Date(t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const fmtHM = (t) => new Date(t).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });

  function analyzeRuns(L) {
    const runs = [];
    let cur = null;
    for (const e of L) {
      if (e.y === 'run_start') {
        cur = {
          start: e.t, end: null, what: e.m, test: !!(e.d && e.d.test), open: 0, ok: 0, old: 0, timeout: 0, error: 0, durs: [],
          windows: 0, reloads: 0, stalls: 0, autopause: 0, notReady: 0, gaps: [], lastT: e.t, endMsg: '', rowShrink: 0, apErr: '',
        };
        runs.push(cur);
        continue;
      }
      if (!cur || cur.end !== null) continue;
      if (e.t - cur.lastT > 3 * 60e3) cur.gaps.push([cur.lastT, e.t]); // keine Lebenszeichen → Script lief nicht (Tab zu/PC Standby)
      cur.lastT = e.t;
      const d = e.d || {};
      switch (e.y) {
        case 'open': cur.open++; break;
        case 'finish':
          if (d.outcome === 'ok') { cur.ok++; cur.durs.push(d.dur); } else if (d.outcome === 'old') cur.old++; else cur.timeout++;
          break;
        case 'fail': cur.error++; break;
        case 'window': if (d.reload) cur.reloads++; else cur.windows++; break;
        case 'stall': cur.stalls++; break;
        case 'autopause': cur.autopause++; break;
        case 'list_not_ready': cur.notReady++; break;
        case 'rowcheck': if (d.uploadsAfter < d.uploadsBefore - 1) cur.rowShrink++; break;
        case 'autopilot_error': cur.apErr = e.m; break;
        case 'run_end': cur.end = e.t; cur.endMsg = e.m; break;
        default: break;
      }
    }
    return runs;
  }

  function verdict(r, ongoing) {
    const p = [];
    if (r.timeout) p.push(`${r.timeout}× Timeout (Tab schloss sich nicht – Captcha/FACEIT/Leetify hakte)`);
    if (r.error) p.push(`${r.error}× Fehler beim Öffnen`);
    if (r.autopause) p.push(`${r.autopause}× Auto-Pause`);
    if (r.stalls) p.push(`${r.stalls}× Hänger erkannt`);
    if (r.gaps.length) p.push(`${r.gaps.length}× Lücke ohne Lebenszeichen (${r.gaps.map(([a, b]) => `${fmtHM(a)}–${fmtHM(b)}`).join(', ')}) – Tab zu, PC im Standby o.ä.`);
    if (r.notReady) p.push(`${r.notReady}× Liste lud nicht sauber`);
    if (r.reloads) p.push(`${r.reloads}× Zeitraum neu geladen (Zeilen verschwanden)`);
    if (r.apErr) p.push(`Autopilot-Fehler: ${r.apErr}`);
    if (!r.end && !ongoing) p.push('Lauf hat kein Ende im Protokoll (Seite neu geladen/geschlossen während des Laufs?)');
    return p;
  }

  function buildReport() {
    const L = readLog();
    const runs = analyzeRuns(L).reverse();
    const h = GM_getValue('hist', {}) || {};
    const out = [];
    const hr = '═'.repeat(70);
    out.push('LEETIFY BULK UPLOAD – BERICHT', `Erstellt: ${fmtDT(now())} · Script v${VERSION}`, `Protokoll: ${L.length} Einträge${L.length ? ` seit ${fmtDT(L[0].t)}` : ''}`, hr);
    out.push('LETZTE LÄUFE (neueste zuerst)', '');
    runs.slice(0, 10).forEach((r, i) => {
      const endT = r.end || r.lastT;
      const avg = r.durs.length ? Math.round(r.durs.reduce((a, b) => a + b, 0) / r.durs.length / 1000) : 0;
      const max = r.durs.length ? Math.round(Math.max(...r.durs) / 1000) : 0;
      const ongoing = i === 0 && !r.end && state.running;
      out.push(`#${i + 1}  ${fmtDT(r.start)} – ${ongoing ? 'läuft noch' : fmtHM(endT)} (${Math.round((endT - r.start) / 60e3)} min) · ${r.what}`);
      out.push(`    Uploads: ${r.open} geöffnet → ✅ ${r.ok} · ⌛ zu alt ${r.old} · ⚠️ Timeout ${r.timeout} · ✖ Fehler ${r.error} · Dauer Ø ${avg}s / max ${max}s`);
      out.push(`    Zeiträume: ${r.windows} · neu geladen ${r.reloads} · Liste umgebaut nach Öffnen ${r.rowShrink}×`);
      if (r.endMsg) out.push(`    Ende: ${r.endMsg}`);
      const p = verdict(r, ongoing);
      out.push(p.length ? `    Bewertung: ⚠ ${p.join(' | ')}` : `    Bewertung: ✅ sauber ${ongoing ? 'bis jetzt' : 'gelaufen'}`);
      out.push('');
    });
    if (!runs.length) out.push('(noch keine Läufe im Protokoll)', '');

    // Mehrfach geöffnete Matches – genau das, was "ständig neu probieren" wäre
    const opens = {};
    L.filter((e) => e.y === 'open' && e.d).forEach((e) => {
      const o = opens[e.d.key] || (opens[e.d.key] = { n: 0, date: e.d.date, results: [] });
      o.n++;
    });
    L.filter((e) => e.y === 'finish' && e.d && opens[e.d.key]).forEach((e) => opens[e.d.key].results.push(e.d.outcome));
    const rep2 = Object.entries(opens).filter(([, o]) => o.n >= 2).sort((a, b) => b[1].n - a[1].n);
    out.push(hr, `MEHRFACH GEÖFFNETE MATCHES: ${rep2.length}`);
    if (rep2.length) {
      out.push('(Ein Match mit mehreren ✅, das trotzdem wieder auftaucht, wird von Leetify nicht verarbeitet. Nach 3× gibt das Script auf.)');
      rep2.slice(0, 50).forEach(([k, o]) => out.push(`  ${k}  Match vom ${o.date}  ${o.n}× geöffnet  Ergebnisse: ${o.results.join(', ') || '–'}  Verlauf: ${(h[k] || {}).s || '–'}`));
    } else out.push('  keine – jede Demo wurde nur einmal hochgeladen ✅');

    const hv = Object.values(h);
    const cnt = (f) => hv.filter(f).length;
    out.push(hr, 'VERLAUF (alle Matches, die das Script kennt)',
      `  ✅ hochgeladen ${cnt((v) => v.s === 'ok')} · ⚠️ fehlgeschlagen ${cnt((v) => v.s === 'timeout' || v.s === 'error')} · ⌛ zu alt ${cnt((v) => v.s === 'old')} · ⛔ aufgegeben ${cnt((v) => (v.okN || 0) >= MAX_OK_ATTEMPTS)}`);
    out.push(hr, 'EINSTELLUNGEN', `  ${JSON.stringify(cfg)}`);
    out.push(hr, 'PROTOKOLL (älteste zuerst)');
    L.forEach((e) => out.push(`${fmtDT(e.t)}  [${e.y}] ${e.m}${e.d !== undefined ? `  ${JSON.stringify(e.d)}` : ''}`));
    return { text: out.join('\n'), runs };
  }

  function downloadText(name, text) {
    const url = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 15000);
  }

  function report() {
    const { text, runs } = buildReport();
    const d = new Date(now());
    downloadText(`leetify-upload-bericht-${ymd(d)}-${pad(d.getHours())}${pad(d.getMinutes())}.txt`, text);
    const r = runs[0];
    if (r) {
      const p = verdict(r, !r.end && state.running);
      log(`📋 Bericht heruntergeladen. Letzter Lauf: ${r.open} geöffnet → ✅ ${r.ok} · ⚠️ ${r.timeout + r.error}${p.length ? ` · ⚠ ${p.length} Auffälligkeit(en)` : ' · sauber ✅'}`);
    } else log('📋 Bericht heruntergeladen (noch kein Lauf im Protokoll).');
  }

  // ═════════════ KI-Analyse ═════════════
  // Zwei Quellen, ein Format: "Liste" liest die Match-Tabelle der Seite (alle Spalten, die dort stehen),
  // "API" holt viel mehr Werte pro Match von der Leetify Public API. Danach läuft immer dieselbe Auswertung:
  // Vergleiche beliebiger Zeitfenster, Trend in 10er-Blöcken, Maps/Quellen, Tilt-Check, Rauschen-Check.
  const API_BASE = 'https://api-public.cs-prod.leetify.com';
  const AI_DEFAULTS = { n: 60, compare: '10/10, 30/30, 30~60', steam: '', key: '', profile: '' };
  // Eigener Speicher (nicht in cfg!): cfg landet im Bericht/Protokoll – der API-Key soll dort nie auftauchen.
  const aiCfg = () => ({ ...AI_DEFAULTS, ...(GM_getValue('ai', {}) || {}) });
  const aiSave = (patch) => GM_setValue('ai', { ...aiCfg(), ...patch });

  // better: 1 = höher ist besser · -1 = niedriger ist besser · 0 = neutral (nur Richtung).
  // norm: Die Skala (0–1 oder 0–100 bzw. s oder ms) wird anhand der Daten erkannt, weil sie nicht überall dokumentiert ist.
  const MET = {
    rating: { label: 'Leetify-Rating', dec: 3, better: 1 },
    kd: { label: 'K/D', dec: 2, better: 1 },
    kills: { label: 'Kills', dec: 1, better: 1 },
    deaths: { label: 'Deaths', dec: 1, better: -1 },
    assists: { label: 'Assists', dec: 1, better: 1 },
    adr: { label: 'ADR', dec: 1, better: 1 },
    hs: { label: 'HS-Kills %', dec: 1, better: 1, norm: 'pct' },
    survive: { label: 'Runden überlebt %', dec: 1, better: 1, norm: 'pct' },
    aim: { label: 'Aim', dec: 1, better: 1 },
    positioning: { label: 'Positioning', dec: 1, better: 1 },
    utility: { label: 'Utility', dec: 1, better: 1 },
    clutch: { label: 'Clutch', dec: 1, better: 1 },
    opening: { label: 'Opening', dec: 1, better: 1 },
    reaction: { label: 'Reaktionszeit (ms)', dec: 0, better: -1, norm: 'ms' },
    preaim: { label: 'Preaim-Winkel (°)', dec: 1, better: -1 },
    acc_head: { label: 'Kopf-Accuracy %', dec: 1, better: 1, norm: 'pct' },
    acc_spot: { label: 'Accuracy bei sichtbarem Gegner %', dec: 1, better: 1, norm: 'pct' },
    spray: { label: 'Spray-Accuracy %', dec: 1, better: 1, norm: 'pct' },
    cstrafe: { label: 'Counter-Strafing gut %', dec: 1, better: 1, norm: 'pct' },
    trade_k: { label: 'Trade-Kills Erfolg %', dec: 1, better: 1, norm: 'pct' },
    traded_d: { label: 'Traded Deaths Erfolg %', dec: 1, better: 1, norm: 'pct' },
    flash_foe: { label: 'Gegner pro Flash', dec: 2, better: 1 },
    flash_kill: { label: 'Flash→Kill pro Match', dec: 1, better: 1 },
    flash_team: { label: 'Team-Flashes pro Match', dec: 1, better: -1 },
    flash_ast: { label: 'Flash-Assists pro Match', dec: 1, better: 1 },
    he_dmg: { label: 'HE-Schaden pro Granate', dec: 1, better: 1 },
    util_death: { label: 'Utility beim Tod (Ø)', dec: 0, better: -1 },
    multi: { label: 'Multi-Kill-Runden (2k+)', dec: 1, better: 1 },
    ct_rating: { label: 'CT-Rating', dec: 3, better: 1 },
    t_rating: { label: 'T-Rating', dec: 3, better: 1 },
  };

  // ── kleine Statistik-Helfer ──
  const aiClean = (t) => String(t || '').replace(/\s+/g, ' ').trim();
  const fin = (a) => a.filter((x) => Number.isFinite(x));
  const mean = (a) => { const v = fin(a); return v.length ? v.reduce((s, x) => s + x, 0) / v.length : NaN; };
  const sdev = (a) => {
    const v = fin(a);
    if (v.length < 2) return NaN;
    const m = mean(v);
    return Math.sqrt(v.reduce((s, x) => s + (x - m) ** 2, 0) / (v.length - 1));
  };
  // Zahl formatieren; "-0.00" wird zu "0.00"
  const fnum = (v, d = 2, sign = false) => {
    if (!Number.isFinite(v)) return '–';
    const z = Math.abs(v) < 0.5 * 10 ** -d ? 0 : v;
    const s = z.toFixed(d);
    return sign && z > 0 ? `+${s}` : s;
  };
  const isW = (r) => r.res === 'W';
  const isL = (r) => r.res === 'L';
  const wrOf = (arr) => (arr.length ? (100 * arr.filter(isW).length) / arr.length : NaN);
  const wlText = (arr) => `${arr.filter(isW).length}W/${arr.filter(isL).length}L${arr.some((r) => r.res === 'D') ? `/${arr.filter((r) => r.res === 'D').length}D` : ''} (${fnum(wrOf(arr), 0)}%)`;
  const col = (arr, id) => arr.map((r) => (r.m[id] === undefined ? NaN : r.m[id]));
  const spanOf = (arr) => { // arr = neueste zuerst
    const d = arr.map((r) => r.date).filter((x) => /^20\d{2}-\d{2}-\d{2}/.test(x)).map((x) => x.slice(0, 10));
    return d.length ? `${d[d.length - 1]} … ${d[0]}` : 'Datum unbekannt';
  };
  // Unterschied zweier Mittelwerte in Standardfehlern (Welch). ≥2 = klar, ≥1 = Tendenz, sonst Rauschen.
  const zMeans = (a, b) => {
    const va = fin(a), vb = fin(b);
    if (va.length < 3 || vb.length < 3) return NaN;
    const se = Math.sqrt(sdev(va) ** 2 / va.length + sdev(vb) ** 2 / vb.length);
    return se > 0 ? (mean(va) - mean(vb)) / se : NaN;
  };
  const zProp = (w1, n1, w2, n2) => {
    if (n1 < 3 || n2 < 3) return NaN;
    const p = (w1 + w2) / (n1 + n2);
    const se = Math.sqrt(p * (1 - p) * (1 / n1 + 1 / n2));
    return se > 0 ? (w1 / n1 - w2 / n2) / se : NaN;
  };
  const noiseWord = (z) => (!Number.isFinite(z) ? 'zu wenig Daten' : Math.abs(z) >= 2 ? 'klar' : Math.abs(z) >= 1 ? 'Tendenz' : 'im Rauschen');
  const dirWord = (delta, better, dec) => {
    if (!Number.isFinite(delta) || Math.abs(delta) < 0.5 * 10 ** -dec) return 'gleich';
    if (!better) return delta > 0 ? 'höher' : 'niedriger';
    return (delta > 0) === (better > 0) ? 'besser' : 'schlechter';
  };

  // "10/10" = letzte 10 vs. die 10 davor · "30~60" = letzte 30 vs. letzte 60 insgesamt
  function parseCompare(spec) {
    const out = [];
    out.bad = []; // nicht verstandene Einträge → der User bekommt eine Meldung statt stillem Ignorieren
    String(spec || '').split(/[\s,;]+/).filter(Boolean).forEach((tok) => {
      let m = tok.match(/^(\d{1,3})\/(\d{1,3})$/);
      if (m && +m[1] > 0 && +m[2] > 0) { out.push({ kind: 'prev', a: +m[1], b: +m[2], label: `Letzte ${m[1]} vs. die ${m[2]} davor` }); return; }
      m = tok.match(/^(\d{1,3})~(\d{1,3})$/);
      if (m && +m[1] > 0 && +m[1] < +m[2]) { out.push({ kind: 'incl', a: +m[1], b: +m[2], label: `Letzte ${m[1]} vs. letzte ${m[2]} insgesamt` }); return; }
      out.bad.push(tok);
    });
    return out;
  }
  const aiNeeded = (comps) => comps.reduce((mx, c) => Math.max(mx, c.kind === 'prev' ? c.a + c.b : c.b), 0);
  const aiWant = (a, comps) => Math.min(300, Math.max(a.n, aiNeeded(comps)));

  // ── Quelle 1: Match-Tabelle auf der Seite ──
  const DOM_HEAD = [
    [/premier|rank|elo|level|rang/i, 'rank'],
    [/k\s*\/\s*d|^kd$/i, 'kd'],
    [/rating/i, 'rating'],
    [/^k(ills?)?$/i, 'kills'],
    [/^d(eaths?)?$/i, 'deaths'],
    [/^a(ssists?)?$/i, 'assists'],
    [/adr|damage|dpr/i, 'adr'],
    [/^aim/i, 'aim'],
    [/position/i, 'positioning'],
    [/^util/i, 'utility'],
    [/react/i, 'reaction'],
    [/pre-?aim|crosshair/i, 'preaim'],
    [/spray/i, 'spray'],
    [/head|^hs/i, 'acc_head'],
    [/strafe/i, 'cstrafe'],
    [/clutch/i, 'clutch'],
    [/opening/i, 'opening'],
  ];
  const domMetricId = (h) => { for (const [re, id] of DOM_HEAD) { if (re.test(h)) return id; } return null; };
  const NUM_CELL = /^[+\-−]?\d[\d.,]*\s*(?:%|ms|s|°)?$/;
  function aiNum(t) {
    let s = aiClean(t).replace(/−/g, '-');
    if (!NUM_CELL.test(s)) return NaN;
    s = s.replace(/\s*(?:%|ms|s|°)$/, '');
    s = /^[+-]?\d{1,3}(?:,\d{3})+(?:\.\d+)?$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.'); // "21,323" = Tausender
    const v = parseFloat(s);
    return Number.isFinite(v) ? v : NaN;
  }

  function readListRows() {
    const raw = [];
    let headers = [];
    document.querySelectorAll('tr').forEach((tr) => {
      if (!outsidePanel(tr)) return;
      const tds = Array.from(tr.children).filter((c) => c.tagName === 'TD' && c.getAttribute('aria-hidden') !== 'true');
      if (tds.length < 8) return;
      const cells = tds.map((td) => aiClean(td.innerText || td.textContent));
      const sc = cells.findIndex((c) => /^\d{1,2} : \d{1,2}$/.test(c));
      if (sc < 1) return;
      const table = tr.closest('table');
      if (!headers.length && table) {
        headers = Array.from(table.querySelectorAll('thead th'))
          .filter((h) => h.getAttribute('aria-hidden') !== 'true')
          .map((h) => aiClean(h.innerText || h.textContent || h.getAttribute('aria-label') || h.title));
      }
      const img = tr.querySelector('app-data-source-icon img');
      raw.push({ cells, sc, hasUpload: cells.some((c) => /upload demo/i.test(c)), src: img ? img.alt : '' });
    });

    const usable = raw.filter((r) => !r.hasUpload);
    const defs = {};
    const rows = [];
    let fallbackUsed = false;
    usable.forEach((r) => {
      const c = r.cells, sc = r.sc;
      const [a, b] = c[sc].split(':').map((x) => parseInt(x, 10));
      const m = {};
      let rank = '';
      if (headers.length === c.length) {
        // Spalten über die Kopfzeile zuordnen: alles, was die Liste zeigt, kommt mit
        c.forEach((txt, j) => {
          if (j <= sc || !headers[j]) return;
          const id = domMetricId(headers[j]);
          if (id === 'rank') { rank = rank || txt; return; }
          const v = aiNum(txt);
          if (!Number.isFinite(v)) return;
          const key = id || `x_${headers[j].toLowerCase().replace(/[^a-z0-9äöüß]+/g, '_').replace(/^_+|_+$/g, '')}`;
          if (!defs[key]) defs[key] = id ? { ...MET[id] } : { label: headers[j], dec: 2, better: 0, custom: true };
          m[key] = v;
        });
      } else {
        // Kopfzeile passt nicht zur Zeile → alte Positions-Logik: [Rang-Text], Rating, K, D, K/D, weitere Spalten
        fallbackUsed = true;
        const after = c.slice(sc + 1);
        const rt = after[0] && !/^[+-]?\d/.test(after[0]) ? after[0] : '';
        rank = rt;
        const nums = (rt ? after.slice(1) : after).filter((x) => /^[+-]?\d+(\.\d+)?$/.test(x)).map(parseFloat);
        ['rating', 'kills', 'deaths', 'kd'].forEach((id, k) => {
          if (Number.isFinite(nums[k])) { m[id] = nums[k]; defs[id] = defs[id] || { ...MET[id] }; }
        });
        nums.slice(4).forEach((v, k) => {
          const key = `x_spalte_${k + 5}`;
          defs[key] = defs[key] || { label: `Spalte ${k + 5} (Name unbekannt)`, dec: 1, better: 0, custom: true };
          m[key] = v;
        });
      }
      const iso = c.find((x) => /^20\d{2}-\d{2}-\d{2}$/.test(x));
      rows.push({
        map: c[0], date: iso || c[sc - 1] || c[1] || '?', score: c[sc], res: a > b ? 'W' : a < b ? 'L' : 'D',
        rank, src: r.src || c[c.length - 1], m,
      });
    });
    const good = rows.filter((x) => x.map);

    // Reihenfolge: neueste zuerst. Die Liste kann zwei Zeiträume enthalten → stabil nach Datum sortieren.
    const iso = (r) => (/^20\d{2}-\d{2}-\d{2}$/.test(r.date) ? r.date : '');
    if (good.length > 1 && good.filter(iso).length >= good.length * 0.8) {
      if (iso(good[0]) && iso(good[good.length - 1]) && good[0].date < good[good.length - 1].date) good.reverse();
      good.forEach((r, i) => { r._i = i; });
      good.sort((x, y) => (iso(y) > iso(x) ? 1 : iso(y) < iso(x) ? -1 : x._i - y._i));
    }
    return { rows: good, defs, headers, skippedUpload: raw.length - usable.length, fallbackUsed };
  }

  // ── Quelle 2: Leetify Public API ──
  function gmGetJson(url, headers) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url, headers: { Accept: 'application/json', ...headers }, timeout: 30000,
        onload: (r) => {
          if (r.status < 200 || r.status >= 300) {
            const hint = { 401: ' – API-Key ungültig?', 403: ' – API-Key ungültig oder Zugriff verweigert?', 404: ' – Steam64-ID nicht gefunden (Profil bei Leetify registriert?)', 429: ' – Rate-Limit: später nochmal oder API-Key eintragen' }[r.status] || '';
            reject(new Error(`HTTP ${r.status}${hint}`));
            return;
          }
          try { resolve(JSON.parse(r.responseText)); } catch (_) { reject(new Error('Antwort ist kein JSON')); }
        },
        onerror: () => reject(new Error('Netzwerkfehler – hat Tampermonkey den Zugriff auf api-public.cs-prod.leetify.com erlaubt?')),
        ontimeout: () => reject(new Error('Timeout (30 s)')),
      });
    });
  }

  function apiRow(mt, steam) {
    const p = (mt.stats || []).find((s) => String(s.steam64_id) === steam);
    if (!p) return null;
    const n = (x) => (x === null || x === undefined || x === '' ? NaN : Number(x));
    const per = (x, y) => (n(y) > 0 ? n(x) / n(y) : NaN);
    const rw = n(p.rounds_won), rl = n(p.rounds_lost), rounds = n(p.rounds_count);
    const ts = Date.parse(mt.finished_at);
    return {
      date: String(mt.finished_at || '').slice(0, 10) || '?', ts: Number.isFinite(ts) ? ts : NaN,
      map: String(mt.map_name || '?').replace(/^de_/, ''), src: mt.data_source || '?',
      score: `${rw} : ${rl}`, res: rw > rl ? 'W' : rw < rl ? 'L' : 'D', rank: '',
      m: {
        rating: n(p.leetify_rating), kd: n(p.kd_ratio), kills: n(p.total_kills), deaths: n(p.total_deaths), assists: n(p.total_assists),
        adr: rounds > 0 ? n(p.total_damage) / rounds : n(p.dpr),
        hs: per(p.total_hs_kills, p.total_kills) * 100, survive: n(p.rounds_survived_percentage),
        reaction: n(p.reaction_time), preaim: n(p.preaim),
        acc_head: n(p.accuracy_head), acc_spot: n(p.accuracy_enemy_spotted), spray: n(p.spray_accuracy),
        cstrafe: n(p.counter_strafing_shots_good_ratio),
        trade_k: n(p.trade_kills_success_percentage), traded_d: n(p.traded_deaths_success_percentage),
        flash_foe: per(p.flashbang_hit_foe, p.flashbang_thrown), flash_kill: n(p.flashbang_leading_to_kill),
        flash_team: n(p.flashbang_hit_friend), flash_ast: n(p.flash_assist),
        he_dmg: n(p.he_foes_damage_avg), util_death: n(p.utility_on_death_avg),
        multi: n(p.multi2k) + n(p.multi3k) + n(p.multi4k) + n(p.multi5k),
        ct_rating: n(p.ct_leetify_rating), t_rating: n(p.t_leetify_rating),
      },
    };
  }

  function apiProfileBlock(p) {
    if (!p || typeof p !== 'object') return [];
    const r = p.rating || {}, rk = p.ranks || {}, st = p.stats || {};
    const num = (v) => (v === null || v === undefined || v === '' ? NaN : Number(v));
    const r2 = (v) => (Number.isFinite(num(v)) ? String(Math.round(num(v) * 100) / 100) : '–');
    const pick = (obj, pairs) => pairs.filter(([k]) => obj[k] !== null && obj[k] !== undefined).map(([k, l]) => `${l} ${r2(obj[k])}`);
    const L = ['## Leetify-Profil laut API (aktuell, über alle Matches)'];
    const sk = pick(r, [['aim', 'Aim'], ['positioning', 'Positioning'], ['utility', 'Utility'], ['clutch', 'Clutch'], ['opening', 'Opening'], ['ct_leetify', 'CT-Leetify'], ['t_leetify', 'T-Leetify']]);
    if (sk.length) L.push(`Skill-Scores: ${sk.join(' · ')}`);
    const rs = pick(rk, [['premier', 'Premier'], ['faceit', 'FACEIT-Level'], ['faceit_elo', 'FACEIT-Elo'], ['leetify', 'Leetify-Rang']]);
    if (rs.length) L.push(`Ränge: ${rs.join(' · ')}`);
    const ss = pick(st, [
      ['reaction_time_ms', 'Reaktionszeit (ms)'], ['preaim', 'Preaim'], ['accuracy_head', 'Kopf-Accuracy'], ['accuracy_enemy_spotted', 'Accuracy sichtbar'],
      ['spray_accuracy', 'Spray-Accuracy'], ['counter_strafing_good_shots_ratio', 'Counter-Strafing'],
      ['t_opening_aggression_success_rate', 'T-Opening-Aggression'], ['ct_opening_aggression_success_rate', 'CT-Opening-Aggression'],
      ['t_opening_duel_success_percentage', 'T-Opening-Duelle'], ['ct_opening_duel_success_percentage', 'CT-Opening-Duelle'],
      ['trade_kills_success_percentage', 'Trade-Kills'], ['traded_deaths_success_percentage', 'Traded Deaths'],
      ['flashbang_hit_foe_per_flashbang', 'Gegner/Flash'], ['flashbang_hit_friend_per_flashbang', 'Team/Flash'],
      ['he_foes_damage_avg', 'HE-Schaden'], ['utility_on_death_avg', 'Utility beim Tod'],
    ]);
    if (ss.length) L.push(`Durchschnittswerte (alle Matches, Skala wie von der API geliefert): ${ss.join(' · ')}`);
    const wr = num(p.winrate);
    if (Number.isFinite(wr)) L.push(`Winrate gesamt ${r2(wr <= 1 ? wr * 100 : wr)}% · Matches gesamt ${p.total_matches ?? '–'}`);
    return L.length > 1 ? L : [];
  }

  // ── Auswertung (für beide Quellen gleich) ──
  function aiNormalize(rows, defs) {
    for (const [id, d] of Object.entries(defs)) {
      if (d.norm) {
        const v = fin(col(rows, id));
        if (v.length) {
          const mx = Math.max(...v);
          const f = d.norm === 'pct' ? (mx <= 1 ? 100 : 1) : (mx <= 5 ? 1000 : 1);
          if (f !== 1) rows.forEach((r) => { if (Number.isFinite(r.m[id])) r.m[id] *= f; });
        }
      }
      if (d.custom) d.dec = col(rows, id).some((x) => Number.isFinite(x) && !Number.isInteger(x)) ? 2 : 0;
    }
  }

  function aiCompare(c, rows, defs) {
    const A = rows.slice(0, c.a);
    const B = c.kind === 'prev' ? rows.slice(c.a, c.a + c.b) : rows.slice(0, c.b);
    const REST = c.kind === 'prev' ? B : rows.slice(c.a, c.b); // unabhängige Vergleichsgruppe für den Rauschen-Check
    const head = `### ${c.label}`;
    if (A.length < 3 || B.length < 3 || REST.length < 3) return `${head}\n(zu wenig Matches vorhanden: A=${A.length}, B=${B.length})\n`;
    const L = [head];
    const bName = c.kind === 'prev' ? `die ${B.length} davor` : `letzte ${B.length} gesamt`;
    L.push(`A = neueste ${A.length} (${spanOf(A)}) · B = ${bName} (${spanOf(B)})${A.length < c.a || B.length < (c.kind === 'prev' ? c.b : c.b) ? ' · weniger Matches als gewünscht vorhanden' : ''}`);
    L.push('Metrik | A | B | Δ (A−B) | Wertung');
    const dW = wrOf(A) - wrOf(B);
    const zW = zProp(A.filter(isW).length, A.length, REST.filter(isW).length, REST.length);
    L.push(`Winrate | ${wlText(A)} | ${wlText(B)} | ${fnum(dW, 0, true)}pp | ${dirWord(dW, 1, 0)}, ${noiseWord(zW)}`);
    Object.keys(defs).forEach((id) => {
      const va = fin(col(A, id)), vb = fin(col(B, id));
      if (va.length < 3 || vb.length < 3) return;
      const d = defs[id].dec;
      const dl = mean(va) - mean(vb);
      L.push(`${defs[id].label} | ${fnum(mean(va), d)} | ${fnum(mean(vb), d)} | ${fnum(dl, d, true)} | ${dirWord(dl, defs[id].better, d)}, ${noiseWord(zMeans(col(A, id), col(REST, id)))}`);
    });
    return L.join('\n');
  }

  // Die wichtigsten Werte zuerst (für Blöcke und Einzel-Tabelle), Rest in der Reihenfolge von MET / Liste
  const PRIORITY = ['rating', 'kd', 'adr', 'aim', 'positioning', 'utility', 'reaction', 'preaim', 'acc_head', 'spray', 'cstrafe', 'kills', 'deaths'];

  function aiAnalysis(rows, ctx) {
    const { defs, comps } = ctx;
    const total = rows.length;
    const ids = Object.keys(defs).filter((id) => fin(col(rows, id)).length >= Math.max(3, total * 0.5));
    const lab = (id) => defs[id].label;
    const dec = (id) => defs[id].dec;
    const out = [];

    // Datenbasis
    const bySrc = {};
    rows.forEach((r) => { (bySrc[r.src || '?'] = bySrc[r.src || '?'] || []).push(r); });
    out.push('## Datenbasis');
    out.push(`- Quelle: ${ctx.sourceLabel}`);
    out.push(`- ${total} Matches (${spanOf(rows)}) · nach Quelle: ${Object.entries(bySrc).map(([k, v]) => `${k} ${v.length}`).join(', ')}`);
    if (total < ctx.want) out.push(`- Gewünscht waren ${ctx.want} Matches, vorhanden sind ${total}. Vergleiche mit größeren Fenstern fallen entsprechend kleiner aus.`);
    const grp = (b) => ids.filter((id) => Math.sign(defs[id].better) === b).map(lab).join(', ');
    out.push(`- Werte pro Match, höher = besser: ${grp(1) || '–'}`);
    if (grp(-1)) out.push(`- Werte pro Match, niedriger = besser: ${grp(-1)}`);
    if (grp(0)) out.push(`- Werte pro Match, neutral/unbekannte Richtung: ${grp(0)}`);
    const top = (n) => [...PRIORITY.filter((id) => ids.includes(id)), ...ids.filter((id) => !PRIORITY.includes(id))].slice(0, n);
    (ctx.notes || []).forEach((n) => out.push(`- ${n}`));

    // Gesamt
    const streak = (arr) => {
      let cur = 0;
      for (const r of arr) { if (r.res === arr[0].res) cur++; else break; }
      let bw = 0, bl = 0, run = 0, last = '';
      for (const r of arr) {
        if (r.res === last) run++; else { last = r.res; run = 1; }
        if (r.res === 'W') bw = Math.max(bw, run);
        if (r.res === 'L') bl = Math.max(bl, run);
      }
      return { cur, res: arr[0].res, bw, bl };
    };
    const sk = streak(rows);
    out.push('', `## Gesamt (${total} Matches)`);
    out.push(`Winrate ${wlText(rows)} · Form (neueste zuerst): ${rows.slice(0, 10).map((r) => r.res).join('')} · aktuelle Serie: ${sk.cur}× ${sk.res} · längste Siegesserie ${sk.bw}, längste Niederlagenserie ${sk.bl}`);
    out.push('Metrik | Ø | Streuung (SD) | Min | Max');
    ids.forEach((id) => {
      const v = col(rows, id);
      out.push(`${lab(id)} | ${fnum(mean(v), dec(id))} | ${fnum(sdev(v), dec(id))} | ${fnum(Math.min(...fin(v)), dec(id))} | ${fnum(Math.max(...fin(v)), dec(id))}`);
    });

    // Vergleiche
    out.push('', '## Vergleiche (A = die neueren Matches)');
    if (!comps.length) out.push('(keine gültigen Vergleiche eingestellt)');
    comps.forEach((c, i) => { if (i) out.push(''); out.push(aiCompare(c, rows, defs)); });

    // Verlauf in Blöcken
    const bids = top(5);
    out.push('', '## Verlauf in 10er-Blöcken (Block 1 = neueste)');
    out.push(`Block | Zeitraum | S-N | Winrate | ${bids.map(lab).join(' | ')}`);
    for (let i = 0; i < total; i += 10) {
      const blk = rows.slice(i, i + 10);
      out.push(`${i / 10 + 1}${blk.length < 10 ? ` (nur ${blk.length})` : ''} | ${spanOf(blk)} | ${blk.filter(isW).length}-${blk.filter(isL).length} | ${fnum(wrOf(blk), 0)}% | ${bids.map((id) => fnum(mean(col(blk, id)), dec(id))).join(' | ')}`);
    }

    // Maps & Quellen
    const gids = ['rating', 'kd', 'adr'].filter((id) => ids.includes(id));
    const groupTable = (title, keyFn) => {
      const g = {};
      rows.forEach((r) => { const k = keyFn(r) || '?'; (g[k] = g[k] || []).push(r); });
      const big = Object.entries(g).filter(([, v]) => v.length >= 2).sort((x, y) => y[1].length - x[1].length);
      const small = Object.values(g).filter((v) => v.length < 2).flat();
      const line = (k, v) => `${k} | ${v.length} | ${v.filter(isW).length}-${v.filter(isL).length} | ${fnum(wrOf(v), 0)}% | ${gids.map((id) => fnum(mean(col(v, id)), dec(id))).join(' | ')}`;
      out.push('', `## ${title}`, `${title.replace('Nach ', '')} | Matches | S-N | Winrate | ${gids.map(lab).join(' | ')}`);
      big.forEach(([k, v]) => out.push(line(k, v)));
      if (small.length) out.push(line('(je nur 1 Match)', small));
      if (big.some(([, v]) => v.length < 5)) out.push('Hinweis: Gruppen mit weniger als 5 Matches sind statistisch dünn.');
    };
    groupTable('Nach Map', (r) => r.map);
    if (Object.keys(bySrc).length > 1) groupTable('Nach Quelle', (r) => r.src);

    // Tilt-Check (rows = neueste zuerst → Vorgänger-Match ist Index + 1)
    const afterW = [], afterL = [], afterLL = [];
    for (let i = 0; i < total - 1; i++) {
      if (rows[i + 1].res === 'W') afterW.push(rows[i]);
      if (rows[i + 1].res === 'L') afterL.push(rows[i]);
      if (i < total - 2 && rows[i + 1].res === 'L' && rows[i + 2].res === 'L') afterLL.push(rows[i]);
    }
    const tl = (name, arr) => `${name} (n=${arr.length}): Winrate ${fnum(wrOf(arr), 0)}%${ids.includes('rating') ? `, Ø Rating ${fnum(mean(col(arr, 'rating')), dec('rating'), true)}` : ''}${ids.includes('kd') ? `, Ø K/D ${fnum(mean(col(arr, 'kd')), 2)}` : ''}`;
    out.push('', '## Tilt-Check (wie spiele ich direkt nach Sieg / Niederlage?)');
    out.push(tl('Nach einem Sieg', afterW), tl('Nach einer Niederlage', afterL), tl('Nach 2+ Niederlagen in Folge', afterLL));

    // Ausreißer
    const key = ids.includes('rating') ? 'rating' : ids.includes('kd') ? 'kd' : ids[0];
    if (key && total >= 6) {
      const ranked = rows.filter((r) => Number.isFinite(r.m[key])).sort((x, y) => y.m[key] - x.m[key]);
      const fm = (r) => `${r.date} ${r.map} ${r.score} ${r.res} ${lab(key)} ${fnum(r.m[key], dec(key), true)}`;
      out.push('', `## Ausreißer (nach ${lab(key)})`);
      out.push(`Beste 3: ${ranked.slice(0, 3).map(fm).join(' · ')}`);
      out.push(`Schlechteste 3: ${ranked.slice(-3).reverse().map(fm).join(' · ')}`);
    }

    // Einzelne Matches
    const mids = top(8);
    const hasRank = rows.some((r) => r.rank);
    // ganze Zahlen (Kills, Deaths …) ohne ".0" anzeigen
    const cell = (v, id) => (Number.isInteger(v) && dec(id) <= 1 ? String(v) : fnum(v, dec(id), id === 'rating'));
    out.push('', `## Einzelne Matches (neueste zuerst${ids.length > mids.length ? `; nur die ${mids.length} wichtigsten Werte, alle anderen stehen in den Tabellen oben` : ''})`);
    out.push(`Datum | Map | Score | Erg. | Quelle${hasRank ? ' | Rang' : ''} | ${mids.map(lab).join(' | ')}`);
    rows.forEach((r) => {
      out.push(`${r.date} | ${r.map} | ${r.score} | ${r.res} | ${r.src || '–'}${hasRank ? ` | ${r.rank || '–'}` : ''} | ${mids.map((id) => cell(r.m[id], id)).join(' | ')}`);
    });
    return out.join('\n');
  }

  function aiPrompt(rows, ctx) {
    const a = aiCfg();
    const L = [];
    L.push('Du bist ein nüchterner CS2-Datenanalyst. Unten stehen meine letzten Matches aus Leetify (neueste zuerst).', '');
    L.push('AUFTRAG: Sag mir, wie es um mein Spiel STEHT. Keine Ratschläge.');
    L.push('- Gib KEINE Verbesserungsvorschläge, Übungen, Trainingspläne oder Tipps, solange ich nicht ausdrücklich danach frage. Nur Diagnose.');
    L.push('- Beschreibe: was läuft schlecht, wo habe ich mich verbessert, was ist stabil geblieben und was man in den Matches sehen kann (Maps, Quelle, Serien, Ausreißer, Tilt).');
    L.push('- Belege jede Aussage mit Zahlen aus den Daten (Beispiel: "Rating +0.012 → −0.034") und nenne die Stichprobengröße, wenn sie dünn ist.');
    L.push('- Spalte "Wertung" in den Vergleichen: "im Rauschen" = der Unterschied ist bei dieser Stichprobengröße nicht von Zufall zu trennen, also nicht als Trend darstellen. "Tendenz" = Hinweis, "klar" = belastbar. Die Wertung vergleicht Fenster A mit den Matches, die NICHT in A liegen.');
    L.push('- Pro Vergleich stehen viele Werte nebeneinander: Ein einzelnes "klar" kann allein durch Zufall entstehen. Gewichte Muster über mehrere zusammengehörige Werte stärker als einzelne Ausreißer und sag, wenn etwas nur ein Einzelwert ist.');
    L.push('- Erfinde nichts. Fehlt ein Wert, sag es. Nenne am Ende, welche Auswertungen mit diesen Daten nicht möglich waren.');
    L.push('- Antworte auf Deutsch, knapp, in diesen Abschnitten: 1. Gesamtbild · 2. Was läuft schlecht (nach Gewicht sortiert) · 3. Wo ich mich verbessert habe (nach Gewicht sortiert) · 4. Was die Matches zeigen · 5. Vergleich der Zeiträume (je Vergleich 2–3 Sätze) · 6. Offene Punkte / Datenlücken.');
    if (a.profile.trim()) L.push('', '## Über mich (nur als Kontext, um die Zahlen einzuordnen; daraus bitte keine Tipps ableiten)', a.profile.trim());
    L.push('', aiAnalysis(rows, ctx));
    if (ctx.profileBlock && ctx.profileBlock.length) L.push('', ...ctx.profileBlock);
    return L.join('\n');
  }

  function exportFromList() {
    const a = aiCfg();
    const comps = parseCompare(a.compare);
    if (comps.bad.length) log(`🧠 Vergleich nicht verstanden und ignoriert: ${comps.bad.join(', ')} (erlaubt: 10/10 oder 30~60)`);
    const want = aiWant(a, comps);
    const rd = readListRows();
    if (!rd.rows.length) { log('🧠 Keine Match-Zeilen mit Werten gefunden. Öffne "Matches" und warte, bis die Liste geladen ist (reine "Upload Demo"-Zeilen haben keine Werte).'); return; }
    const rows = rd.rows.slice(0, want);
    aiNormalize(rows, rd.defs);
    const notes = [];
    const heads = rd.headers.filter(Boolean);
    notes.push(`Spalten der Liste: ${heads.join(' | ') || 'keine Kopfzeile gefunden'}`);
    if (rd.fallbackUsed) notes.push('Die Kopfzeile passte nicht zu den Zeilen: Spalten wurden nach Position zugeordnet (Rating, Kills, Deaths, K/D, danach unbenannt). Namen können falsch sein.');
    if (rd.skippedUpload) notes.push(`${rd.skippedUpload} Matches ohne hochgeladene Demo (nur "Upload Demo") wurden ausgelassen.`);
    notes.push('Score = eigene Runden zuerst. Die Liste zeigt nur die Werte, die Leetify dort anzeigt; Details wie Reaktionszeit, Preaim, Spray oder Flashes liefert die API-Analyse.');
    const text = aiPrompt(rows, { defs: rd.defs, comps, want, sourceLabel: 'Match-Liste auf leetify.com (Tabelle der Seite)', notes });
    showAIExport(text, rows.length, 'Liste');
    const miss = rows.length < want ? ` – gewünscht ${want}. Stell oben einen größeren Zeitraum ein (z. B. Last 90 Days) und drück nochmal.` : '';
    log(`🧠 KI-Export (Liste): ${rows.length} Matches, ${Object.keys(rd.defs).length} Werte pro Match${miss}`);
  }

  async function exportFromApi() {
    const a = aiCfg();
    const steam = (String(a.steam).match(/\d{17}/) || [''])[0];
    if (!steam) { log('🧠 Für die API-Analyse fehlt deine Steam64-ID (17 Ziffern) unter ⚙ Einstellungen → KI-Analyse.'); return; }
    const key = String(a.key || '').trim();
    const hdr = key ? { _leetify_key: key, Authorization: `Bearer ${key}` } : {};
    const comps = parseCompare(a.compare);
    if (comps.bad.length) log(`🧠 Vergleich nicht verstanden und ignoriert: ${comps.bad.join(', ')} (erlaubt: 10/10 oder 30~60)`);
    const want = aiWant(a, comps);
    log('🧠 Lade Matches von der Leetify-API …');
    let raw;
    try { raw = await gmGetJson(`${API_BASE}/v3/profile/matches?steam64_id=${steam}`, hdr); } catch (e) { log(`🧠 API-Fehler (Matches): ${e.message}`); return; }
    let prof = null;
    try { prof = await gmGetJson(`${API_BASE}/v3/profile?steam64_id=${steam}`, hdr); } catch (e) { log(`🧠 Profil nicht geladen (${e.message}) – die Analyse läuft ohne Profil-Block.`); }
    const list = Array.isArray(raw) ? raw : ((raw && (raw.matches || raw.recent_matches)) || []);
    const all = list.map((mt) => apiRow(mt, steam)).filter(Boolean);
    if (!all.length) { log(`🧠 Die API lieferte ${list.length} Matches, aber keine mit deiner Steam64-ID (${steam}). ID prüfen.`); return; }
    all.sort((x, y) => (Number.isFinite(y.ts) && Number.isFinite(x.ts) ? y.ts - x.ts : 0));
    const rows = all.slice(0, want);
    const defs = {};
    Object.keys(MET).forEach((id) => { if (rows.some((r) => Number.isFinite(r.m[id]))) defs[id] = { ...MET[id] }; });
    aiNormalize(rows, defs);
    const notes = [
      `Die API lieferte ${list.length} Matches, davon ${all.length} mit meiner Steam64-ID.`,
      'Score = meine gewonnenen : verlorenen Runden. Alle Werte sind meine eigenen Match-Werte laut Leetify-API.',
    ];
    const text = aiPrompt(rows, { defs, comps, want, sourceLabel: 'Leetify Public API (/v3/profile/matches, meine Werte pro Match)', notes, profileBlock: apiProfileBlock(prof) });
    showAIExport(text, rows.length, 'API');
    log(`🧠 KI-Export (API): ${rows.length} Matches, ${Object.keys(defs).length} Werte pro Match${rows.length < want ? ` – gewünscht ${want}, die API hatte nur ${rows.length}` : ''}.`);
  }

  function showAIExport(text, count, label) {
    const old = document.getElementById('ldu-ai-modal'); if (old) old.remove();
    const wrap = document.createElement('div');
    wrap.id = 'ldu-ai-modal';
    wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.7);display:flex;align-items:center;justify-content:center;font:13px system-ui,sans-serif';
    wrap.innerHTML = `<div style="background:#1b1b22;color:#eee;border-radius:10px;padding:14px;width:min(900px,94vw);max-height:90vh;display:flex;flex-direction:column;gap:8px">
      <b>🧠 KI-Analyse (${label}) – ${count} Matches · ${Math.round(text.length / 1000)}k Zeichen</b>
      <div style="opacity:.8">Text kopieren und in Claude, ChatGPT oder Gemini einfügen. Es wurde nichts an eine KI gesendet.</div>
      <textarea readonly style="flex:1;min-height:340px;background:#111;color:#ddd;border:1px solid #444;border-radius:6px;padding:8px;font:12px monospace"></textarea>
      <div style="display:flex;gap:8px;justify-content:flex-end"><button id="ldu-ai-copy" style="padding:6px 12px">📋 Kopieren</button><button id="ldu-ai-close" style="padding:6px 12px">Schließen</button></div></div>`;
    const ta = wrap.querySelector('textarea'); ta.value = text;
    document.body.appendChild(wrap);
    const copy = async () => {
      try { await navigator.clipboard.writeText(text); wrap.querySelector('#ldu-ai-copy').textContent = '✅ Kopiert'; }
      catch (_) { ta.focus(); ta.select(); try { document.execCommand('copy'); wrap.querySelector('#ldu-ai-copy').textContent = '✅ Kopiert'; } catch (__) { /* manuell */ } }
    };
    wrap.querySelector('#ldu-ai-copy').onclick = copy;
    wrap.querySelector('#ldu-ai-close').onclick = () => wrap.remove();
    wrap.addEventListener('click', (e) => { if (e.target === wrap) wrap.remove(); });
    copy();
  }

  // Einstellungsfelder (Settings → KI-Analyse) füllen und verdrahten
  function wireAi() {
    const a = aiCfg();
    const fields = { 'ldu-ai-n': 'n', 'ldu-ai-compare': 'compare', 'ldu-ai-steam': 'steam', 'ldu-ai-key': 'key', 'ldu-ai-profile': 'profile' };
    Object.entries(fields).forEach(([id, k]) => {
      const el = $(`#${id}`);
      if (!el) return;
      el.value = a[k];
      el.onchange = () => {
        let v = el.value;
        if (k === 'n') { v = Math.min(300, Math.max(10, Math.round(Number(v)) || AI_DEFAULTS.n)); el.value = v; }
        else if (k === 'steam') {
          const typed = String(v).trim();
          v = (typed.match(/\d{17}/) || [''])[0];
          el.value = v;
          if (typed && !v) log('🧠 Steam64-ID = 17 Ziffern (z. B. aus der Steam-Profil-URL …/profiles/7656…). Vanity-Namen gehen nicht.');
        }
        else v = String(v).trim();
        aiSave({ [k]: v });
      };
    });
    $('#ldu-ai').onclick = exportFromList;
    $('#ldu-ai-api').onclick = exportFromApi;
  }

  async function diagnose() {
    const items = findUploadElements();
    const first = items[0];
    const anchor = first ? first.el.closest('a[href]') : null;
    const captured = first && first.kind === 'native' ? await captureOpen(first.el) : null;
    const field = findRangeField();
    let pickerHTML = null;
    let pickerFound = false;
    if (field && !state.running) { // Kalender kurz öffnen, um seinen Aufbau mitzuschicken
      try {
        if (!findPicker()) clickEl(field, 'full');
        const pk = await waitFor(findPicker, 2500);
        if (pk) {
          pickerFound = true;
          const cals = findCalendars(pk.root);
          pickerHTML = { calendars: cals.map((c) => ymd(c.month)), apply: !!pk.apply, html: pk.root.outerHTML.slice(0, 5000) };
        } else {
          const anyCal = document.querySelector('[class*="picker"], [class*="calendar"]');
          pickerHTML = anyCal ? { html: anyCal.outerHTML.slice(0, 3000) } : null;
        }
      } catch (e) { pickerHTML = { error: e.message }; }
      closePicker();
    }
    const info = {
      version: VERSION,
      injectInto: (() => { try { return GM_info.injectInto || null; } catch (_) { return null; } })(),
      manager: (() => { try { return `${GM_info.scriptHandler} ${GM_info.version}`; } catch (_) { return null; } })(),
      path: location.pathname,
      rangeField: field ? { tag: field.tagName, text: fieldText(field), cls: field.className } : null,
      pickerFound,
      picker: pickerHTML,
      truncated: isTruncated(),
      upload: first ? {
        kind: first.kind, key: keyOf(first.el), leetifyId: matchIdFrom(first.el), source: sourceOf(first.el),
        closestAnchor: anchor?.href || null, capturedWindowOpen: captured,
        rowHTML: (rowOf(first.el)?.outerHTML || '').slice(0, 3000),
      } : null,
      lastLog: logLines.slice(0, 15),
      ua: navigator.userAgent,
    };
    const txt = JSON.stringify(info, null, 2);
    console.log('[LDU] Diagnose', info);
    try { await navigator.clipboard.writeText(txt); log('🩺 Diagnose in die Zwischenablage kopiert (steht auch in der Konsole, F12).'); } catch (_) { log('🩺 Diagnose steht in der Konsole (F12) – Kopieren ging nicht.'); }
    log(`   Datumsfeld: ${field ? 'gefunden' : 'NICHT gefunden'} · Kalender: ${pickerFound ? 'bedienbar' : 'nicht erkannt'} · Upload-Zeile: ${first ? short(captured || anchor?.href || 'ohne Link') : 'keine sichtbar'}`);
  }

  // ═════════════ Start ═════════════
  function init() {
    if (!ORIG_OPEN) { try { ORIG_OPEN = unsafeWindow.open; } catch (_) { /* ignore */ } }

    // Takt über den Worker (im Hintergrund nicht gedrosselt) + Watchdog, falls die CSP den Worker blockiert
    onWorkerTick = tick;
    if (timerWorker) { try { timerWorker.postMessage({ c: 'tick', ms: TICK_MS }); } catch (_) { /* ignore */ } }
    setInterval(() => { if (now() - lastTick > TICK_MS * 3) tick(); }, TICK_MS);

    // Auto-Rescan bei DOM-Änderungen (gedrosselt statt entprellt, damit er bei Dauer-Änderungen nicht verhungert)
    let scanPending = false;
    new MutationObserver((muts) => {
      if (scanPending || !onMatchesPage() || !panel) return;
      const relevant = muts.some((m) => {
        const t = m.target.nodeType === 1 ? m.target : m.target.parentElement;
        return t && outsidePanel(t);
      });
      if (!relevant) return;
      scanPending = true;
      setTimeout(() => {
        scanPending = false;
        if (state.switching) return; // Autopilot scannt selbst
        const r = scan();
        if (r.added && !state.running) log(`+${r.added} neue Zeile(n) in der Queue`);
      }, 800);
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true });

    const ensureUi = () => {
      if (onMatchesPage()) { buildPanel(); panel.style.display = ''; } else if (panel) panel.style.display = 'none';
    };
    setInterval(ensureUi, 1000);
    ensureUi();
    if (onMatchesPage()) {
      setTimeout(() => {
        const r = scan();
        log(`Bereit (v${VERSION}). In dieser Ansicht: ${r.found} "Upload Demo". ${cfg.autoRange ? '"Start" sucht automatisch auch in älteren Zeiträumen.' : ''}`);
        render();
      }, 1500);
    }

    // Letzte Log-Zeilen aus früheren Sitzungen anzeigen
    try {
      const prev = (GM_getValue(RUNLOG_KEY, []) || []).filter((e) => e.y === 'log').slice(-40).reverse();
      if (prev.length) {
        logLines.push('──────── frühere Einträge ────────');
        prev.forEach((e) => logLines.push(`[${new Date(e.t).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' })}] ${e.m}`));
        renderLog();
      }
    } catch (_) { /* ignore */ }

    document.addEventListener('visibilitychange', () => {
      if (state.running) ev('visibility', document.hidden ? 'Tab im Hintergrund' : 'Tab im Vordergrund');
    });
    window.addEventListener('pagehide', () => {
      flushLog();
      const lock = GM_getValue('lock', null);
      if (lock && lock.id === TAB_ID) GM_setValue('lock', null);
    });
    window.addEventListener('beforeunload', (e) => {
      if (state.running || state.active.size) { e.preventDefault(); e.returnValue = ''; }
    });
    GM_registerMenuCommand('Panel ein-/ausklappen', () => $('#ldu-mini')?.click());
    GM_registerMenuCommand('Bericht herunterladen', report);
    GM_registerMenuCommand('Tutorial anzeigen', () => { if (panel) { panel.classList.remove('min'); showTour(0); } });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
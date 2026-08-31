/* ════════════════════════════════════════════════════════════════════════
   reader-store.js — persistence for the Reader PWA

   Two stores, deliberately split:
     • localStorage  — settings + article metadata and text (small, sync,
                       easy to inspect/export).
     • IndexedDB     — synthesized audio Blobs, one per chunk. Blobs are far
                       too big for localStorage's ~5 MB string quota.

   Exposes the global `Store`. No build step: plain <script src>.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';
const Store = (function () {

  /* ── Keys ──────────────────────────────────────────────────────────────── */
  const ARTICLES_KEY = 'reader:articles';   // [{id,title,source,text,createdAt,audio}]
  const PROGRESS_KEY = 'reader:progress';   // { [articleId]: {idx, time} }
  const SETTINGS_KEY = 'reader:settings';   // { kokoroUrl, kokoroKey, voice, speed, format }

  const DEFAULT_SETTINGS = {
    kokoroUrl: '',            // e.g. https://elvinio--kokoro-tts-fastapi-app.modal.run
    kokoroKey: '',            // TTS_API_KEY — sent as the X-API-Key header
    voice:     'af_heart',
    speed:     0.9,           // Kokoro synthesis speed (see SPEEDS in reader-app.js)
    format:    'mp3',         // 'mp3' | 'opus' — mp3 plays everywhere, incl. iOS
  };

  /* ── Small helpers ─────────────────────────────────────────────────────── */
  function readJSON(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; }
    catch (e) { return fallback; }
  }
  function writeJSON(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); return true; }
    catch (e) {
      // Quota is the only realistic failure here, and it is worth surfacing:
      // silently dropping an article the user just pasted is the worst outcome.
      alert('Could not save — this browser’s storage is full. Delete an article and try again.');
      return false;
    }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  /* ── Settings ──────────────────────────────────────────────────────────── */
  function getSettings() { return Object.assign({}, DEFAULT_SETTINGS, readJSON(SETTINGS_KEY, {})); }
  function saveSettings(patch) {
    const next = Object.assign(getSettings(), patch);
    writeJSON(SETTINGS_KEY, next);
    return next;
  }
  function isConfigured() {
    const s = getSettings();
    return !!(s.kokoroUrl.trim() && s.kokoroKey.trim());
  }
  // Normalized base URL with any trailing slashes stripped, so callers can
  // safely append '/tts'.
  function ttsBase() { return getSettings().kokoroUrl.trim().replace(/\/+$/, ''); }

  /* ── Articles ──────────────────────────────────────────────────────────── */
  function allArticles() { return readJSON(ARTICLES_KEY, []); }
  function getArticle(id) { return allArticles().find(a => a.id === id) || null; }

  function saveArticles(list) { return writeJSON(ARTICLES_KEY, list); }

  // Derive a title from the first non-empty line when the user leaves it blank.
  function deriveTitle(text) {
    const first = (text || '').split(/\n+/).map(s => s.trim()).find(Boolean) || 'Untitled';
    return first.length > 90 ? first.slice(0, 87).trimEnd() + '…' : first;
  }

  function addArticle({ title, source, text }) {
    const body = (text || '').trim();
    if (!body) return null;
    const article = {
      id: uid(),
      title: (title || '').trim() || deriveTitle(body),
      source: (source || '').trim(),
      text: body,
      createdAt: Date.now(),
      audio: null,   // set by markAudio() once synthesis completes
    };
    const list = allArticles();
    list.unshift(article);
    return saveArticles(list) ? article : null;
  }

  function updateArticle(id, patch) {
    const list = allArticles();
    const i = list.findIndex(a => a.id === id);
    if (i < 0) return null;
    list[i] = Object.assign({}, list[i], patch);
    return saveArticles(list) ? list[i] : null;
  }

  async function deleteArticle(id) {
    await clearAudio(id);
    clearProgress(id);
    saveArticles(allArticles().filter(a => a.id !== id));
  }

  // Record what the stored audio actually is, so the UI can tell when the
  // cached audio no longer matches the current voice/speed settings.
  function markAudio(id, { count, voice, speed, format, bytes, durations }) {
    return updateArticle(id, {
      audio: { count, voice, speed, format, bytes, durations, generatedAt: Date.now() },
    });
  }

  /* ── Playback progress ─────────────────────────────────────────────────── */
  function getProgress(id) { return readJSON(PROGRESS_KEY, {})[id] || null; }
  function setProgress(id, idx, time) {
    const all = readJSON(PROGRESS_KEY, {});
    all[id] = { idx, time };
    writeJSON(PROGRESS_KEY, all);
  }
  function clearProgress(id) {
    const all = readJSON(PROGRESS_KEY, {});
    delete all[id];
    writeJSON(PROGRESS_KEY, all);
  }

  /* ── Audio Blobs (IndexedDB) ───────────────────────────────────────────── */
  const DB_NAME = 'reader-audio', DB_VERSION = 1, DB_STORE = 'audio';
  let _dbPromise = null;

  function db() {
    if (_dbPromise) return _dbPromise;
    _dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        if (!req.result.objectStoreNames.contains(DB_STORE)) req.result.createObjectStore(DB_STORE);
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return _dbPromise;
  }

  function tx(mode, fn) {
    return db().then(d => new Promise((resolve, reject) => {
      const t = d.transaction(DB_STORE, mode);
      const req = fn(t.objectStore(DB_STORE));
      t.onerror = () => reject(t.error);
      t.oncomplete = () => resolve(req && req.result);
      if (req) req.onerror = () => reject(req.error);
    }));
  }

  const audioKey = (id, idx) => id + ':' + idx;

  function putAudio(id, idx, blob) { return tx('readwrite', s => s.put(blob, audioKey(id, idx))); }
  function getAudio(id, idx)       { return tx('readonly',  s => s.get(audioKey(id, idx))); }

  // Delete every chunk belonging to one article. Keys are `${id}:${idx}` so a
  // bounded key range beats iterating the whole store.
  function clearAudio(id) {
    return tx('readwrite', s => s.delete(IDBKeyRange.bound(id + ':', id + ':￿')));
  }

  return {
    // settings
    getSettings, saveSettings, isConfigured, ttsBase, DEFAULT_SETTINGS,
    // articles
    allArticles, getArticle, addArticle, updateArticle, deleteArticle, markAudio, deriveTitle,
    // progress
    getProgress, setProgress, clearProgress,
    // audio
    putAudio, getAudio, clearAudio,
  };
})();

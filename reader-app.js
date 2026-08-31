/* ════════════════════════════════════════════════════════════════════════
   reader-app.js — UI for the Reader PWA

   Two views (library / article) behind a hash router, a settings modal, and a
   sticky audio dock that is either "generate", "generating", or "player".

   Depends on the globals from reader-store.js (`Store`) and reader-tts.js
   (`TTS`), loaded before this file. No build step, no framework.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';
(function () {

  /* ── Speed ─────────────────────────────────────────────────────────────── */
  // One number drives two things: it is sent to Kokoro as the synthesis speed
  // (the model actually speaks slower, so pitch is preserved), and — when the
  // stored audio was baked at a different speed — it is applied to the player
  // as a *relative* playbackRate so a change takes effect without a re-run.
  const SPEEDS = [0.85, 0.9, 1, 1.25];

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

  function fmtTime(sec) {
    if (!Number.isFinite(sec) || sec < 0) sec = 0;
    const s = Math.floor(sec % 60), m = Math.floor(sec / 60) % 60, h = Math.floor(sec / 3600);
    const mm = h ? String(m).padStart(2, '0') : String(m);
    return (h ? h + ':' : '') + mm + ':' + String(s).padStart(2, '0');
  }
  function fmtBytes(n) {
    if (!n) return '';
    return n < 1024 * 1024 ? Math.round(n / 1024) + ' KB' : (n / 1024 / 1024).toFixed(1) + ' MB';
  }
  function fmtDate(ts) {
    return new Date(ts).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  let toastTimer = 0;
  function toast(msg) {
    const el = $('toast');
    el.textContent = msg;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
  }

  /* ── Modal ─────────────────────────────────────────────────────────────── */
  function openModal(title, bodyHtml, onOpen) {
    $('modal-title').textContent = title;
    $('modal-body').innerHTML = bodyHtml;
    $('modal-backdrop').hidden = false;
    document.body.classList.add('modal-open');
    if (onOpen) onOpen();
  }
  function closeModal() {
    $('modal-backdrop').hidden = true;
    $('modal-body').innerHTML = '';
    document.body.classList.remove('modal-open');
  }

  /* ── App state ─────────────────────────────────────────────────────────── */
  const State = {
    view: 'library',
    articleId: null,
    chunks: [],          // TTS.buildChunks() of the open article
    durations: [],       // seconds per chunk, aligned with `chunks`
    offsets: [],         // cumulative start time of each chunk
    total: 0,            // total seconds
    idx: 0,              // chunk currently loaded in the <audio>
    audio: null,
    objUrl: null,
    speed: 1,            // desired speed (see SPEEDS)
    seeking: false,
    gen: null,           // AbortController while synthesizing
    genArticleId: null,  // which article `gen` belongs to — generation keeps
                          // running if the user browses elsewhere meanwhile
    genError: '',        // last synthesis failure, shown in the dock until the next run
    awaitingChunk: false, // playback ended at the last synthesized section and
                           // more of the article is still to come
    saveTimer: 0,
  };

  /* ── Router ────────────────────────────────────────────────────────────── */
  function go(hash) { location.hash = hash; }

  function route() {
    const m = /^#\/a\/([A-Za-z0-9]+)$/.exec(location.hash || '');
    if (m && Store.getArticle(m[1])) openArticle(m[1]);
    else showLibrary();
  }

  function showLibrary() {
    stopPlayback();
    State.view = 'library';
    State.articleId = null;
    $('view-article').hidden = true;
    $('view-library').hidden = false;
    renderLibrary();
  }

  /* ── Library ───────────────────────────────────────────────────────────── */
  function renderLibrary() {
    const list = Store.allArticles();
    $('library-empty').hidden = list.length > 0;
    $('library-list').innerHTML = list.map(a => {
      const words = TTS.wordCount(a.text);
      const audio = a.audio;
      const badge = !audio
        ? '<span class="badge">No audio</span>'
        : audio.partial
          ? `<span class="badge warn">Partial audio · ${audio.count} sections</span>`
          : `<span class="badge ok">${fmtTime(secondsOf(audio))} · ${audio.speed}×</span>`;
      return `<li class="card" data-id="${esc(a.id)}" tabindex="0" role="button">
        <div class="card-title">${esc(a.title)}</div>
        <div class="card-meta">
          ${a.source ? `<span>${esc(a.source)}</span><span class="dot">·</span>` : ''}
          <span>${words.toLocaleString()} words</span>
          <span class="dot">·</span><span>${esc(fmtDate(a.createdAt))}</span>
        </div>
        <div class="card-badges">${badge}</div>
      </li>`;
    }).join('');

    $('library-list').querySelectorAll('.card').forEach(el => {
      const open = () => go('#/a/' + el.dataset.id);
      el.onclick = open;
      el.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } };
    });
  }

  // Total seconds of a stored audio record — measured durations when we have
  // them, otherwise nothing (the caller falls back to an estimate).
  function secondsOf(audio) {
    if (!audio || !audio.durations) return 0;
    return audio.durations.reduce((a, b) => a + b, 0);
  }

  /* ── New / edit article ────────────────────────────────────────────────── */
  function openComposer(existing) {
    const a = existing || { title: '', source: '', text: '' };
    openModal(existing ? 'Edit article' : 'New article', `
      <div class="field">
        <label for="c-title">Title <span class="muted">(optional)</span></label>
        <input id="c-title" type="text" placeholder="Taken from the first line if left blank" value="${esc(a.title)}">
      </div>
      <div class="field">
        <label for="c-source">Source <span class="muted">(optional)</span></label>
        <input id="c-source" type="text" placeholder="e.g. Ars Technica" value="${esc(a.source)}">
      </div>
      <div class="field">
        <label for="c-text">Article text</label>
        <textarea id="c-text" rows="12" placeholder="Paste the article here…">${esc(a.text)}</textarea>
        <div class="hint" id="c-count"></div>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="c-cancel">Cancel</button>
        <button class="btn primary" id="c-save">${existing ? 'Save changes' : 'Save article'}</button>
      </div>
    `, () => {
      const ta = $('c-text');
      const count = () => {
        const w = TTS.wordCount(ta.value);
        const secs = TTS.estimateSeconds(ta.value, Store.getSettings().speed);
        $('c-count').textContent = w ? `${w.toLocaleString()} words · roughly ${fmtTime(secs)} of audio` : '';
      };
      ta.oninput = count; count();
      ta.focus();
      $('c-cancel').onclick = closeModal;
      $('c-save').onclick = () => {
        const text = ta.value.trim();
        if (!text) { toast('Paste some text first.'); ta.focus(); return; }
        if (existing) {
          const changed = text !== existing.text;
          Store.updateArticle(existing.id, {
            title: $('c-title').value.trim() || Store.deriveTitle(text),
            source: $('c-source').value.trim(),
            text,
          });
          if (changed && existing.audio) {
            // The audio no longer matches the words on screen. Dropping it is
            // the honest option — stale audio read against edited text is worse
            // than no audio.
            abortGenerationFor(existing.id);
            Store.clearAudio(existing.id);
            Store.clearProgress(existing.id);
            Store.updateArticle(existing.id, { audio: null });
            toast('Text changed — the old audio was discarded.');
          }
          closeModal();
          openArticle(existing.id);
        } else {
          const created = Store.addArticle({ title: $('c-title').value, source: $('c-source').value, text });
          closeModal();
          if (created) go('#/a/' + created.id);
        }
      };
    });
  }

  /* ── Settings ──────────────────────────────────────────────────────────── */
  function openSettings() {
    const s = Store.getSettings();
    openModal('Settings', `
      <div class="field">
        <label for="s-url">Kokoro TTS URL</label>
        <input id="s-url" type="url" inputmode="url" autocomplete="off" spellcheck="false"
               placeholder="https://elvinio--kokoro-tts-fastapi-app.modal.run" value="${esc(s.kokoroUrl)}">
        <div class="hint">Your Modal deployment. The app posts to <code>&lt;URL&gt;/tts</code>.</div>
      </div>
      <div class="field">
        <label for="s-key">API key</label>
        <input id="s-key" type="password" autocomplete="off" placeholder="TTS_API_KEY" value="${esc(s.kokoroKey)}">
        <div class="hint">Sent as the <code>X-API-Key</code> header. Stored only in this browser.</div>
      </div>
      <div class="field">
        <label for="s-voice">Voice</label>
        <select id="s-voice">${TTS.VOICES.map(v =>
          `<option value="${esc(v.id)}"${v.id === s.voice ? ' selected' : ''}>${esc(v.label)}</option>`).join('')}</select>
      </div>
      <div class="field">
        <label for="s-speed">Default speed</label>
        <select id="s-speed">${SPEEDS.map(v =>
          `<option value="${v}"${v === s.speed ? ' selected' : ''}>${v}×</option>`).join('')}</select>
        <div class="hint">Applied inside Kokoro at synthesis, so slower speech keeps its natural pitch.</div>
      </div>
      <div class="field">
        <label for="s-format">Audio format</label>
        <select id="s-format">
          <option value="mp3"${s.format === 'mp3' ? ' selected' : ''}>MP3 — plays everywhere</option>
          <option value="opus"${s.format === 'opus' ? ' selected' : ''}>Opus — smaller, not on iOS</option>
        </select>
      </div>
      <div class="modal-actions">
        <button class="btn ghost" id="s-test">Test voice</button>
        <button class="btn primary" id="s-save">Save</button>
      </div>
      <div class="hint" id="s-test-out"></div>
    `, () => {
      const collect = () => ({
        kokoroUrl: $('s-url').value.trim(),
        kokoroKey: $('s-key').value.trim(),
        voice: $('s-voice').value,
        speed: parseFloat($('s-speed').value),
        format: $('s-format').value,
      });
      $('s-save').onclick = () => {
        Store.saveSettings(collect());
        State.speed = Store.getSettings().speed;
        closeModal();
        toast('Settings saved.');
        if (State.view === 'article') renderDock();
      };
      $('s-test').onclick = async () => {
        Store.saveSettings(collect());
        const out = $('s-test-out');
        const btn = $('s-test');
        btn.disabled = true; out.textContent = 'Synthesizing a sample…';
        try {
          const cfg = collect();
          const blob = await TTS.synthesize(
            'This is how your articles will sound at ' + cfg.speed + ' times speed.',
            { voice: cfg.voice, speed: cfg.speed, format: cfg.format });
          const url = URL.createObjectURL(blob);
          const a = new Audio(url);
          a.onended = () => URL.revokeObjectURL(url);
          await a.play();
          out.textContent = 'Playing ' + TTS.voiceLabel(cfg.voice) + '.';
        } catch (e) {
          out.textContent = e.message || String(e);
        } finally {
          btn.disabled = false;
        }
      };
    });
  }

  /* ── Article view ──────────────────────────────────────────────────────── */
  async function openArticle(id) {
    const article = Store.getArticle(id);
    if (!article) return showLibrary();

    stopPlayback();
    State.view = 'article';
    State.articleId = id;
    State.chunks = TTS.buildChunks(article.text);
    State.speed = Store.getSettings().speed;
    State.idx = 0;
    State.durations = [];
    State.offsets = [];
    State.total = 0;
    State.genError = '';

    $('view-library').hidden = true;
    $('view-article').hidden = false;
    $('article-title-bar').textContent = article.title;
    renderBody(article);
    window.scrollTo(0, 0);

    // A run that matches the current text is playable; anything else is stale.
    if (article.audio && article.audio.count) {
      State.speed = article.audio.speed;
      await loadDurations(article);
    }
    renderDock();
  }

  function renderBody(article) {
    const paras = TTS.paragraphs(article.text);
    const words = TTS.wordCount(article.text);
    $('article-body').innerHTML = `
      <h2 class="article-title">${esc(article.title)}</h2>
      <div class="article-meta">
        ${article.source ? `<span>${esc(article.source)}</span><span class="dot">·</span>` : ''}
        <span>${words.toLocaleString()} words</span>
        <span class="dot">·</span><span>${esc(fmtDate(article.createdAt))}</span>
      </div>
      <div class="article-text" id="article-text">
        ${paras.map((p, i) => `<p data-p="${i}">${esc(p)}</p>`).join('')}
      </div>`;

    // Tapping a paragraph seeks to the section that speaks it.
    $('article-text').querySelectorAll('p').forEach(p => {
      p.onclick = () => {
        const a = Store.getArticle(State.articleId);
        if (!a || !a.audio || !a.audio.count) return;
        const pi = parseInt(p.dataset.p, 10);
        const ci = State.chunks.findIndex(c => pi >= c.from && pi <= c.to);
        if (ci >= 0 && ci < a.audio.count) seekTo(State.offsets[ci] || 0, true);
      };
    });
  }

  function highlight(idx) {
    const chunk = State.chunks[idx];
    document.querySelectorAll('#article-text p').forEach(p => {
      const i = parseInt(p.dataset.p, 10);
      p.classList.toggle('speaking', !!chunk && i >= chunk.from && i <= chunk.to);
    });
  }

  function scrollToChunk(idx) {
    const chunk = State.chunks[idx];
    if (!chunk) return;
    const el = document.querySelector(`#article-text p[data-p="${chunk.from}"]`);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }

  /* ── Dock ──────────────────────────────────────────────────────────────── */
  function renderDock() {
    const article = Store.getArticle(State.articleId);
    if (!article) return;
    // "generating" means *this* article is the one in flight — a background
    // run for a different article (started before the user navigated away
    // from it) must not make this dock look busy.
    const generating = !!(State.gen && State.genArticleId === State.articleId);
    const audio = article.audio;
    const ready = !!(audio && audio.count);

    $('dock-progress').hidden = !generating;
    $('dock-gen').hidden = generating || ready;
    // Unlike dock-progress, the player is not gated on "not generating": the
    // whole point is that the first section is playable while the rest are
    // still being made.
    $('dock-player').hidden = !ready;

    if (!generating && !ready) {
      const s = Store.getSettings();
      const est = TTS.estimateSeconds(article.text, State.speed);
      const n = State.chunks.length;
      $('btn-generate').textContent = Store.isConfigured() ? 'Generate speech' : 'Add your Kokoro URL & key';
      // The section count is the first thing users ask about, so the tooltip
      // answers it where it is shown.
      $('dock-gen-meta').title = Store.isConfigured()
        ? `Long text is synthesized in ${n} separate request${n === 1 ? '' : 's'}, split at paragraph breaks. `
          + 'The first section is playable while the rest are still being made, and a failure only costs one section.'
        : '';
      const meta = Store.isConfigured()
        ? `${n} section${n === 1 ? '' : 's'} · about ${fmtTime(est)} · ${esc(TTS.voiceLabel(s.voice))} at ${State.speed}×`
        : 'Settings → Kokoro TTS URL and API key.';
      $('dock-gen-meta').innerHTML = State.genError
        ? `<span class="gen-err">${esc(State.genError)}</span><br>${meta}`
        : meta;
    }

    if (ready) renderPlayer(article, generating);
  }

  function renderPlayer(article, generating) {
    $('speeds').innerHTML = SPEEDS.map(v =>
      `<button class="speed${v === State.speed ? ' active' : ''}" data-rate="${v}">${v}×</button>`).join('');
    $('speeds').querySelectorAll('.speed').forEach(b => {
      b.onclick = () => setSpeed(parseFloat(b.dataset.rate));
    });

    const audio = article.audio;
    const notes = [];
    if (State.genError) notes.push(`<span class="gen-err">${esc(State.genError)}</span>`);
    if (generating) {
      // The progress panel above already explains what is happening; this
      // just accounts for why playback paused instead of moving on.
      if (State.awaitingChunk) notes.push('Paused — waiting for the next section to finish…');
    } else {
      if (audio.partial) {
        notes.push(`Only ${audio.count} of ${State.chunks.length} sections were synthesized. ` +
          `<button class="link" id="note-resume">Finish the rest</button> · ` +
          `<button class="link" id="note-restart">Start over</button>`);
      }
      if (State.speed !== audio.speed) {
        notes.push(`Audio was synthesized at ${audio.speed}× and is being played at ${State.speed}×. <button class="link" id="note-regen">Regenerate at ${State.speed}×</button> for the most natural voice.`);
      }
    }
    $('dock-note').innerHTML = notes.join('<br>');
    if ($('note-resume')) $('note-resume').onclick = () => startGeneration({ from: audio.count });
    if ($('note-restart')) $('note-restart').onclick = () => startGeneration({ from: 0 });
    if ($('note-regen')) $('note-regen').onclick = () => startGeneration({ from: 0 });

    updateTransport();
  }

  /* ── Generation ────────────────────────────────────────────────────────── */

  // What each phase of a request means in plain words. `connect` splits on how
  // long it has been waiting: a few seconds is normal, a minute means the Modal
  // container is cold and the user deserves to be told rather than left
  // guessing whether anything is happening.
  function phaseText(phase, waited, bytes) {
    if (phase === 'connect') {
      return waited > 12
        ? 'Waiting for Kokoro to wake up — a cold server can take a minute or two'
        : 'Contacting Kokoro…';
    }
    if (phase === 'retry') return 'That section failed once — trying again';
    if (phase === 'store') return 'Saving audio…';
    return 'Receiving audio' + (bytes ? ' · ' + fmtBytes(bytes) : '…');
  }

  // Generation keeps running when the user navigates away, so anything that
  // deletes or invalidates an article's audio needs to stop a run targeting
  // it first — otherwise a chunk landing after the delete would resurrect it.
  function abortGenerationFor(articleId) {
    if (State.gen && State.genArticleId === articleId) State.gen.abort();
  }

  async function startGeneration({ from = 0 } = {}) {
    const article = Store.getArticle(State.articleId);
    if (!article) return;
    if (!Store.isConfigured()) return openSettings();
    if (State.gen) {
      // Only one generation runs at a time, but it keeps running if the user
      // wanders off to another article — say so instead of silently no-oping.
      // The other article can be mid-delete (aborted but not yet cleared) and
      // briefly gone from Store already, hence the generic fallback.
      let msg = 'Already generating this article.';
      if (State.genArticleId !== article.id) {
        const other = Store.getArticle(State.genArticleId);
        msg = other ? `Still generating "${other.title}" — try again once it finishes.`
          : 'Still finishing another generation — try again in a moment.';
      }
      toast(msg);
      return;
    }

    if (!from) {
      // Starting over discards whatever is already stored (TTS.generate wipes
      // the IndexedDB blobs), so drop the stale pointer to it immediately too
      // rather than leaving the player showing soon-to-be-deleted audio until
      // the first new chunk lands.
      stopPlayback();
      Store.updateArticle(article.id, { audio: null });
      State.idx = 0; State.durations = []; State.offsets = []; State.total = 0;
    }
    const s = Store.getSettings();
    const speed = State.speed;
    const chunks = State.chunks;
    const total = chunks.length;
    const ctrl = new AbortController();
    State.gen = ctrl;
    State.genArticleId = article.id;
    State.genError = '';
    State.awaitingChunk = false;
    renderDock();

    // Weight the overall bar by section length so a long section does not
    // advance it as much as a short one.
    const weights = chunks.map(c => c.text.length);
    const totalWeight = weights.reduce((a, b) => a + b, 0) || 1;
    let doneWeight = 0;
    for (let i = 0; i < from; i++) doneWeight += weights[i];

    $('gen-segs').innerHTML = chunks.map((c, i) =>
      `<div class="gen-seg" id="gen-seg-${i}" style="flex:${weights[i]}"><div class="gen-seg-fill"></div></div>`).join('');

    // Progress *inside* the running request is estimated from bytes received.
    // The first section has only the nominal bitrate to go on; once a section
    // has landed we know what this article actually encodes to per character,
    // which is a much better predictor for the rest.
    let seenBytes = 0, seenChars = 0;
    const expectFor = (i) => (seenChars
      ? weights[i] * (seenBytes / seenChars)
      : TTS.expectedBytes(chunks[i].text, speed, s.format));

    // Duration of every section made so far, seeded from what a resume
    // already has, so the player's timeline can grow live as new sections
    // land instead of only being computed once the whole run finishes.
    const liveDurations = (from && article.audio && article.audio.durations)
      ? article.audio.durations.slice(0, from) : [];

    // `idx` doubles as the index of the section in flight and the count of
    // sections already stored — they are the same number.
    const G = { idx: from, phase: 'connect', bytes: 0, chunkBytes: 0,
                t0: Date.now(), phaseAt: Date.now() };

    // Guards every DOM write below: this closure keeps running (and Store
    // keeps getting updated) even if the user navigates to a different
    // article or back to the library, but it must stop touching the shared
    // dock the moment it is no longer what is on screen.
    const onScreen = () => State.articleId === article.id;

    const paint = () => {
      if (!onScreen()) return;
      const i = Math.min(G.idx, total - 1);
      const expect = expectFor(i);
      const frac = (G.phase === 'stream' && expect > 0)
        ? Math.min(G.chunkBytes / expect, 0.99)
        : (G.phase === 'store' ? 1 : 0);
      const pct = Math.round(((doneWeight + weights[i] * frac) / totalWeight) * 100);

      $('gen-label').textContent = `Section ${i + 1} of ${total} · ${pct}%`;
      for (let k = 0; k < total; k++) {
        const seg = $('gen-seg-' + k);
        if (!seg) continue;
        seg.classList.toggle('active', k === G.idx);
        seg.classList.toggle('waiting', k === G.idx && (G.phase === 'connect' || G.phase === 'retry'));
        seg.firstElementChild.style.width =
          (k < G.idx ? 100 : k === G.idx ? Math.round(frac * 100) : 0) + '%';
      }
      $('gen-segs').setAttribute('aria-valuenow', String(pct));
      $('gen-sub').textContent =
        phaseText(G.phase, (Date.now() - G.phaseAt) / 1000, G.bytes) +
        ' · ' + fmtTime((Date.now() - G.t0) / 1000) + ' elapsed';
    };

    // Repaint on a timer as well as on events: the elapsed clock is the one
    // thing that keeps moving while a slow request is in flight, and it is what
    // tells the user the run is alive rather than wedged.
    const tick = setInterval(paint, 1000);
    // Stream reads can arrive far faster than the screen needs updating.
    let lastPaint = 0;
    const paintSoon = () => {
      const now = Date.now();
      if (now - lastPaint < 100) return;
      lastPaint = now;
      paint();
    };
    paint();

    try {
      await TTS.generate(article, {
        voice: s.voice, speed, format: s.format, signal: ctrl.signal, from,
        onPhase: (i, phase) => {
          G.idx = i; G.phase = phase; G.phaseAt = Date.now();
          if (phase === 'connect' || phase === 'retry') G.chunkBytes = 0;
          paint();
        },
        onBytes: (soFar, inChunk) => { G.bytes = soFar; G.chunkBytes = inChunk; paintSoon(); },
        onChunk: (i, n, blob, duration) => {
          seenBytes += blob.size; seenChars += weights[i];
          doneWeight += weights[i];
          G.idx = i + 1; G.chunkBytes = 0;
          liveDurations[i] = duration;
          if (onScreen()) {
            applyDurations(liveDurations.slice());
            continueIfAwaiting(i);
            renderDock();
          }
          paint();
        },
      });
      toast('Audio ready.');
    } catch (e) {
      const cancelled = e.name === 'AbortError';
      const msg = cancelled ? 'Generation cancelled.' : (e.message || 'Generation failed.');
      // A toast is gone in three seconds; a failure the user needs to act on
      // stays in the dock until the next run.
      if (!cancelled) State.genError = `Section ${G.idx + 1} of ${total} failed — ${msg}`;
      toast(msg);
    } finally {
      clearInterval(tick);
      State.gen = null;
      State.genArticleId = null;
      if (onScreen()) {
        const fresh = Store.getArticle(article.id);
        if (fresh) { State.speed = speed; await loadDurations(fresh); }
        renderDock();
      }
    }
  }

  // Turns per-chunk durations into the cumulative offsets the player needs
  // for one continuous timeline. Called both after a bulk measurement and
  // live, once per chunk, while generation is in progress.
  function applyDurations(durations) {
    State.durations = durations;
    State.offsets = [];
    let acc = 0;
    durations.forEach(d => { State.offsets.push(acc); acc += d; });
    State.total = acc;
  }

  async function loadDurations(article) {
    const audio = article.audio;
    if (!audio || !audio.count) { applyDurations([]); return; }
    let durations = audio.durations;
    if (!durations || durations.length !== audio.count || durations.some(d => !d)) {
      durations = await TTS.measureDurations(article.id, audio.count);
      Store.updateArticle(article.id, { audio: Object.assign({}, audio, { durations }) });
    }
    applyDurations(durations);
  }

  /* ── Player ────────────────────────────────────────────────────────────── */
  function audioEl() {
    if (State.audio) return State.audio;
    const a = new Audio();
    a.preload = 'auto';
    // Kept in the DOM (hidden) rather than detached: it keeps the element's
    // lifetime tied to the page and makes the player inspectable.
    a.hidden = true;
    document.body.appendChild(a);
    a.onended = () => {
      const article = Store.getArticle(State.articleId);
      const count = article && article.audio ? article.audio.count : 0;
      if (State.idx + 1 < count) { loadChunk(State.idx + 1, 0, true); return; }
      if (State.idx + 1 < State.chunks.length) {
        // Caught up to the last section made so far, but this is not the end
        // of the article — hold position rather than treating it as one.
        // continueIfAwaiting() resumes automatically once the next section
        // lands, if it is still being made.
        State.awaitingChunk = true;
        updateTransport();
        renderDock();
        return;
      }
      Store.clearProgress(State.articleId);
      updateTransport();
    };
    a.ontimeupdate = () => { if (!State.seeking) { updateTransport(); saveProgressThrottled(); } };
    a.onplay = () => { updateTransport(); setMediaState(); };
    a.onpause = () => updateTransport();
    a.onerror = () => toast('Could not play this section.');
    State.audio = a;
    return a;
  }

  // playbackRate is *relative* to the speed baked into the audio, so selecting
  // 0.85× on audio synthesized at 0.9× plays at 0.944×, not 0.85 × 0.9.
  function applyRate() {
    const article = Store.getArticle(State.articleId);
    const baked = (article && article.audio && article.audio.speed) || 1;
    audioEl().playbackRate = State.speed / baked;
  }

  // If playback was paused at the synthesized frontier waiting for `landedIdx`
  // to land, and it just did, continue seamlessly instead of leaving the user
  // to notice and press play again.
  function continueIfAwaiting(landedIdx) {
    if (State.awaitingChunk && landedIdx === State.idx + 1) {
      State.awaitingChunk = false;
      loadChunk(landedIdx, 0, true);
    }
  }

  async function loadChunk(idx, time, autoplay) {
    State.awaitingChunk = false;
    const blob = await Store.getAudio(State.articleId, idx);
    if (!blob) { toast('Section ' + (idx + 1) + ' has no audio yet.'); return; }
    const a = audioEl();
    if (State.objUrl) URL.revokeObjectURL(State.objUrl);
    State.objUrl = URL.createObjectURL(blob);
    State.idx = idx;
    a.src = State.objUrl;
    applyRate();
    const start = () => {
      if (time) { try { a.currentTime = time; } catch (e) { /* metadata not in yet */ } }
      applyRate();
      if (autoplay) a.play().catch(() => {});
      updateTransport();
    };
    if (a.readyState >= 1) start();
    else a.onloadedmetadata = start;
    highlight(idx);
    if (autoplay) scrollToChunk(idx);
  }

  function togglePlay() {
    const a = audioEl();
    if (!a.src) {
      const p = Store.getProgress(State.articleId);
      loadChunk(p ? p.idx : 0, p ? p.time : 0, true);
      return;
    }
    if (a.paused) a.play().catch(() => {}); else a.pause();
  }

  // Global time across all chunks → (chunk, offset within chunk).
  function locate(globalTime) {
    const count = State.durations.length;
    let idx = 0;
    while (idx < count - 1 && globalTime >= State.offsets[idx] + State.durations[idx]) idx++;
    return { idx, time: Math.max(0, globalTime - State.offsets[idx]) };
  }

  function currentGlobalTime() {
    const a = State.audio;
    const base = State.offsets[State.idx] || 0;
    return base + (a && Number.isFinite(a.currentTime) ? a.currentTime : 0);
  }

  function seekTo(globalTime, autoplay) {
    const t = Math.max(0, Math.min(globalTime, State.total || 0));
    const { idx, time } = locate(t);
    const wasAwaiting = State.awaitingChunk;
    State.awaitingChunk = false;
    const a = audioEl();
    const playing = autoplay !== undefined ? autoplay : !a.paused;
    if (idx === State.idx && a.src) {
      try { a.currentTime = time; } catch (e) { /* ignore */ }
      if (playing) a.play().catch(() => {});
      updateTransport();
      highlight(idx);
      if (wasAwaiting) renderDock();
    } else {
      loadChunk(idx, time, playing);
    }
  }

  function setSpeed(rate) {
    State.speed = rate;
    Store.saveSettings({ speed: rate });
    applyRate();
    const article = Store.getArticle(State.articleId);
    if (article) renderPlayer(article, !!(State.gen && State.genArticleId === State.articleId));
  }

  function updateTransport() {
    const a = State.audio;
    const playing = !!(a && a.src && !a.paused);
    $('btn-play').textContent = playing ? '❚❚' : '▶';
    $('btn-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
    const cur = currentGlobalTime();
    $('time-cur').textContent = fmtTime(cur);
    $('time-dur').textContent = fmtTime(State.total);
    if (!State.seeking) {
      $('seek').value = State.total ? Math.round((cur / State.total) * 1000) : 0;
    }
  }

  function saveProgressThrottled() {
    if (State.saveTimer) return;
    State.saveTimer = setTimeout(() => {
      State.saveTimer = 0;
      const a = State.audio;
      if (State.articleId && a) Store.setProgress(State.articleId, State.idx, a.currentTime || 0);
    }, 4000);
  }

  function stopPlayback() {
    if (State.audio) { State.audio.pause(); State.audio.removeAttribute('src'); State.audio.load(); }
    if (State.objUrl) { URL.revokeObjectURL(State.objUrl); State.objUrl = null; }
    clearTimeout(State.saveTimer); State.saveTimer = 0;
    State.awaitingChunk = false;
  }

  /* ── Lock-screen / headset controls ────────────────────────────────────── */
  function setMediaState() {
    if (!('mediaSession' in navigator)) return;
    const article = Store.getArticle(State.articleId);
    if (!article) return;
    navigator.mediaSession.metadata = new MediaMetadata({
      title: article.title,
      artist: article.source || 'Reader',
      album: 'Reader',
    });
    const set = (action, fn) => { try { navigator.mediaSession.setActionHandler(action, fn); } catch (e) { /* unsupported */ } };
    set('play', () => togglePlay());
    set('pause', () => togglePlay());
    set('seekbackward', () => seekTo(currentGlobalTime() - 15));
    set('seekforward', () => seekTo(currentGlobalTime() + 15));
    set('previoustrack', () => seekTo((State.offsets[State.idx] || 0) - 0.01));
    set('nexttrack', () => seekTo((State.offsets[State.idx] || 0) + (State.durations[State.idx] || 0) + 0.01));
  }

  /* ── Article menu ──────────────────────────────────────────────────────── */
  function openArticleMenu() {
    const article = Store.getArticle(State.articleId);
    if (!article) return;
    const audio = article.audio;
    openModal(article.title, `
      <div class="menu">
        <button class="menu-item" id="m-edit">Edit text</button>
        ${audio ? `<button class="menu-item" id="m-regen">Regenerate audio at ${State.speed}×</button>` : ''}
        ${audio ? `<button class="menu-item" id="m-drop">Delete audio${audio.bytes ? ' (' + fmtBytes(audio.bytes) + ')' : ''}</button>` : ''}
        <button class="menu-item" id="m-settings">Settings</button>
        <button class="menu-item danger" id="m-del">Delete article</button>
      </div>
    `, () => {
      $('m-edit').onclick = () => { closeModal(); openComposer(article); };
      $('m-settings').onclick = () => { closeModal(); openSettings(); };
      if ($('m-regen')) $('m-regen').onclick = () => { closeModal(); startGeneration({ from: 0 }); };
      if ($('m-drop')) $('m-drop').onclick = async () => {
        closeModal();
        abortGenerationFor(article.id);
        stopPlayback();
        await Store.clearAudio(article.id);
        Store.clearProgress(article.id);
        Store.updateArticle(article.id, { audio: null });
        openArticle(article.id);
      };
      $('m-del').onclick = async () => {
        if (!confirm('Delete “' + article.title + '” and its audio?')) return;
        closeModal();
        abortGenerationFor(article.id);
        await Store.deleteArticle(article.id);
        go('#');
        showLibrary();
      };
    });
  }

  /* ── Wiring ────────────────────────────────────────────────────────────── */
  function init() {
    State.speed = Store.getSettings().speed;

    $('btn-new').onclick = () => openComposer(null);
    $('btn-settings').onclick = openSettings;
    $('btn-back').onclick = () => go('#');
    $('btn-article-menu').onclick = openArticleMenu;
    $('modal-close').onclick = closeModal;
    $('modal-backdrop').onclick = (e) => { if (e.target === $('modal-backdrop')) closeModal(); };
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal-backdrop').hidden) closeModal(); });

    $('btn-generate').onclick = () => startGeneration({ from: 0 });
    $('btn-cancel-gen').onclick = () => { if (State.gen) State.gen.abort(); };

    $('btn-play').onclick = togglePlay;
    $('btn-back15').onclick = () => seekTo(currentGlobalTime() - 15);
    $('btn-fwd15').onclick = () => seekTo(currentGlobalTime() + 15);
    $('btn-prev').onclick = () => {
      // Restart the section unless we are near its start, then step back.
      const within = currentGlobalTime() - (State.offsets[State.idx] || 0);
      seekTo(within > 3 ? State.offsets[State.idx] : (State.offsets[State.idx - 1] !== undefined ? State.offsets[State.idx - 1] : 0));
    };
    $('btn-next').onclick = () => {
      const next = State.offsets[State.idx + 1];
      if (next !== undefined) seekTo(next);
    };

    const seek = $('seek');
    const beginSeek = () => { State.seeking = true; };
    const endSeek = () => {
      State.seeking = false;
      seekTo((parseInt(seek.value, 10) / 1000) * (State.total || 0));
    };
    seek.addEventListener('pointerdown', beginSeek);
    seek.addEventListener('input', () => {
      if (State.seeking) $('time-cur').textContent = fmtTime((parseInt(seek.value, 10) / 1000) * (State.total || 0));
    });
    seek.addEventListener('change', endSeek);

    // The dock is fixed, so the reading column needs to know how tall it is
    // or the last paragraph hides behind it.
    if (window.ResizeObserver) {
      new ResizeObserver(entries => {
        const h = entries[0].target.offsetHeight || 0;
        document.documentElement.style.setProperty('--dock-h', h + 'px');
      }).observe($('dock'));
    }

    window.addEventListener('hashchange', route);
    window.addEventListener('pagehide', () => {
      const a = State.audio;
      if (State.articleId && a && a.src) Store.setProgress(State.articleId, State.idx, a.currentTime || 0);
    });

    route();

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();

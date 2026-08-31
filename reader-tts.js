/* ════════════════════════════════════════════════════════════════════════
   reader-tts.js — Kokoro TTS client

   Talks to a self-hosted Kokoro instance (the Modal FastAPI app in
   `tts/tts.py`). The API is small:

     POST <base>/tts
       X-API-Key: <TTS_API_KEY>
       Content-Type: application/json
       { "text": "...", "voice": "af_heart", "format": "mp3", "speed": 0.9 }
     → streaming audio/mpeg (format "mp3") or audio/ogg (format "opus")

   The endpoint picks its phonemizer from the voice-id prefix — bf_/bm_ are
   British English, zf_/zm_ Chinese, everything else American English — so the
   voice id is the only language control.

   `speed` is applied inside Kokoro, i.e. the model genuinely speaks slower
   rather than the audio being resampled, so 0.85×/0.9× keeps its pitch and
   stays natural. That is why speed belongs at synthesis time here and not
   only on <audio>.playbackRate.

   Exposes the global `TTS`.
   ════════════════════════════════════════════════════════════════════════ */
'use strict';
const TTS = (function () {

  // Kokoro copes with far longer inputs, but small chunks are what make the
  // reader feel responsive: section 1 is playable while the rest still bake,
  // and a failure costs one section rather than the whole article.
  const MAX_CHUNK = 1400;
  const MIN_CHUNK = 400;

  // Watchdogs. Without them a stalled request hangs forever: `fetch` only
  // carries the caller's Cancel signal, so a dead connection is indist-
  // inguishable from slow synthesis — the dock just sits on one section with
  // no error and no retry. Both budgets are deliberately generous, because a
  // cold Modal container has to boot torch + kokoro before it answers at all.
  const WAIT_MS  = 240000;   // request sent → response headers
  const STALL_MS = 90000;    // gap between two audio chunks mid-stream

  // Encoder bitrates, mirroring the ffmpeg settings in `tts/tts.py`. They turn
  // "bytes received so far" into a position inside the current section, which
  // is what makes the progress bar move continuously rather than once per
  // request.
  const BYTES_PER_SEC = { mp3: 128000 / 8, opus: 48000 / 8 };

  /* ── Voice catalog ─────────────────────────────────────────────────────── */
  // Kokoro ships a fixed set of voices — there is no catalog endpoint.
  const VOICES = [
    { id: 'af_heart',    label: 'Heart — US female' },
    { id: 'af_bella',    label: 'Bella — US female' },
    { id: 'af_nicole',   label: 'Nicole — US female' },
    { id: 'af_aoede',    label: 'Aoede — US female' },
    { id: 'af_kore',     label: 'Kore — US female' },
    { id: 'af_sarah',    label: 'Sarah — US female' },
    { id: 'af_nova',     label: 'Nova — US female' },
    { id: 'af_sky',      label: 'Sky — US female' },
    { id: 'af_alloy',    label: 'Alloy — US female' },
    { id: 'af_jessica',  label: 'Jessica — US female' },
    { id: 'af_river',    label: 'River — US female' },
    { id: 'am_michael',  label: 'Michael — US male' },
    { id: 'am_fenrir',   label: 'Fenrir — US male' },
    { id: 'am_puck',     label: 'Puck — US male' },
    { id: 'am_echo',     label: 'Echo — US male' },
    { id: 'am_eric',     label: 'Eric — US male' },
    { id: 'am_liam',     label: 'Liam — US male' },
    { id: 'am_onyx',     label: 'Onyx — US male' },
    { id: 'am_adam',     label: 'Adam — US male' },
    { id: 'bf_emma',     label: 'Emma — UK female' },
    { id: 'bf_isabella', label: 'Isabella — UK female' },
    { id: 'bf_alice',    label: 'Alice — UK female' },
    { id: 'bf_lily',     label: 'Lily — UK female' },
    { id: 'bm_george',   label: 'George — UK male' },
    { id: 'bm_fable',    label: 'Fable — UK male' },
    { id: 'bm_lewis',    label: 'Lewis — UK male' },
    { id: 'bm_daniel',   label: 'Daniel — UK male' },
  ];
  function voiceLabel(id) { const v = VOICES.find(v => v.id === id); return v ? v.label : id; }

  /* ── Text splitting ────────────────────────────────────────────────────── */

  // Pasted text uses blank lines between paragraphs when it comes from a real
  // article, and single newlines when it comes from a plain-text copy. Prefer
  // blank lines; fall back to single newlines when that yields nothing useful.
  function paragraphs(text) {
    const t = (text || '').replace(/\r\n?/g, '\n').trim();
    if (!t) return [];
    let parts = t.split(/\n[ \t]*\n+/).map(s => s.trim()).filter(Boolean);
    if (parts.length === 1 && t.includes('\n')) {
      parts = t.split(/\n+/).map(s => s.trim()).filter(Boolean);
    }
    return parts;
  }

  // Abbreviations whose trailing period is not a sentence end. Kept short on
  // purpose — a missed split costs nothing, a wrong one splits mid-sentence
  // and Kokoro's prosody at the seam is audibly wrong.
  const ABBREV = /(^|\s)(mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|e\.g|i\.e|approx|no|fig|vol|dept|est|inc|ltd|co|u\.s|u\.k)\.$/i;

  // Sentence scanner. Written without lookbehind so it runs on older Safari.
  function sentences(para) {
    const out = [];
    let start = 0;
    for (let i = 0; i < para.length; i++) {
      if (!'.!?…'.includes(para[i])) continue;
      let j = i + 1;
      while (j < para.length && '"’”\')]'.includes(para[j])) j++;   // trailing quotes/brackets
      if (j < para.length && !/\s/.test(para[j])) continue;                   // e.g. "3.5", "u.s.a"
      const candidate = para.slice(start, j);
      if (ABBREV.test(candidate)) continue;
      const s = candidate.trim();
      if (s) out.push(s);
      while (j < para.length && /\s/.test(para[j])) j++;
      start = j; i = j - 1;
    }
    const tail = para.slice(start).trim();
    if (tail) out.push(tail);
    return out.length ? out : [para];
  }

  // Last-resort split for a single sentence longer than MAX_CHUNK: break at the
  // latest clause boundary (then space) that fits, so the seam lands somewhere
  // a reader would pause anyway.
  function hardSplit(s, max) {
    const out = [];
    let rest = s;
    while (rest.length > max) {
      const window = rest.slice(0, max);
      let cut = Math.max(window.lastIndexOf('; '), window.lastIndexOf(', '), window.lastIndexOf(' — '));
      if (cut < max * 0.4) cut = window.lastIndexOf(' ');
      if (cut < max * 0.4) cut = max;
      out.push(rest.slice(0, cut + 1).trim());
      rest = rest.slice(cut + 1).trim();
    }
    if (rest) out.push(rest);
    return out;
  }

  /* Split an article into synthesis chunks.
     Each chunk records the paragraph range it covers (`from`..`to`) so the
     reading pane can highlight what is currently being spoken and a tap on a
     paragraph can seek to it. Chunks never split mid-sentence. */
  function buildChunks(text) {
    const paras = paragraphs(text);
    const chunks = [];
    let buf = [], bufLen = 0, bufFrom = 0;

    const flush = (to) => {
      if (!buf.length) return;
      chunks.push({ text: buf.join('\n\n'), from: bufFrom, to });
      buf = []; bufLen = 0;
    };

    paras.forEach((para, i) => {
      if (para.length > MAX_CHUNK) {
        // Regroup this paragraph's sentences into chunk-sized pieces. A short
        // pending buffer rides along in the first piece rather than costing a
        // whole request of its own.
        let piece = [], pieceLen = 0, pieceFrom = i;
        if (buf.length && bufLen < MIN_CHUNK) {
          // Trailing newline keeps the paragraph break audible once the
          // sentences that follow are joined with plain spaces.
          piece = [buf.join('\n\n') + '\n']; pieceLen = bufLen; pieceFrom = bufFrom;
          buf = []; bufLen = 0;
        } else {
          flush(i - 1);
        }
        const push = () => {
          if (!piece.length) return;
          chunks.push({ text: piece.join(' '), from: pieceFrom, to: i });
          piece = []; pieceLen = 0; pieceFrom = i;
        };
        sentences(para).forEach(sentence => {
          (sentence.length > MAX_CHUNK ? hardSplit(sentence, MAX_CHUNK) : [sentence]).forEach(s => {
            if (pieceLen && pieceLen + s.length + 1 > MAX_CHUNK) push();
            piece.push(s); pieceLen += s.length + 1;
          });
        });
        push();
        bufFrom = i + 1;
        return;
      }
      if (bufLen && bufLen + para.length + 2 > MAX_CHUNK) { flush(i - 1); bufFrom = i; }
      if (!buf.length) bufFrom = i;
      buf.push(para); bufLen += para.length + 2;
    });
    flush(paras.length - 1);

    // A trailing scrap (a one-line sign-off, say) is not worth its own request.
    if (chunks.length > 1) {
      const last = chunks[chunks.length - 1], prev = chunks[chunks.length - 2];
      if (last.text.length < MIN_CHUNK && last.text.length + prev.text.length <= MAX_CHUNK * 1.3) {
        prev.text += '\n\n' + last.text;
        prev.to = last.to;
        chunks.pop();
      }
    }
    return chunks;
  }

  function wordCount(text) { return (text.trim().match(/\S+/g) || []).length; }
  // ~150 wpm at 1×; the synthesis speed scales it directly.
  function estimateSeconds(text, speed) { return wordCount(text) / 150 * 60 / (speed || 1); }
  // Roughly how many bytes this text should encode to — a rough number is fine,
  // callers use it only to place a progress bar inside one request.
  function expectedBytes(text, speed, format) {
    return estimateSeconds(text, speed) * (BYTES_PER_SEC[format] || BYTES_PER_SEC.mp3);
  }

  /* ── One synthesis request ─────────────────────────────────────────────── */
  /* `onPhase(phase)` reports where the request is: 'connect' while waiting for
     response headers (a cold container can sit here for a minute), then
     'stream' once audio is actually arriving. `onProgress(bytes)` fires per
     stream read. Both exist so the UI can say what is happening instead of
     showing one frozen line for the whole request. */
  async function synthesize(text, { voice, speed, format, signal, onProgress, onPhase } = {}) {
    const s = Store.getSettings();
    const base = Store.ttsBase();
    const key = s.kokoroKey.trim();
    if (!base) throw new Error('No Kokoro URL. Add it in Settings.');
    if (!key) throw new Error('No Kokoro API key. Add it in Settings.');

    // A private controller lets a watchdog abort the fetch. The caller's signal
    // is forwarded into it so Cancel keeps working, and `stalled` remembers
    // which watchdog fired so the abort can be reported as a real error rather
    // than being mistaken for a user cancellation.
    const ctrl = new AbortController();
    const relay = () => ctrl.abort();
    if (signal) {
      if (signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      signal.addEventListener('abort', relay);
    }
    let timer = 0, stalled = '';
    const watch = (ms, why) => {
      clearTimeout(timer);
      timer = setTimeout(() => { stalled = why; ctrl.abort(); }, ms);
    };

    try {
      if (onPhase) onPhase('connect');
      watch(WAIT_MS, 'Kokoro did not respond within ' + Math.round(WAIT_MS / 1000) +
                     's — the server may be asleep or unreachable.');

      const res = await fetch(base + '/tts', {
        method: 'POST',
        headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          text,
          voice: voice || s.voice,
          format: format || s.format,
          speed: speed || s.speed,
        }),
        signal: ctrl.signal,
      });

      if (!res.ok) {
        let detail = '';
        try {
          const j = await res.json();
          detail = typeof j.detail === 'string' ? j.detail : (j.detail && j.detail.message) || '';
        } catch (e) {
          detail = (await res.text().catch(() => '')).slice(0, 200);
        }
        if (res.status === 401) detail = detail || 'Invalid or missing API key';
        throw new Error('Kokoro ' + res.status + (detail ? ': ' + detail : ''));
      }

      // Read the stream so the connection stays alive through a long synthesis
      // and the caller can show bytes arriving instead of a frozen UI. The
      // watchdog is re-armed per read: the budget is the gap between two audio
      // chunks, not the length of the whole synthesis.
      const mime = res.headers.get('content-type') || (format === 'opus' ? 'audio/ogg' : 'audio/mpeg');
      const reader = res.body.getReader();
      const parts = [];
      let received = 0;
      if (onPhase) onPhase('stream');
      for (;;) {
        watch(STALL_MS, 'Kokoro stopped sending audio for ' + Math.round(STALL_MS / 1000) + 's.');
        const { done, value } = await reader.read();
        if (done) break;
        parts.push(value);
        received += value.length;
        if (onProgress) onProgress(received);
      }
      clearTimeout(timer);
      const blob = new Blob(parts, { type: mime });
      if (!blob.size) throw new Error('Kokoro returned no audio.');
      return blob;
    } catch (e) {
      // Our own abort surfaces as a described failure; a user Cancel stays an
      // AbortError so callers can tell the two apart.
      if (e.name === 'AbortError' && stalled && !(signal && signal.aborted)) throw new Error(stalled);
      throw e;
    } finally {
      clearTimeout(timer);
      if (signal) signal.removeEventListener('abort', relay);
    }
  }

  /* ── Whole-article synthesis ───────────────────────────────────────────── */
  /* Synthesizes every chunk in order, storing each Blob as it lands so a
     cancelled or failed run still leaves the finished sections playable.
     `onChunk(index, total, blob)` fires after each chunk is stored;
     `onBytes(totalSoFar, thisChunkSoFar)` on every stream read; and
     `onPhase(index, phase, attempt)` on each change of what the run is doing
     ('connect' | 'stream' | 'retry' | 'store'). */
  async function generate(article, { voice, speed, format, signal, onChunk, onBytes, onPhase, from = 0 } = {}) {
    const chunks = buildChunks(article.text);
    if (!chunks.length) throw new Error('This article has no text to speak.');

    // `from` > 0 resumes a run that was cancelled part-way; only a fresh run
    // discards what is already stored.
    if (!from) await Store.clearAudio(article.id);
    let bytes = 0;

    for (let i = from; i < chunks.length; i++) {
      if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
      const opts = {
        voice, speed, format, signal,
        onProgress: n => onBytes && onBytes(bytes + n, n),
        onPhase: p => onPhase && onPhase(i, p),
      };
      let blob;
      try {
        blob = await synthesize(chunks[i].text, opts);
      } catch (e) {
        if (e.name === 'AbortError') throw e;
        // One retry: Modal cold starts and transient 5xx are common enough that
        // failing the whole article on a first blip would be needlessly brittle.
        if (signal && signal.aborted) throw new DOMException('Cancelled', 'AbortError');
        if (onPhase) onPhase(i, 'retry');
        blob = await synthesize(chunks[i].text, opts);
      }
      bytes += blob.size;
      if (onPhase) onPhase(i, 'store');
      await Store.putAudio(article.id, i, blob);
      if (onChunk) onChunk(i, chunks.length, blob);
    }
    return { count: chunks.length, bytes, chunks };
  }

  /* ── Duration measurement ──────────────────────────────────────────────── */
  // Reads metadata only (no download — the Blob is already local), so the
  // player can present one continuous timeline across all chunks.
  function blobDuration(blob) {
    return new Promise(resolve => {
      const url = URL.createObjectURL(blob);
      const a = new Audio();
      const done = (d) => { URL.revokeObjectURL(url); resolve(Number.isFinite(d) && d > 0 ? d : 0); };
      a.preload = 'metadata';
      a.onloadedmetadata = () => done(a.duration);
      a.onerror = () => done(0);
      a.src = url;
    });
  }

  async function measureDurations(articleId, count) {
    const out = [];
    for (let i = 0; i < count; i++) {
      const blob = await Store.getAudio(articleId, i);
      out.push(blob ? await blobDuration(blob) : 0);
    }
    return out;
  }

  return { VOICES, voiceLabel, buildChunks, paragraphs, sentences, wordCount, estimateSeconds,
           expectedBytes, synthesize, generate, measureDurations, MAX_CHUNK };
})();

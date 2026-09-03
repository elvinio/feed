# Reader

A small offline-first PWA that turns pasted article text into speech using a
**self-hosted [Kokoro](https://github.com/hexgrad/kokoro) TTS instance on Modal**.

Paste an article → tap **Generate speech** → listen, with the reading pane
following along. Everything stays on the device: the text lives in
`localStorage`, the audio in IndexedDB, and the only network call the app ever
makes is `POST <your-url>/tts`.

> `PLAN.md` describes a separate, server-side design for the same problem
> (browser capture → box → RSS → AntennaPod). This app is the browser-only
> counterpart and shares no code with it.

## Setup

1. Deploy the Kokoro server. The FastAPI-on-Modal app used here is
   `tts/tts.py` in the [`health`](https://github.com/elvinio/health) repo:

   ```bash
   modal secret create tts-api-key TTS_API_KEY=$(openssl rand -hex 32)
   modal deploy tts/tts.py
   ```

2. Open the app, tap **⚙ Settings**, and fill in:
   - **Kokoro TTS URL** — the Modal deployment URL (the app appends `/tts`)
   - **API key** — the same `TTS_API_KEY`, sent as the `X-API-Key` header
   - **Voice**, **default speed**, **audio format**

   **Test voice** synthesizes a one-line sample so you can confirm the endpoint
   and audition a voice before spending a whole article on it.

3. Tap **+**, paste the article text, save. Then **Generate speech**.

The key is stored in this browser only — it is never sent anywhere except your
own endpoint. Anyone with access to the device can read it, so treat installing
this like installing any other app that holds a credential.

## Speed

Speed is applied **inside Kokoro at synthesis time** (`speed` in the request
body), not by resampling afterwards, so 0.85× and 0.9× sound like someone
speaking more slowly rather than like slowed-down audio — the pitch is
unchanged. `0.85×`, `0.9×`, `1×` and `1.25×` are offered.

Changing the speed **after** audio exists takes effect immediately: the player
sets `playbackRate` *relative* to the speed baked into the file (selecting
0.85× on audio made at 0.9× plays at 0.944×, not 0.765×). The dock says so and
offers a one-tap regenerate for the fully natural version.

## How it works

| File | Role |
|---|---|
| `index.html` | Shell — markup only, no inline CSS or JS |
| `reader.css` | Styles, light + dark via `prefers-color-scheme` |
| `reader-store.js` | `Store` — settings & articles in `localStorage`, audio Blobs in IndexedDB |
| `reader-tts.js` | `TTS` — chunking, the Kokoro client, duration measurement |
| `reader-app.js` | UI — hash router, library, reading pane, audio dock, player |
| `sw.js` | Service worker (app shell cache) |
| `manifest.json`, `icons/` | PWA install metadata |

No build step, no bundler, no framework — plain `<script src>` files sharing a
global scope, in the same style as the `health` repo's PWAs.

**Chunking.** An article is split into ~1400-character chunks that never break
mid-sentence, and each chunk is one `/tts` request. Up to `CONCURRENCY` (3)
sections synthesize at once — that's what the Kokoro server can take — via a
small worker pool in `TTS.generate`; sections can finish out of order, but
`article.audio.count` only ever advances over a contiguous prefix (section i
publishes only once every section before it already has), so resuming, the
player, and the progress UI all still see "sections 0..count-1 are done,"
exactly as if they ran one at a time. This is what makes the app feel
responsive: section 1 is playable — the player appears and starts — while the
rest are still baking, and a failed chunk costs one retry rather than the
whole article. `article.audio` (what says how many sections exist) is updated
after *every* published chunk, not just at the end, so however a run stops —
an explicit Cancel, a failed request, the tab closing, the app crashing — the
next visit sees exactly what actually finished and the dock offers to
**finish the rest** from there. A **start over** option sits right next to it
for a clean redo (also reachable any time from the article's ⋯ menu, e.g. to
regenerate at a new speed). While more sections are being made, playback that
catches up to the last one made so far pauses and continues on its own the
moment the next section lands, rather than treating it as the end of the
article. Chunks record the paragraph range they cover, which is what drives
the reading-pane highlight and tap-a-paragraph-to-seek.

**Synthesis progress.** A single request can run for minutes — Kokoro on Modal
is CPU-only, and a cold container boots torch before it answers — so the dock
reports where it actually is: one bar segment per section (widths proportional
to section length), a fill inside each *running* segment estimated from bytes
received — several segments can be filling at once, one per section currently
in flight — the current phase in words (*contacting* → *waiting for a cold
start* → *receiving audio*, summarized across whichever sections are active
right now), and an elapsed clock that keeps ticking as the liveness cue.
`reader-tts.js` also watchdogs each request — `WAIT_MS` for the response
headers, `STALL_MS` between audio chunks — so a dead connection fails with a
description instead of hanging on one section forever. The failure stays in the
dock until the next run rather than vanishing with the toast; sections already
in flight alongside a failed one are left to finish rather than cut short.

**Playback.** Per-chunk durations are measured as each chunk lands (not just
once at the end), so the player presents a single continuous timeline that
grows live while synthesis is still running — seeking, ±15 s and the progress
bar all work across chunk boundaries from section 1 onward. Generation keeps
running even if you back out to the library or open a different article;
only one article generates at a time. Position is remembered per article, and
Media Session wires up the lock-screen controls.

Moving from one section to the next is the seam where a listening session is
most easily lost, so it is kept short and loud. The section after the one
playing is read out of IndexedDB while there is still audio in hand, which
means the handoff in `ended` is synchronous — a new `src` and a `play()` in
that one event, with no `await` in between for a throttled background tab or a
mobile autoplay policy to refuse. When a `play()` *is* refused, or a section
will not decode, or the audio cannot be read back at all, playback parks with
a note in the dock and a toast instead of stopping silently: pressing play
picks it up where it left off.

## Storage

| Key | Contents |
|---|---|
| `reader:settings` | `{ kokoroUrl, kokoroKey, voice, speed, format }` |
| `reader:articles` | Article metadata + text, newest first |
| `reader:progress` | `{ [articleId]: { idx, time } }` |
| IndexedDB `reader-audio` | Audio Blobs, keyed `<articleId>:<chunkIndex>` |

Editing an article's text discards its audio — audio read against words that
have since changed is worse than no audio.

## Service worker

Bump `CACHE` in `sw.js` whenever any file in its `ASSETS` list changes, or
installed clients keep being served the previous version.

## Kokoro API

For reference, the endpoint this app targets:

```
POST <base>/tts
X-API-Key: <TTS_API_KEY>
Content-Type: application/json

{ "text": "...", "voice": "af_heart", "format": "mp3", "speed": 0.9 }
→ 200, streaming audio/mpeg  (format "opus" → audio/ogg)
→ 401 { "detail": "Invalid or missing API key" }
```

The voice-id prefix selects the phonemizer server-side: `bf_`/`bm_` British
English, `zf_`/`zm_` Chinese, anything else American English. There is no voice
catalog endpoint, so the list in `reader-tts.js` is static.

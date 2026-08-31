# Feed Repo — Claude Notes

Two unrelated things live here:

1. **Reader PWA** — the working app. A static, offline-first PWA that turns
   pasted article text into speech via a self-hosted Kokoro TTS instance on
   Modal. **Full deep-dive → [`README.md`](README.md).**
2. **`PLAN.md`** — a specification for a *different*, server-side take on the
   same problem (Chrome capture extension → ingest API on a box → Kokoro →
   RSS → AntennaPod over Tailscale). Nothing in it is implemented, and the
   Reader PWA shares no code with it. Don't treat it as documentation of the
   app.

## Reader PWA

| File | Purpose |
|---|---|
| `index.html` | Shell — markup only, no inline CSS or JS |
| `reader.css` | Styles; light + dark via `prefers-color-scheme` |
| `reader-store.js` | `Store` — `localStorage` (settings, articles, progress) + IndexedDB (audio Blobs) |
| `reader-tts.js` | `TTS` — chunking, Kokoro client, duration measurement |
| `reader-app.js` | UI — hash router, library, reading pane, audio dock, player |
| `sw.js` | Service worker |
| `manifest.json`, `icons/` | PWA install metadata |

### Conventions

- **No build step.** Plain `<script src>` files sharing a global scope, loaded
  in dependency order (`store` → `tts` → `app`). Same style as the `health`
  repo's PWAs.
- **Everything is device-local.** The only outbound request is
  `POST <kokoroUrl>/tts`. Don't add analytics, a backend, or sharing.
- **The API key lives in `localStorage`** (`reader:settings`). Never log it,
  never put it in a URL, never commit a real one.

### IMPORTANT: Service worker versioning

Bump `CACHE` on line 4 of `sw.js` (`reader-v1` → `reader-v2` → …) whenever any
file in its `ASSETS` list changes. Otherwise installed clients keep being served
the previous version after a deploy.

### Kokoro API

The server is `tts/tts.py` in the [`health`](https://github.com/elvinio/health)
repo. Request shape:

```
POST <base>/tts     X-API-Key: <TTS_API_KEY>
{ "text": "...", "voice": "af_heart", "format": "mp3" | "opus", "speed": 0.9 }
→ streaming audio/mpeg (mp3) or audio/ogg (opus); 401 → { "detail": "..." }
```

The voice-id prefix picks the phonemizer server-side (`bf_`/`bm_` British,
`zf_`/`zm_` Chinese, else American). There is no catalog endpoint — `VOICES` in
`reader-tts.js` is a static list and must be kept in step with the server.

### Speed

`speed` is a **synthesis** parameter, so slow speech keeps its natural pitch.
The player only uses `playbackRate` to reconcile a selected speed with the speed
already baked into stored audio (`selected / article.audio.speed`) — never
multiply the two.

### Testing

There is no automated suite. `reader-tts.js` is pure logic and can be exercised
in a Node `vm` (nothing but `buildChunks`/`paragraphs`/`sentences` is needed);
the UI is verified by driving the page with Playwright against a stub `/tts`
endpoint.

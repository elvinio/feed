# Personal Article-to-Audio Pipeline — Implementation Plan

**Goal:** capture full text of articles from sites I subscribe to (SCMP, Medium, Ars Technica)
straight out of my logged-in browser, run it through my self-hosted Kokoro TTS, and listen to
it in AntennaPod on my Android phone — entirely over Tailscale, with nothing publicly reachable.

This document is the specification. It is written to be handed to an implementation agent.
Read the **Constraints** section first; several of the rules there are hard requirements, not
preferences.

---

## 1. Why this shape

Every alternative was considered and rejected for a specific reason:

| Alternative | Rejected because |
|---|---|
| Server-side scraping (Modal, cron + Playwright) | Needs subscription credentials in cloud storage; datacenter IPs trip bot detection; three bespoke scrapers to maintain forever |
| An LLM agent driving the browser per-article | Non-deterministic copy operation — models paraphrase and drop paragraphs silently; ~1 min and real token cost per article |
| Overcast / Pocket Casts | Both fetch feeds and audio **server-side**, so they cannot reach a tailnet-only host |
| Custom PWA player | AntennaPod already solves queue, offline download, speed, sleep timer, lock-screen and Bluetooth controls |
| Cloudflare Tunnel / `tailscale funnel` | Makes the feed publicly reachable. Explicitly out of scope — see Constraints |

What remains: the browser captures (deterministic, verbatim, already authenticated), the box
normalizes and synthesizes, a tailnet-only static server publishes an RSS feed, AntennaPod
downloads on-device.

## 2. Architecture

```
Chrome (logged in, article open)
  │  [Capture] button — Readability against the live DOM
  ▼
POST /ingest ──────────────► Ingest API          (on the box)
                               │  writes capture + enqueues
                               ▼
                             Worker
                               │ 1. normalize text for speech
                               │ 2. chunk → Kokoro → concat
                               │ 3. encode MP3 + ID3 tags
                               │ 4. regenerate feed.xml
                               ▼
                             /srv/newsfeed/web/  (feed.xml + audio/)
                               │
                             tailscale serve (HTTPS, tailnet-only)
                               │
                               ▼
                             AntennaPod on Android — auto-download on wifi
```

Five moving parts, all boring. None of them break when a publisher redesigns their site or
changes bot-detection vendor.

## 3. Constraints (hard requirements)

1. **Tailnet-only, always.** Use `tailscale serve`, never `tailscale funnel`. Do not add a
   Cloudflare Tunnel, ngrok, port-forward, or any public ingress. Do not bind the HTTP server
   to `0.0.0.0` — bind to loopback and let `tailscale serve` proxy to it.
2. **Never summarize, reword, reorder, or "improve" article text.** The normalization pass may
   only delete non-article furniture and adjust rendering of numbers/symbols for speech.
   Producing a paraphrase that I then listen to as if it were the article is the single worst
   failure mode of this system. See §6 for the guard that enforces this.
3. **No redistribution.** This is a personal-use conversion of content I pay for. Single
   listener, single tailnet. Do not add sharing, public links, multi-user support, or an
   "export feed" feature.
4. **No secrets in the repo.** Ingest token and any API keys live in an untracked `.env`
   or systemd credentials. Commit `.env.example` only.
5. **Every milestone must be independently verifiable** before moving to the next — see §11.

## 4. Component: Chrome extension (capture)

Manifest V3. Minimal by design: it is a copy operation, not a scraper.

**Behaviour**
- Toolbar button + keyboard shortcut (suggest `Ctrl+Shift+L`) + right-click context-menu entry.
- On activation: clone the document, run **Mozilla Readability** (bundle it; do not fetch at
  runtime), extract `title`, `byline`, `siteName`, `textContent`, and `content` (HTML).
- POST the result to the configured ingest endpoint with a bearer token.
- Badge feedback: green tick on `202`, red on failure, with the error in the tooltip. It must
  be obvious from the toolbar whether a capture landed.

**Options page:** ingest base URL (the MagicDNS name), bearer token. Stored in
`chrome.storage.local`.

**Permissions:** `activeTab`, `scripting`, `storage`, `contextMenus`, and host permissions
limited to `scmp.com`, `medium.com`, `arstechnica.com` and their subdomains — plus the ingest
host. Do not request `<all_urls>`.

**Note:** capture only works when the laptop is on the tailnet. If the POST fails, the
extension should keep the payload in `chrome.storage.local` in a small outbox and retry on the
next capture or on browser startup. Losing a capture because the VPN was down is a bad
experience — a 5-item outbox is enough.

## 5. Component: ingest API

Small HTTP service (Python 3.11+, FastAPI + uvicorn suggested). Bound to `127.0.0.1`.

**`POST /ingest`**

```json
{
  "url": "https://www.scmp.com/news/...",
  "title": "Article headline",
  "author": "Jane Doe",
  "site": "South China Morning Post",
  "published_at": "2026-08-28T09:00:00Z",
  "text": "…verbatim textContent from Readability…",
  "html": "…Readability content HTML, optional…",
  "captured_at": "2026-08-29T07:14:22Z"
}
```

- Auth: `Authorization: Bearer <token>`, constant-time compare. Yes, even on the tailnet.
- `id = sha256(canonical_url)[:16]`, where canonicalization strips `utm_*`, `gi`, fragments,
  and trailing slashes. Re-capturing the same URL **replaces** the existing item and re-runs
  the pipeline (this is how I fix a bad capture).
- Reject bodies where `text` is under ~500 characters — that is almost always a paywall stub
  or a failed extraction, and it should fail loudly rather than produce 8 seconds of audio.
- Respond `202` with `{"id": …, "status": "queued"}`. Do not synthesize inline.

**`GET /status`** — a plain HTML page listing the last ~50 items with id, title, source, state,
duration, and error message if failed. This is the only UI. It should be readable on a phone,
because that is where I will notice something is missing.

**`POST /retry/{id}`** — re-run from the normalization step.

**State machine:** `captured → normalized → synthesized → published`, plus `failed` with a
`reason`. Store in SQLite (`data/feed.db`) — one table, no ORM needed. Raw captures land in
`queue/{id}.json`, normalized text in `text/{id}.txt`, audio in `audio/{id}.mp3`.

**Layout:**

```
/srv/newsfeed/
  data/feed.db
  queue/{id}.json          # raw capture as received
  text/{id}.txt            # normalized, speakable text
  audio/{id}.mp3           # final encoded audio
  web/feed.xml             # generated
  web/audio/               # bind-mount or symlink to ../audio
  web/art/cover.jpg        # channel artwork, 1400×1400
  .env                     # untracked
```

## 6. Component: normalizer (the part that decides whether this sounds good)

TTS reads literally everything it is given. Bad input — not the voice model — is what makes
SCMP's and Medium's own audio unpleasant. This step matters more than the TTS configuration.

**Run two layers, in order.**

### Layer 1 — deterministic rules (always runs, no network)

Remove:
- "Advertisement", newsletter and subscribe CTAs, "Follow us on…", share/clap/response widgets
- photo credits and image captions, figure attributions
- related-article and "Read more" / "See also" blocks
- author bio boxes, comment counts, tag lists
- SCMP print-edition trailers ("This article appeared in the South China Morning Post print edition as…")
- Medium member/paywall furniture and footer chrome
- bare URLs (delete, do not read aloud)

Transform:
- **Pull quotes:** detect a paragraph whose text appears verbatim (or near-verbatim) elsewhere
  in the body and drop the duplicate. Otherwise you hear the same sentence twice.
- **Code blocks and tables** (mostly Ars): replace with `Code block omitted.` /
  `Table omitted.` Never read them.
- Collapse whitespace; preserve paragraph breaks as blank lines; keep headings on their own
  line with a marker the chunker can see.

### Layer 2 — LLM normalization (optional, improves quality)

A single call to a small, cheap model (Claude Haiku is a good fit) whose **only** permitted
operations are:
- expanding currency, units, percentages, dates, ordinals and ranges into spoken form
  (`HK$1.2 billion` → `one point two billion Hong Kong dollars`; `2019–2024` → `twenty nineteen
  to twenty twenty-four`)
- spacing initialisms so they are spelled out rather than mangled (`GPU`, `API`, `CVE-2024-21413`)
- inserting sentence-final punctuation where the extraction lost it

It must **not** shorten, summarize, reorder, merge, or rewrite sentences.

**The guard (required):** after the LLM call, compare the output against the input. If the
output's word count is below 90% or above 130% of the input's, or if any input paragraph has no
recognizable counterpart in the output, **discard the LLM output and use the Layer 1 result**.
Log that it happened. The rules-only path must always produce usable audio on its own, so that
an API outage or a bad model day degrades quality rather than silently corrupting content.

### Spoken header

Prepend one line: `From {site}. {title}. By {author}.` followed by a pause. Without it, every
episode starts mid-sentence and you lose track of what you are listening to.

## 7. Component: TTS worker

**Kokoro adapter.** I already run Kokoro myself — **confirm the exact API shape of my instance
before writing this** (endpoint path, request/response format, whether it returns WAV or raw
PCM, sample rate, available voice names). Put it behind a single function:

```
synthesize(text: str, voice: str) -> bytes   # WAV
```

Everything else in the worker must go through that function, so swapping or upgrading the TTS
backend touches one file.

**Chunking**
- Split on sentence boundaries into chunks of roughly 400–800 characters. Never split
  mid-sentence — Kokoro's prosody at a chunk boundary is audibly wrong if you do.
- Synthesize chunks sequentially, concatenate with silence: ~350 ms between paragraphs,
  ~700 ms after a heading, ~1 s after the spoken header.
- Retry a failed chunk once; if it fails again, mark the item `failed` rather than shipping
  audio with a hole in it.

**Voice:** one consistent voice across all sources — switching voices per publication sounds
gimmicky and makes speed adjustment harder to settle. Audition a few of Kokoro's voices on the
same SCMP paragraph (names and numbers are a harsher test than demo text) before fixing one in
config. Make it a config value, not a constant.

**Encoding** (ffmpeg): Kokoro outputs 24 kHz mono. Encode MP3 mono at 48–64 kbps — roughly
25–30 MB per hour, ~5 MB for a typical 1,500-word article (~10 minutes at 155 wpm). MP3 rather
than Opus purely for maximum podcast-client compatibility.

**ID3 tags:** `title` = article title, `artist` = source, `album` = feed name, `date` =
publication date, `comment` = original URL, `genre` = Podcast. Optionally write CHAP chapter
frames at heading offsets — AntennaPod reads them and it makes long Ars features much easier to
navigate. Nice-to-have, not milestone-blocking.

Record the exact duration (from ffprobe, not estimated) — the feed needs it.

## 8. Component: feed generator

RSS 2.0 with the `itunes` namespace. Regenerate the whole file after each successful item;
it is small and this avoids incremental-update bugs.

**Channel:** `title`, `description`, `language`, `link`, `itunes:image` (1400×1400 minimum),
`itunes:author`, `itunes:explicit=false`, `lastBuildDate`, `ttl` (60).

**Per item:**
- `guid` — the item id, `isPermaLink="false"`. Must be stable; AntennaPod uses it to detect
  duplicates, and churning guids will re-download everything.
- `title`, `itunes:author` = article author
- `pubDate` — **capture time, not publication time.** This makes the queue ordered by when I
  added things, which is what I actually want.
- `link` — the original article URL, so I can jump to the text from the episode.
- `description` — first ~300 characters of the article plus the source link.
- `enclosure` — `url`, `length` (exact bytes, AntennaPod uses it for progress), `type="audio/mpeg"`.
- `itunes:duration` — `HH:MM:SS` from ffprobe.

Keep the most recent 200 items in the feed. Retention: prune audio files older than 90 days
**and** already marked played, on a weekly timer; keep the DB rows so re-capture dedup still
works.

## 9. Component: serving

```
tailscale serve --bg --https=443 http://127.0.0.1:8080
```

This gives a real HTTPS certificate on the MagicDNS name, reachable only from my tailnet, with
zero public exposure. Do **not** use `tailscale funnel`.

Behind it, serve `web/` with Caddy or nginx (or the ingest app's own static handler, but a real
server is less work). **Range request support is mandatory** — AntennaPod seeks within
partially-downloaded files, and a server that ignores `Range` breaks scrubbing. nginx and Caddy
both handle this correctly for static files; verify it anyway with a `curl -H "Range: bytes=0-99"`
in the acceptance test.

Run the ingest API and worker as systemd units, logging to journald, with `Restart=on-failure`.
The worker can poll the DB every few seconds — at 20 items a day, nothing more sophisticated is
warranted.

**The box must be awake when the phone refreshes.** If it sleeps overnight and I leave at 7am,
I get nothing. Either keep it awake, or set AntennaPod's refresh to a time I know the box is up.

## 10. Component: AntennaPod setup (manual, document it)

Write the exact steps into `README.md`:

1. Add podcast → by URL → `https://<box>.<tailnet>.ts.net/feed.xml`
2. Enable auto-download for this feed; global setting: download on wifi only.
3. Episode cache: keep ~20 episodes; auto-delete played episodes.
4. Refresh interval: every 2 hours (or a fixed morning time matching when the box is up).
5. Note: refresh needs Tailscale active on the phone. Once an episode is downloaded it plays
   offline forever, so a morning sync on wifi covers the whole day.

## 11. Milestones

Each is independently verifiable. Do not start the next one until the current acceptance test
passes.

**M0 — skeleton.** Repo layout, SQLite schema, ingest API with auth, `/status` page.
*Accept:* `curl` a fake payload → `202`, item appears on `/status` as `captured`.

**M1 — capture.** Chrome extension, loaded unpacked.
*Accept:* open a real SCMP article, hit the button, see it on `/status` with plausible word
count. Diff the stored text against what is on screen — it must be verbatim and complete.
Repeat for Medium (member-only story) and Ars.

**M2 — audio.** Rules-only normalizer + Kokoro adapter + chunking + MP3 encode.
*Accept:* an MP3 on disk. **Listen to it end to end.** This is the milestone where quality
problems are cheapest to find. Note every artifact heard (boilerplate read aloud, duplicated
pull quote, mangled number) and fix the rules before continuing.

**M3 — delivery.** Feed generation + `tailscale serve` + AntennaPod.
*Accept:* AntennaPod subscribes, shows the episode, auto-downloads on wifi, plays with correct
duration and working seek. Turn wifi off and confirm it still plays.

**M4 — LLM normalization.** Layer 2 plus the length/paragraph guard and fallback.
*Accept:* on a captured article, the guard triggers correctly on a deliberately sabotaged
(truncated) model response, and rules-only output is used instead.

**M5 — polish.** ID3 chapters, retry endpoint, retention timer, extension outbox, systemd
hardening.

## 12. Stack

Python 3.11+, FastAPI + uvicorn, SQLite (stdlib), ffmpeg/ffprobe, Mozilla Readability bundled
into the extension, Caddy or nginx, systemd, Tailscale. No Docker required; no database server;
no message queue. If a dependency is being added, justify it in the commit message.

## 13. Open items — ask me before assuming

- Exact Kokoro API shape on my box (endpoint, payload, response format, voice list).
- Hostname / MagicDNS name and install path (`/srv/newsfeed` is a placeholder).
- Which Kokoro voice, after I have auditioned a few.
- Whether to use Claude Haiku for Layer 2 or run rules-only to start.

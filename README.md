# Linq BPM agent (sandbox)

Text a YouTube / YouTube Music / Spotify track link to your Linq number and get back **average BPM** plus **timestamps for major tempo changes**, analyzed locally with [Essentia](https://essentia.upf.edu/).

## How it works

1. Inbound iMessage via Linq webhook (or 5s poll fallback)
2. Detect song URL
3. Download audio with `yt-dlp` (Spotify → oEmbed title → YouTube search)
4. Analyze with Essentia `RhythmExtractor2013`
5. Reply over Linq with avg BPM + change timeline

## Sandbox rules

- **Inbound-first** — text the Linq number before the agent can message you
- **No links on first outbound** — first reply is plain text; analysis replies come after
- Up to 100 contacts; number active 7 days; unlimited messages

## Setup

```bash
cp .env.example .env
# LINQ_API_KEY + LINQ_PHONE_NUMBER from https://dashboard.linqapp.com/sandbox-signup
npm install
pip3 install -r requirements.txt   # essentia, yt-dlp, numpy
# ffmpeg required on PATH
```

### YouTube bot checks / Spotify preview

Some hosts (including many cloud VMs) get blocked by YouTube. Export browser cookies to a Netscape `cookies.txt` and set:

```bash
YTDLP_COOKIES=/workspace/cookies.txt
```

Without cookies, **Spotify links still work** via the public 30s preview (`p.scdn.co`) — enough for average BPM, with a note that the full-track tempo map isn’t available.

## Run

```bash
npm start
```

Then text your Linq number a track link, e.g.:

- `https://www.youtube.com/watch?v=…`
- `https://music.youtube.com/watch?v=…`
- `https://open.spotify.com/track/…`

### Analyze locally (no Linq)

```bash
npm run analyze -- https://soundcloud.com/forss/flickermood
npm run analyze -- ./song.wav
```

## Scripts

| Script | What it does |
|--------|----------------|
| `npm start` | Tunnel + webhook + poll fallback |
| `npm run server` | Webhook server only |
| `npm run poll` | Poll chats for inbound (fallback) |
| `npm run analyze` | Run Essentia BPM analysis CLI |
| `npm run send` | Manual `POST /v3/chats` send |
| `npm run subscribe` | Create webhook subscription |

## Example reply

```
Artist — Track Title
Avg BPM: 148.0 (confidence 2.11)
Major BPM changes:
  0:00 → 147.7 BPM
  3:27 → 107.7 BPM
```

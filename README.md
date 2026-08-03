# Linq SoundCloud BPM agent

Text a **SoundCloud** track link to your Linq number and get back **average BPM** plus **timestamps for major tempo changes**, analyzed locally with [Essentia](https://essentia.upf.edu/).

## Flow

1. User texts your Linq number first (sandbox inbound-first)
2. User sends a `soundcloud.com` (or `on.soundcloud.com`) track link
3. Agent downloads audio with `yt-dlp`
4. Essentia `RhythmExtractor2013` computes avg BPM + tempo-change map
5. Agent replies over Linq

## Setup

```bash
cp .env.example .env
# LINQ_API_KEY + LINQ_PHONE_NUMBER
npm install
pip3 install -r requirements.txt
# ffmpeg + yt-dlp on PATH
```

## Run

```bash
npm start
```

Then text `+1…` (your Linq sandbox number) a link like:

```
https://soundcloud.com/forss/flickermood
```

### Analyze without Linq

```bash
npm run analyze -- https://soundcloud.com/forss/flickermood
```

## Sandbox rules

- Inbound-first
- No links / effects on the first outbound message
- Opt-out keywords (`STOP`, etc.) stop replies

## Notes

- **SoundCloud is the primary supported source** (works on this host without cookies)
- Spotify / YouTube still parse, but the agent asks for SoundCloud for best results
- Optional: `YTDLP_COOKIES=/workspace/cookies.txt` if you later expand back to YouTube

## Example reply

```
Forss — Flickermood
Avg BPM: 148.0 (confidence 2.11)
Major BPM changes:
  0:00 → 147.7 BPM
  3:27 → 107.7 BPM
```

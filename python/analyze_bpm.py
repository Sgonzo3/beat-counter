#!/usr/bin/env python3
"""Download a song link (YouTube / YT Music / Spotify) and analyze BPM with Essentia.

Outputs JSON:
{
  "title": "...",
  "source_url": "...",
  "audio_url": "...",   # resolved download URL / search result
  "avg_bpm": 128.4,
  "confidence": 3.2,
  "duration_sec": 210.5,
  "changes": [{"t": 32.1, "bpm": 96.0}, ...],
  "method": "RhythmExtractor2013/multifeature"
}
"""

from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

# Ensure user-local yt-dlp is visible when launched from Node.
os.environ["PATH"] = f"{Path.home() / '.local' / 'bin'}:{os.environ.get('PATH', '')}"

SPOTIFY_RE = re.compile(
    r"https?://(?:open\.)?spotify\.com/(?:intl-[a-z]{2}/)?track/([a-zA-Z0-9]+)",
    re.I,
)
YOUTUBE_RE = re.compile(
    r"https?://(?:(?:www|m|music)\.)?(?:youtube\.com/(?:watch\?v=|shorts/|embed/)|youtu\.be/)([a-zA-Z0-9_-]{6,})",
    re.I,
)
GENERIC_URL_RE = re.compile(r"https?://\S+", re.I)


def die(msg: str, code: int = 1) -> None:
    print(json.dumps({"error": msg}), file=sys.stderr)
    sys.exit(code)


def extract_url(text: str) -> str | None:
    m = GENERIC_URL_RE.search(text.strip())
    return m.group(0).rstrip(").,]>'\"") if m else None


def http_get(url: str, timeout: int = 20) -> bytes:
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": "Mozilla/5.0 (compatible; LinqBpmAgent/1.0)",
            "Accept": "*/*",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


def spotify_oembed_title(url: str) -> str | None:
    endpoint = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")
    try:
        data = json.loads(http_get(endpoint).decode())
        title = data.get("title")
        return str(title).strip() if title else None
    except Exception:
        return None


def spotify_embed_meta(track_url: str) -> dict:
    """Pull title/artists + 30s preview URL from Spotify's public embed page."""
    m = SPOTIFY_RE.search(track_url)
    if not m:
        return {}
    track_id = m.group(1)
    embed = f"https://open.spotify.com/embed/track/{track_id}"
    try:
        html = http_get(embed).decode("utf-8", "ignore")
    except Exception as err:
        return {"error": str(err)}

    preview = None
    pm = re.search(r"https://p\.scdn\.co/mp3-preview/[a-zA-Z0-9]+", html)
    if pm:
        preview = pm.group(0)
    else:
        am = re.search(r'"audioPreview"\s*:\s*\{\s*"url"\s*:\s*"([^"]+)"', html)
        if am:
            preview = am.group(1)

    title = None
    artists: list[str] = []
    nm = re.search(r'"name"\s*:\s*"([^"]+)"\s*,\s*"uri"\s*:\s*"spotify:track:', html)
    if nm:
        title = nm.group(1)
    for amatch in re.finditer(r'"name"\s*:\s*"([^"]+)"\s*,\s*"uri"\s*:\s*"spotify:artist:', html):
        artists.append(amatch.group(1))

    display = title or spotify_oembed_title(track_url) or "Spotify track"
    if artists:
        display = f"{', '.join(dict.fromkeys(artists))} — {display}"

    return {
        "title": display,
        "preview_url": preview,
        "track_id": track_id,
        "partial": True,  # 30s preview, not full track
    }


def cookies_path() -> Path | None:
    raw = os.environ.get("YTDLP_COOKIES", "").strip()
    candidates = []
    if raw:
        candidates.append(Path(raw))
    candidates.append(Path("/workspace/cookies.txt"))
    for path in candidates:
        if path.exists() and path.stat().st_size > 0:
            return path
    return None


def ffmpeg_to_wav(src: Path, dst: Path) -> None:
    cmd = [
        "ffmpeg",
        "-y",
        "-i",
        str(src),
        "-ac",
        "1",
        "-ar",
        "44100",
        str(dst),
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, check=False)
    if proc.returncode != 0 or not dst.exists():
        die(f"ffmpeg failed: {(proc.stderr or '')[-400:]}")


def download_spotify_preview(track_url: str, out_dir: Path) -> tuple[Path, dict] | None:
    meta = spotify_embed_meta(track_url)
    preview = meta.get("preview_url")
    if not preview:
        return None
    mp3_path = out_dir / "preview.mp3"
    wav_path = out_dir / "track.wav"
    try:
        mp3_path.write_bytes(http_get(preview, timeout=30))
    except Exception as err:
        die(f"Failed to download Spotify preview: {err}")
    ffmpeg_to_wav(mp3_path, wav_path)
    return wav_path, {
        "title": meta.get("title"),
        "webpage_url": track_url,
        "partial": True,
        "note": "Analyzed Spotify 30s preview (full-track tempo map unavailable without YouTube cookies)",
    }


def download_ytdlp(target: str, out_dir: Path) -> tuple[Path, dict]:
    out_tmpl = str(out_dir / "track.%(ext)s")
    cmd = [
        "yt-dlp",
        "--no-playlist",
        "-x",
        "--audio-format",
        "wav",
        "--audio-quality",
        "0",
        "-o",
        out_tmpl,
        "--print-json",
        "--no-progress",
        "--download-sections",
        "*0:00-6:00",
    ]
    cookies = cookies_path()
    if cookies:
        cmd.extend(["--cookies", str(cookies)])
    deno = Path.home() / ".deno" / "bin" / "deno"
    if deno.exists():
        cmd.extend(["--js-runtimes", f"deno:{deno}"])
    cmd.append(target)
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, check=False, timeout=180)
    except subprocess.TimeoutExpired:
        die("Audio download timed out")
    if proc.returncode != 0:
        err = proc.stderr.strip()[-800:] or proc.stdout.strip()[-800:]
        if "Sign in to confirm" in err or "not a bot" in err:
            die(
                "YouTube blocked the download (bot check). "
                "Put Netscape cookies in /workspace/cookies.txt "
                "(or set YTDLP_COOKIES). Spotify links still work via 30s preview."
            )
        die(f"yt-dlp failed: {err}")

    meta: dict = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{") and '"id"' in line:
            try:
                meta = json.loads(line)
            except json.JSONDecodeError:
                pass

    wavs = list(out_dir.glob("track.*"))
    if not wavs:
        wavs = [
            p
            for p in out_dir.iterdir()
            if p.suffix.lower() in {".wav", ".m4a", ".mp3", ".webm", ".opus"}
        ]
    if not wavs:
        die("Download succeeded but no audio file found")
    return wavs[0], meta


def acquire_audio(url: str, out_dir: Path) -> tuple[Path, dict]:
    """Resolve a song URL to a local wav + metadata."""
    if SPOTIFY_RE.search(url):
        preview = download_spotify_preview(url, out_dir)
        if preview:
            return preview
        title = spotify_oembed_title(url)
        if not title:
            die("Could not resolve Spotify track (no preview / title)")
        # Fallback: YouTube search (needs cookies on this host).
        path, meta = download_ytdlp(f"ytsearch1:{title}", out_dir)
        meta.setdefault("title", title)
        return path, meta

    if YOUTUBE_RE.search(url) or "youtube.com" in url or "youtu.be" in url:
        return download_ytdlp(url, out_dir)

    if url.startswith("http"):
        return download_ytdlp(url, out_dir)

    die(f"Unsupported URL (need YouTube, YouTube Music, or Spotify track): {url}")


def format_ts(seconds: float) -> str:
    s = max(0, int(round(seconds)))
    return f"{s // 60}:{s % 60:02d}"


def detect_bpm_changes(
    ticks: np.ndarray,
    intervals: np.ndarray,
    *,
    min_delta: float = 5.0,
    min_hold_sec: float = 6.0,
    smooth_window: int = 8,
) -> list[dict]:
    """Convert beat intervals → local BPM series, then find sustained changes."""
    if len(ticks) < 4 or len(intervals) < 4:
        return []

    local_bpm = 60.0 / np.maximum(intervals, 1e-6)
    # Align: interval[i] is between ticks[i] and ticks[i+1]
    times = ticks[: len(local_bpm)]

    # Rolling median smooth
    w = max(3, smooth_window)
    pad = w // 2
    padded = np.pad(local_bpm, (pad, pad), mode="edge")
    smoothed = np.array(
        [np.median(padded[i : i + w]) for i in range(len(local_bpm))],
        dtype=float,
    )

    changes: list[dict] = []
    segment_bpm = float(smoothed[0])
    segment_start = float(times[0])
    # Always include the opening tempo
    changes.append({"t": segment_start, "bpm": round(segment_bpm, 1), "label": format_ts(segment_start)})

    last_change_t = segment_start
    for t, bpm in zip(times, smoothed):
        if abs(bpm - segment_bpm) >= min_delta and (t - last_change_t) >= min_hold_sec:
            # Confirm the new tempo holds for a bit by looking ahead
            ahead = smoothed[(times >= t) & (times <= t + min_hold_sec)]
            if len(ahead) == 0:
                continue
            new_bpm = float(np.median(ahead))
            if abs(new_bpm - segment_bpm) < min_delta:
                continue
            segment_bpm = new_bpm
            last_change_t = float(t)
            changes.append(
                {
                    "t": float(t),
                    "bpm": round(segment_bpm, 1),
                    "label": format_ts(t),
                }
            )

    # Collapse tiny back-to-back flips
    collapsed: list[dict] = []
    for c in changes:
        if collapsed and abs(c["bpm"] - collapsed[-1]["bpm"]) < min_delta:
            continue
        if collapsed and (c["t"] - collapsed[-1]["t"]) < min_hold_sec:
            collapsed[-1] = c
            continue
        collapsed.append(c)
    return collapsed


def analyze_file(path: Path) -> dict:
    import essentia.standard as es

    audio = es.MonoLoader(filename=str(path), sampleRate=44100)()
    duration = float(len(audio) / 44100.0)

    rhythm = es.RhythmExtractor2013(method="multifeature")
    bpm, ticks, confidence, estimates, intervals = rhythm(audio)

    ticks_arr = np.asarray(ticks, dtype=float)
    intervals_arr = np.asarray(intervals, dtype=float)
    changes = detect_bpm_changes(ticks_arr, intervals_arr)

    return {
        "avg_bpm": round(float(bpm), 1),
        "confidence": round(float(confidence), 2),
        "duration_sec": round(duration, 2),
        "beat_count": int(len(ticks_arr)),
        "changes": changes,
        "method": "RhythmExtractor2013/multifeature",
        "estimates_sample": [round(float(x), 1) for x in list(estimates)[:8]],
    }


def format_reply(result: dict) -> str:
    title = result.get("title") or "Track"
    lines = [
        f"{title}",
        f"Avg BPM: {result['avg_bpm']} (confidence {result.get('confidence', '?')})",
    ]
    changes = result.get("changes") or []
    if len(changes) <= 1:
        lines.append("Tempo stays pretty steady — no major BPM shifts detected.")
    else:
        lines.append("Major BPM changes:")
        for c in changes[:12]:
            lines.append(f"  {c['label']} → {c['bpm']} BPM")
        if len(changes) > 12:
            lines.append(f"  …and {len(changes) - 12} more")
    if result.get("partial"):
        lines.append("Note: based on Spotify’s 30s preview, not the full track.")
    elif result.get("note"):
        lines.append(str(result["note"]))
    return "\n".join(lines)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("input", help="Song URL, or path to an audio file")
    parser.add_argument("--keep", action="store_true", help="Keep temp audio")
    parser.add_argument("--json-only", action="store_true")
    args = parser.parse_args()

    raw = args.input.strip()
    url = extract_url(raw) if GENERIC_URL_RE.search(raw) else None
    work = Path(tempfile.mkdtemp(prefix="bpm-", dir="/workspace/tmp/audio"))

    try:
        title_hint = None
        source_url = url or raw
        audio_url = source_url

        partial = False
        note = None
        if url:
            audio_path, meta = acquire_audio(url, work)
            title = (
                meta.get("title")
                or meta.get("track")
                or meta.get("fulltitle")
                or "Track"
            )
            artist = meta.get("artist") or meta.get("uploader")
            if artist and isinstance(artist, str) and artist not in title:
                title = f"{artist} — {title}"
            audio_url = meta.get("webpage_url") or meta.get("preview_url") or url
            partial = bool(meta.get("partial"))
            note = meta.get("note")
        else:
            audio_path = Path(raw)
            if not audio_path.exists():
                die(f"File not found: {raw}")
            title = audio_path.stem

        analysis = analyze_file(audio_path)
        result = {
            "title": title,
            "source_url": source_url,
            "audio_url": audio_url,
            "partial": partial,
            **analysis,
        }
        if note:
            result["note"] = note
        result["reply"] = format_reply(result)

        if args.json_only:
            print(json.dumps(result))
        else:
            print(json.dumps(result, indent=2))
    finally:
        if not args.keep:
            shutil.rmtree(work, ignore_errors=True)


if __name__ == "__main__":
    main()

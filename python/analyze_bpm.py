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


def spotify_oembed_title(url: str) -> str | None:
    endpoint = "https://open.spotify.com/oembed?url=" + urllib.parse.quote(url, safe="")
    try:
        with urllib.request.urlopen(endpoint, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        title = data.get("title")
        return str(title).strip() if title else None
    except Exception:
        return None


def resolve_download_target(url: str) -> tuple[str, str | None]:
    """Return (yt-dlp target, display title hint)."""
    if SPOTIFY_RE.search(url):
        title = spotify_oembed_title(url)
        if not title:
            die("Could not resolve Spotify track title via oEmbed")
        # Spotify audio isn't downloadable via their API; search YouTube.
        return f"ytsearch1:{title}", title
    if YOUTUBE_RE.search(url) or "youtube.com" in url or "youtu.be" in url:
        return url, None
    # SoundCloud and other yt-dlp extractors work as a direct URL.
    if url.startswith("http"):
        return url, None
    die(f"Unsupported URL (need YouTube, YouTube Music, or Spotify track): {url}")


def download_audio(target: str, out_dir: Path) -> tuple[Path, dict]:
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
        # Cap length for hackathon latency — first 6 minutes is enough for BPM.
        "--download-sections",
        "*0:00-6:00",
    ]
    cookies = os.environ.get("YTDLP_COOKIES", "").strip()
    if cookies and Path(cookies).exists():
        cmd.extend(["--cookies", cookies])
    # Helps on some hosts when YouTube serves JS challenges.
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
                "Export cookies to a Netscape file and set YTDLP_COOKIES=/path/to/cookies.txt"
            )
        die(f"yt-dlp failed: {err}")

    meta = {}
    for line in proc.stdout.splitlines():
        line = line.strip()
        if line.startswith("{") and '"id"' in line:
            try:
                meta = json.loads(line)
            except json.JSONDecodeError:
                pass

    wavs = list(out_dir.glob("track.*"))
    if not wavs:
        # download-sections can change naming; pick any audio file
        wavs = [p for p in out_dir.iterdir() if p.suffix.lower() in {".wav", ".m4a", ".mp3", ".webm", ".opus"}]
    if not wavs:
        die("Download succeeded but no audio file found")
    return wavs[0], meta


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

        if url:
            target, title_hint = resolve_download_target(url)
            audio_path, meta = download_audio(target, work)
            title = (
                title_hint
                or meta.get("track")
                or meta.get("title")
                or meta.get("fulltitle")
                or "Track"
            )
            artist = meta.get("artist") or meta.get("uploader")
            if artist and artist not in title:
                title = f"{artist} — {title}"
            audio_url = meta.get("webpage_url") or target
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
            **analysis,
        }
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

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYZER = path.resolve(__dirname, "../python/analyze_bpm.py");

/** SoundCloud first — primary supported source for this agent. */
const SOUNDCLOUD_URL_RE =
  /https?:\/\/(?:(?:www|m|on)\.)?soundcloud\.com\/[^\s<>"']+/i;

/** Kept for optional fallbacks; agent copy focuses on SoundCloud. */
const OTHER_SONG_URL_RE =
  /https?:\/\/(?:(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?track\/|(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?[^?\s]*v=|shorts\/|embed\/)|youtu\.be\/))[^\s<>"']+/i;

export type BpmChange = { t: number; bpm: number; label: string };

export type BpmResult = {
  title: string;
  source_url: string;
  audio_url?: string;
  avg_bpm: number;
  confidence: number;
  duration_sec: number;
  changes: BpmChange[];
  reply: string;
  method: string;
  error?: string;
};

export function isSoundCloudUrl(url: string): boolean {
  return SOUNDCLOUD_URL_RE.test(url);
}

/** Prefer SoundCloud URLs; otherwise accept Spotify/YouTube if present. */
export function extractSongUrl(text: string): string | null {
  const sc = text.match(SOUNDCLOUD_URL_RE);
  if (sc) return cleanUrl(sc[0]);
  const other = text.match(OTHER_SONG_URL_RE);
  if (other) return cleanUrl(other[0]);
  return null;
}

/** Pull song URL from Linq message parts (text and link). */
export function extractSongUrlFromParts(
  parts: ReadonlyArray<{ type: string; value?: string | null }>,
): string | null {
  // Prefer explicit link parts.
  for (const part of parts) {
    if (part.type === "link" && typeof part.value === "string") {
      const url = extractSongUrl(part.value) ?? cleanUrl(part.value);
      if (url && (isSoundCloudUrl(url) || OTHER_SONG_URL_RE.test(url))) {
        return url;
      }
    }
  }
  const text = parts
    .filter((p) => p.type === "text" && typeof p.value === "string")
    .map((p) => p.value as string)
    .join("\n");
  return extractSongUrl(text);
}

function cleanUrl(raw: string): string {
  return raw.replace(/[).,\]>'"]+$/g, "");
}

export function analyzeSongUrl(url: string, timeoutMs = 180_000): Promise<BpmResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("python3", [ANALYZER, url, "--json-only"], {
      env: {
        ...process.env,
        PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? ""}`,
      },
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("BPM analysis timed out"));
    }, timeoutMs);

    child.stdout.on("data", (d) => {
      stdout += d.toString();
    });
    child.stderr.on("data", (d) => {
      stderr += d.toString();
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const line = stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .at(-1);
      if (!line) {
        reject(new Error(stderr.trim() || `Analyzer exited ${code} with no output`));
        return;
      }
      try {
        const parsed = JSON.parse(line) as BpmResult & { error?: string };
        if (parsed.error) {
          reject(new Error(parsed.error));
          return;
        }
        if (code !== 0) {
          reject(new Error(stderr.trim() || `Analyzer exited ${code}`));
          return;
        }
        resolve(parsed);
      } catch {
        reject(new Error(stderr.trim() || `Bad analyzer JSON: ${line.slice(0, 200)}`));
      }
    });
  });
}

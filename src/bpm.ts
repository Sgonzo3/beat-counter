import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ANALYZER = path.resolve(__dirname, "../python/analyze_bpm.py");

const SONG_URL_RE =
  /https?:\/\/(?:(?:open\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?track\/|(?:(?:www|m|music)\.)?(?:youtube\.com\/(?:watch\?[^?\s]*v=|shorts\/|embed\/)|youtu\.be\/)|(?:(?:www|m|on)\.)?soundcloud\.com\/)[^\s]+/i;

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

export function extractSongUrl(text: string): string | null {
  const m = text.match(SONG_URL_RE);
  if (!m) return null;
  return m[0].replace(/[).,\]>'"]+$/g, "");
}

export function analyzeSongUrl(url: string, timeoutMs = 180_000): Promise<BpmResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "python3",
      [ANALYZER, url, "--json-only"],
      {
        env: {
          ...process.env,
          PATH: `${process.env.HOME}/.local/bin:${process.env.PATH ?? ""}`,
        },
      },
    );

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

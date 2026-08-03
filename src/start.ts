import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { createLinqClient } from "./linq.js";

/**
 * End-to-end starter:
 * 1. Start the webhook server
 * 2. Open a Cloudflare quick tunnel (public HTTPS)
 * 3. Subscribe it to message.received and save signing_secret to .env
 * 4. Start the poll fallback
 * 5. Print inbound-first instructions
 *
 * The server re-reads LINQ_WEBHOOK_SECRET from .env on each request.
 */
function upsertEnv(key: string, value: string) {
  const envPath = ".env";
  const line = `${key}=${value}`;
  if (!existsSync(envPath)) {
    writeFileSync(envPath, `${line}\n`);
    return;
  }
  const current = readFileSync(envPath, "utf8");
  if (new RegExp(`^${key}=`, "m").test(current)) {
    writeFileSync(
      envPath,
      current.replace(new RegExp(`^${key}=.*$`, "m"), line),
    );
  } else {
    appendFileSync(envPath, `${current.endsWith("\n") ? "" : "\n"}${line}\n`);
  }
  process.env[key] = value;
}

async function waitForHealth(port: number, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`);
      if (res.ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error("Server failed to become healthy");
}

function startTunnel(port: number): Promise<{ url: string; child: ReturnType<typeof spawn> }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      "cloudflared",
      ["tunnel", "--url", `http://127.0.0.1:${port}`],
      { stdio: ["ignore", "pipe", "pipe"] },
    );

    let settled = false;
    const onData = (buf: Buffer) => {
      const text = buf.toString();
      process.stderr.write(text);
      const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (match && !settled) {
        settled = true;
        resolve({ url: match[0], child });
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    child.on("error", (err) => {
      if (!settled) reject(err);
    });
    child.on("exit", (code) => {
      if (!settled) reject(new Error(`cloudflared exited early (${code})`));
    });

    setTimeout(() => {
      if (!settled) reject(new Error("Timed out waiting for cloudflared URL"));
    }, 60_000);
  });
}

async function createFreshSubscription(publicBase: string) {
  const targetUrl = `${publicBase.replace(/\/$/, "")}/webhook?version=2026-02-03`;
  const client = createLinqClient();

  const existing = await client.webhookSubscriptions.list();
  for (const sub of existing.subscriptions) {
    if (
      sub.target_url.includes("loca.lt") ||
      sub.target_url.includes("trycloudflare.com")
    ) {
      console.log(`Deleting stale subscription ${sub.id}`);
      await client.webhookSubscriptions.delete(sub.id);
    }
  }

  let lastErr: unknown;
  for (let attempt = 1; attempt <= 12; attempt++) {
    try {
      const created = await client.webhookSubscriptions.create({
        target_url: targetUrl,
        subscribed_events: ["message.received"],
        phone_numbers: [config.linqNumber()],
      });

      upsertEnv("LINQ_WEBHOOK_SECRET", created.signing_secret);
      upsertEnv("PUBLIC_WEBHOOK_URL", publicBase.replace(/\/$/, ""));
      console.log(`Created webhook subscription ${created.id}`);
      console.log(`Target: ${targetUrl}`);
      return created;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`Subscribe attempt ${attempt}/12 failed: ${msg}`);
      await new Promise((r) => setTimeout(r, 4000));
    }
  }
  throw lastErr;
}

async function main() {
  const linqNumber = config.linqNumber();
  config.apiKey();
  const port = config.port;

  const server = spawn("npx", ["tsx", "src/server.ts"], {
    stdio: "inherit",
    env: { ...process.env },
  });

  await waitForHealth(port);
  console.log("Local server is up.");

  const { url: publicUrl, child: tunnel } = await startTunnel(port);
  console.log(`Public URL: ${publicUrl}`);

  await createFreshSubscription(publicUrl);

  const poller = spawn("npx", ["tsx", "src/poll.ts"], {
    stdio: "inherit",
    env: { ...process.env },
  });

  const shutdown = (code = 0) => {
    for (const child of [server, tunnel, poller]) {
      try {
        child.kill("SIGTERM");
      } catch {
        // ignore
      }
    }
    process.exit(code);
  };
  process.on("SIGINT", () => shutdown(0));
  process.on("SIGTERM", () => shutdown(0));
  tunnel.on("exit", () => {
    console.error("Tunnel exited — poll fallback still covers inbound replies");
  });
  server.on("exit", (code, signal) => {
    if (signal === "SIGTERM" || signal === "SIGINT") return;
    console.error(`Server exited (${code})`);
    shutdown(code ?? 1);
  });

  console.log(`
============================================================
  SoundCloud BPM agent ready (inbound-first)

  1. From your iPhone, text your Linq number:
       ${linqNumber}

  2. Send a SoundCloud track link, e.g.
       https://soundcloud.com/forss/flickermood

  3. Agent replies with avg BPM + major tempo-change timestamps.

  Webhook: ${publicUrl}/webhook?version=2026-02-03
  Fallback: polling chats every 5s if webhooks flake
============================================================
`);

  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

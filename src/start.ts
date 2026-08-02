import { spawn } from "node:child_process";
import { writeFileSync, appendFileSync, readFileSync, existsSync } from "node:fs";
import { config } from "./config.js";
import { createLinqClient } from "./linq.js";

/**
 * End-to-end starter:
 * 1. Open a Cloudflare quick tunnel (public HTTPS)
 * 2. Subscribe it to message.received and capture signing_secret
 * 3. Start the webhook server with that secret
 * 4. Print inbound-first instructions
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

async function createFreshSubscription(publicBase: string) {
  const targetUrl = `${publicBase.replace(/\/$/, "")}/webhook?version=2026-02-03`;
  const client = createLinqClient();

  // Quick tunnels get a new hostname each run. Remove stale trycloudflare subs
  // so the account doesn't fill up during hackathon iteration.
  const existing = await client.webhookSubscriptions.list();
  for (const sub of existing.subscriptions) {
    if (sub.target_url.includes("trycloudflare.com")) {
      console.log(`Deleting stale subscription ${sub.id}`);
      await client.webhookSubscriptions.delete(sub.id);
    }
  }

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
}

async function main() {
  const linqNumber = config.linqNumber();
  config.apiKey();
  const port = config.port;

  const { url: publicUrl, child: tunnel } = await startTunnel(port);
  console.log(`Public URL: ${publicUrl}`);

  await createFreshSubscription(publicUrl);

  const server = spawn("npx", ["tsx", "src/server.ts"], {
    stdio: "inherit",
    env: { ...process.env },
  });

  const shutdown = () => {
    server.kill("SIGTERM");
    tunnel.kill("SIGTERM");
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
  tunnel.on("exit", () => {
    console.error("Tunnel exited");
    shutdown();
  });
  server.on("exit", (code) => {
    console.error(`Server exited (${code})`);
    tunnel.kill("SIGTERM");
    process.exit(code ?? 1);
  });

  await waitForHealth(port);

  console.log(`
============================================================
  Sandbox is ready (inbound-first)

  1. From your iPhone, text your Linq number:
       ${linqNumber}

  2. This agent will reply with:
       "Hello from my agent!"
     then a follow-up that may include a link (safe once the chat exists).

  3. Optional manual send after they've texted you:
       npm run send -- <yourPhoneE164>

  Webhook: ${publicUrl}/webhook?version=2026-02-03
============================================================
`);

  await new Promise(() => {});
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

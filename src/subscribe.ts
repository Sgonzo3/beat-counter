import { config } from "./config.js";
import { createLinqClient } from "./linq.js";

/**
 * Create (or reuse) a webhook subscription for message.received.
 *
 * Usage:
 *   PUBLIC_WEBHOOK_URL=https://xxxx.trycloudflare.com npm run subscribe
 *
 * Saves LINQ_WEBHOOK_SECRET to stdout so you can put it in .env.
 */
async function main() {
  const baseUrl = config.publicUrl() || process.argv[2];
  if (!baseUrl) {
    throw new Error(
      "Set PUBLIC_WEBHOOK_URL or pass the public HTTPS base URL as an argument.",
    );
  }

  const targetUrl = new URL("/webhook", baseUrl.replace(/\/$/, "")).toString();
  const versionedUrl = `${targetUrl}?version=2026-02-03`;

  const client = createLinqClient();

  const existing = await client.webhookSubscriptions.list();
  const match = existing.subscriptions.find((s) => s.target_url === versionedUrl);

  if (match) {
    console.log("Webhook subscription already exists:");
    console.log(JSON.stringify(match, null, 2));
    console.log(
      "\nNote: signing_secret is only returned at creation time. Keep your existing LINQ_WEBHOOK_SECRET.",
    );
    return;
  }

  const subscription = await client.webhookSubscriptions.create({
    target_url: versionedUrl,
    subscribed_events: ["message.received"],
    phone_numbers: [config.linqNumber()],
  });

  console.log("Created webhook subscription:");
  console.log(JSON.stringify(subscription, null, 2));
  console.log("\nAdd this to your .env:");
  console.log(`LINQ_WEBHOOK_SECRET=${subscription.signing_secret}`);
  console.log(`PUBLIC_WEBHOOK_URL=${baseUrl.replace(/\/$/, "")}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

import express from "express";
import type { Request, Response } from "express";
import { config } from "./config.js";
import { createLinqClient } from "./linq.js";
import { handleInboundMessage, optedOutChats } from "./handler.js";

const port = config.port;
const app = express();
const seenEvents = new Set<string>();

function headersToRecord(headers: Request["headers"]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (typeof value === "string") out[key] = value;
    else if (Array.isArray(value) && value[0]) out[key] = value[0];
  }
  return out;
}

function extractText(parts: ReadonlyArray<{ type: string; value?: string | null }>): string {
  return parts
    .filter((p): p is { type: "text"; value: string } => p.type === "text" && typeof p.value === "string")
    .map((p) => p.value)
    .join("\n")
    .trim();
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, service: "linq-agent", focus: "soundcloud" });
});

app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body ?? "");

    let event;
    try {
      const client = createLinqClient();
      event = client.webhooks.unwrap(rawBody, {
        headers: headersToRecord(req.headers),
      });
    } catch (err) {
      console.error("Webhook signature verification failed:", err);
      res.status(401).json({ error: "invalid signature" });
      return;
    }

    res.status(200).json({ received: true });

    if (seenEvents.has(event.event_id)) {
      console.log(`Duplicate event ignored: ${event.event_id}`);
      return;
    }
    seenEvents.add(event.event_id);
    console.log(`Event: ${event.event_type} (${event.event_id})`);

    if (event.event_type !== "message.received") return;

    const data = event.data as {
      chat: { id: string; health_status?: { status?: string } | null };
      parts: Array<{ type: string; value?: string | null }>;
      sender_handle?: { handle?: string | null } | null;
    };
    const chatId = data.chat.id;
    const health = data.chat.health_status?.status;
    const parts = data.parts ?? [];
    const text = extractText(parts);
    const from = data.sender_handle?.handle;

    console.log(`Inbound from ${from} chat=${chatId}: ${JSON.stringify(text)}`);

    if (health === "OPTED_OUT" || optedOutChats.has(chatId)) {
      console.log(`Skipping reply — chat ${chatId} is opted out`);
      return;
    }

    try {
      await handleInboundMessage(chatId, text, parts);
    } catch (err) {
      console.error("Failed to handle inbound:", err);
    }
  },
);

app.listen(port, () => {
  console.log(`Linq agent listening on http://localhost:${port}`);
  console.log(`Webhook path: POST /webhook?version=2026-02-03`);
  console.log(
    `\nText ${process.env.LINQ_PHONE_NUMBER || "your Linq number"} a SoundCloud link for BPM analysis.`,
  );
});

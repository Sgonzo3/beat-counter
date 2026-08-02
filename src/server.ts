import express from "express";
import type { Request, Response } from "express";
import { config, OPT_OUT_KEYWORDS, containsUrl } from "./config.js";
import { createLinqClient } from "./linq.js";

const port = config.port;
const app = express();

/** Chats that already got a first safe outbound (no links). */
const chatsWithOutbound = new Set<string>();
/** Chats that opted out locally. */
const optedOutChats = new Set<string>();
/** Deduplicate webhook deliveries. */
const seenEvents = new Set<string>();

const FIRST_REPLY = "Hello from my agent!";
const FOLLOW_UP_WITH_LINK =
  "Nice — chat is open. Docs: https://docs.linqapp.com/getting-started/quickstart/";

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
  res.json({ ok: true, service: "linq-agent" });
});

// Raw body required for Standard Webhooks signature verification.
app.post(
  "/webhook",
  express.raw({ type: "*/*" }),
  async (req: Request, res: Response) => {
    const rawBody = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : String(req.body ?? "");

    // Ack quickly; process after. Still verify first so bad requests 4xx.
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

    // SDK types event_type as the full union, so narrow explicitly.
    const data = event.data as {
      chat: { id: string; health_status?: { status?: string } | null };
      parts: Array<{ type: string; value?: string | null }>;
      sender_handle?: { handle?: string | null } | null;
    };
    const chatId = data.chat.id;
    const health = data.chat.health_status?.status;
    const text = extractText(data.parts);
    const from = data.sender_handle?.handle;

    console.log(`Inbound from ${from} chat=${chatId}: ${JSON.stringify(text)}`);

    if (health === "OPTED_OUT" || optedOutChats.has(chatId)) {
      console.log(`Skipping reply — chat ${chatId} is opted out`);
      return;
    }

    if (OPT_OUT_KEYWORDS.has(text) || /stop messaging me/i.test(text)) {
      optedOutChats.add(chatId);
      console.log(`Opt-out from ${from}; no further outbound`);
      return;
    }

    try {
      const client = createLinqClient();
      const isFirstOutbound = !chatsWithOutbound.has(chatId);

      // Sandbox: first outbound must not include links, reply_to, or effects.
      const replyText = isFirstOutbound ? FIRST_REPLY : `You said: ${text || "(non-text)"}`;

      if (containsUrl(replyText) && isFirstOutbound) {
        throw new Error("Refusing to send URL on first outbound message");
      }

      const sent = await client.chats.messages.send(chatId, {
        message: {
          parts: [{ type: "text", value: replyText }],
        },
      });
      chatsWithOutbound.add(chatId);
      console.log(`Replied to chat ${chatId}: message ${sent.message.id}`);

      // After the chat exists and first safe message is sent, links are OK.
      if (isFirstOutbound) {
        const followUp = await client.chats.messages.send(chatId, {
          message: {
            parts: [{ type: "text", value: FOLLOW_UP_WITH_LINK }],
          },
        });
        console.log(`Follow-up with link sent: ${followUp.message.id}`);
      }
    } catch (err) {
      console.error("Failed to reply:", err);
    }
  },
);

app.listen(port, () => {
  console.log(`Linq agent listening on http://localhost:${port}`);
  console.log(`Webhook path: POST /webhook?version=2026-02-03`);
  console.log(
    `\nSandbox flow: text ${process.env.LINQ_PHONE_NUMBER || "your Linq number"} first, then this agent will reply.`,
  );
});

import { config, OPT_OUT_KEYWORDS, containsUrl } from "./config.js";
import { createLinqClient } from "./linq.js";

/**
 * Fallback when public tunnels flake: poll recent chats for new inbound
 * messages and reply the same way the webhook handler does.
 */
const FIRST_REPLY = "Hello from my agent!";
const FOLLOW_UP_WITH_LINK =
  "Nice — chat is open. Docs: https://docs.linqapp.com/getting-started/quickstart/";

const seenMessageIds = new Set<string>();
const chatsWithOutbound = new Set<string>();
const optedOutChats = new Set<string>();

async function tick() {
  const client = createLinqClient();
  const from = config.linqNumber();

  for await (const chat of client.chats.listChats({ from, limit: 20 })) {
    const chatId = chat.id;
    if (optedOutChats.has(chatId)) continue;
    if (chat.health_status?.status === "OPTED_OUT") {
      optedOutChats.add(chatId);
      continue;
    }

    for await (const message of client.chats.messages.list(chatId, { limit: 5 })) {
      if (seenMessageIds.has(message.id)) continue;
      seenMessageIds.add(message.id);

      if (message.is_from_me) continue;

      const text = (message.parts ?? [])
        .map((p) => (p.type === "text" && "value" in p && typeof p.value === "string" ? p.value : ""))
        .filter(Boolean)
        .join("\n")
        .trim();

      console.log(`[poll] inbound chat=${chatId} msg=${message.id}: ${JSON.stringify(text)}`);

      if (OPT_OUT_KEYWORDS.has(text) || /stop messaging me/i.test(text)) {
        optedOutChats.add(chatId);
        console.log(`[poll] opt-out chat=${chatId}`);
        continue;
      }

      const ageMs = Date.now() - new Date(message.sent_at ?? message.created_at).getTime();
      if (ageMs > 60_000) {
        console.log(`[poll] skip old message (${Math.round(ageMs / 1000)}s)`);
        continue;
      }

      const isFirstOutbound = !chatsWithOutbound.has(chatId);
      const replyText = isFirstOutbound ? FIRST_REPLY : `You said: ${text || "(non-text)"}`;
      if (containsUrl(replyText) && isFirstOutbound) {
        throw new Error("Refusing to send URL on first outbound message");
      }

      const sent = await client.chats.messages.send(chatId, {
        message: { parts: [{ type: "text", value: replyText }] },
      });
      chatsWithOutbound.add(chatId);
      console.log(`[poll] replied ${sent.message.id}`);

      if (isFirstOutbound) {
        const followUp = await client.chats.messages.send(chatId, {
          message: { parts: [{ type: "text", value: FOLLOW_UP_WITH_LINK }] },
        });
        console.log(`[poll] follow-up ${followUp.message.id}`);
      }
    }
  }
}

async function main() {
  config.apiKey();
  config.linqNumber();
  console.log("Polling for inbound messages every 5s (webhook fallback)...");

  const client = createLinqClient();
  for await (const chat of client.chats.listChats({ from: config.linqNumber(), limit: 50 })) {
    for await (const message of client.chats.messages.list(chat.id, { limit: 10 })) {
      seenMessageIds.add(message.id);
      if (message.is_from_me) chatsWithOutbound.add(chat.id);
    }
  }
  console.log(`Primed ${seenMessageIds.size} message ids`);

  for (;;) {
    try {
      await tick();
    } catch (err) {
      console.error("[poll] error:", err);
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

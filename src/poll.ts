import { config } from "./config.js";
import { createLinqClient } from "./linq.js";
import {
  chatsWithOutbound,
  handleInboundMessage,
  optedOutChats,
} from "./handler.js";

const seenMessageIds = new Set<string>();

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

      if (message.is_from_me) {
        chatsWithOutbound.add(chatId);
        continue;
      }

      const parts = (message.parts ?? []).map((p) => ({
        type: p.type,
        value: "value" in p && typeof p.value === "string" ? p.value : null,
      }));

      const text = parts
        .filter((p) => p.type === "text" && p.value)
        .map((p) => p.value as string)
        .join("\n")
        .trim();

      console.log(`[poll] inbound chat=${chatId} msg=${message.id}: ${JSON.stringify(text)}`);

      const ageMs = Date.now() - new Date(message.sent_at ?? message.created_at).getTime();
      if (ageMs > 90_000) {
        console.log(`[poll] skip old message (${Math.round(ageMs / 1000)}s)`);
        continue;
      }

      await handleInboundMessage(chatId, text, parts);
    }
  }
}

async function main() {
  config.apiKey();
  config.linqNumber();
  console.log("Polling for SoundCloud links every 5s (webhook fallback)...");

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

import { config, containsUrl } from "./config.js";
import { createLinqClient } from "./linq.js";

/**
 * Send an iMessage via POST /v3/chats (create chat + first message).
 *
 * Sandbox rules:
 * - Recipient must have texted your Linq number first (inbound-first).
 * - First outbound in a new chat must NOT contain links / reply_to / effects.
 *
 * Usage:
 *   npm run send -- +15551234567
 *   npm run send -- +15551234567 "Hello from my agent!"
 *   npm run send -- +15551234567 "Follow-up with https://example.com" --follow-up <chat_id>
 */
async function main() {
  const args = process.argv.slice(2).filter((a) => a !== "--");
  const followUpIdx = args.indexOf("--follow-up");
  let chatId: string | undefined;
  if (followUpIdx !== -1) {
    chatId = args[followUpIdx + 1];
    args.splice(followUpIdx, 2);
  }

  const to = args[0];
  const message = args[1] ?? "Hello from my agent!";

  if (!to) {
    throw new Error("Usage: npm run send -- <+recipientE164> [message]");
  }

  const client = createLinqClient();

  if (chatId) {
    // Existing chat — links are allowed here.
    const sent = await client.chats.messages.send(chatId, {
      message: {
        parts: [{ type: "text", value: message }],
      },
    });
    console.log("Sent follow-up:");
    console.log(JSON.stringify(sent, null, 2));
    return;
  }

  if (containsUrl(message)) {
    throw new Error(
      "Sandbox rejects links on POST /v3/chats (first outbound). " +
        "Send a text-only first message, then use --follow-up <chat_id> for links.",
    );
  }

  // Creates (or opens) a chat and sends the first message — same as:
  // POST https://api.linqapp.com/api/partner/v3/chats
  const chat = await client.chats.create({
    from: config.linqNumber(),
    to: [to],
    message: {
      parts: [{ type: "text", value: message }],
    },
  });

  console.log("Chat created / message sent:");
  console.log(JSON.stringify(chat, null, 2));
  console.log(
    `\nTo send a link next:\n  npm run send -- ${to} "https://docs.linqapp.com" --follow-up ${chat.chat.id}`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

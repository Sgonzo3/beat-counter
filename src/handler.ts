import { OPT_OUT_KEYWORDS, containsUrl } from "./config.js";
import { createLinqClient } from "./linq.js";
import { analyzeSongUrl, extractSongUrl } from "./bpm.js";

const FIRST_REPLY = "Hello from my agent!";
const HELP =
  "Send a YouTube, YouTube Music, or Spotify track link and I'll reply with average BPM + major tempo-change timestamps.";

export const chatsWithOutbound = new Set<string>();
export const optedOutChats = new Set<string>();

export async function handleInboundText(chatId: string, text: string): Promise<void> {
  const client = createLinqClient();
  const isFirstOutbound = !chatsWithOutbound.has(chatId);

  if (OPT_OUT_KEYWORDS.has(text) || /stop messaging me/i.test(text)) {
    optedOutChats.add(chatId);
    console.log(`Opt-out chat=${chatId}`);
    return;
  }

  // Sandbox: first outbound must not contain links.
  if (isFirstOutbound) {
    await client.chats.messages.send(chatId, {
      message: { parts: [{ type: "text", value: FIRST_REPLY }] },
    });
    chatsWithOutbound.add(chatId);
    await client.chats.messages.send(chatId, {
      message: { parts: [{ type: "text", value: HELP }] },
    });
  }

  const songUrl = extractSongUrl(text);
  if (!songUrl) {
    if (!isFirstOutbound) {
      const reply = text.trim()
        ? `Got it. ${HELP}`
        : HELP;
      if (containsUrl(reply) && !chatsWithOutbound.has(chatId)) {
        // shouldn't happen after first outbound
      }
      await client.chats.messages.send(chatId, {
        message: { parts: [{ type: "text", value: reply }] },
      });
    }
    return;
  }

  await client.chats.messages.send(chatId, {
    message: {
      parts: [
        {
          type: "text",
          value: "Analyzing tempo with Essentia — give me a moment…",
        },
      ],
    },
  });
  chatsWithOutbound.add(chatId);

  try {
    const result = await analyzeSongUrl(songUrl);
    await client.chats.messages.send(chatId, {
      message: { parts: [{ type: "text", value: result.reply }] },
    });
    console.log(`BPM reply chat=${chatId} avg=${result.avg_bpm}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("BPM analysis failed:", msg);
    await client.chats.messages.send(chatId, {
      message: {
        parts: [
          {
            type: "text",
            value: `Couldn't analyze that track (${msg.slice(0, 160)}). Try another YouTube or Spotify link.`,
          },
        ],
      },
    });
  }
}

import { OPT_OUT_KEYWORDS } from "./config.js";
import { createLinqClient } from "./linq.js";
import {
  analyzeSongUrl,
  extractSongUrl,
  extractSongUrlFromParts,
  isSoundCloudUrl,
} from "./bpm.js";

const FIRST_REPLY = "Hello from my agent!";
const HELP =
  "Send a SoundCloud track link and I'll reply with average BPM + major tempo-change timestamps.";

export const chatsWithOutbound = new Set<string>();
export const optedOutChats = new Set<string>();

type InboundPart = { type: string; value?: string | null };

export async function handleInboundMessage(
  chatId: string,
  text: string,
  parts: ReadonlyArray<InboundPart> = [],
): Promise<void> {
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

  const songUrl =
    (parts.length ? extractSongUrlFromParts(parts) : null) ?? extractSongUrl(text);

  if (!songUrl) {
    if (!isFirstOutbound) {
      await client.chats.messages.send(chatId, {
        message: {
          parts: [
            {
              type: "text",
              value: text.trim() ? `Got it. ${HELP}` : HELP,
            },
          ],
        },
      });
    }
    return;
  }

  if (!isSoundCloudUrl(songUrl)) {
    await client.chats.messages.send(chatId, {
      message: {
        parts: [
          {
            type: "text",
            value:
              "Right now I analyze SoundCloud links best. Paste a soundcloud.com track URL and I'll get the BPM.",
          },
        ],
      },
    });
    chatsWithOutbound.add(chatId);
    return;
  }

  await client.chats.messages.send(chatId, {
    message: {
      parts: [
        {
          type: "text",
          value: "Analyzing that SoundCloud track with Essentia — one moment…",
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
    console.log(`BPM reply chat=${chatId} avg=${result.avg_bpm} url=${songUrl}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("BPM analysis failed:", msg);
    await client.chats.messages.send(chatId, {
      message: {
        parts: [
          {
            type: "text",
            value: `Couldn't analyze that SoundCloud track (${msg.slice(0, 140)}). Try another public track link.`,
          },
        ],
      },
    });
  }
}

/** @deprecated use handleInboundMessage */
export async function handleInboundText(chatId: string, text: string): Promise<void> {
  return handleInboundMessage(chatId, text);
}

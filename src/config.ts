import "dotenv/config";

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(
      `Missing ${name}. Copy .env.example to .env and fill in your sandbox credentials.`,
    );
  }
  return value;
}

export const config = {
  apiKey: () => required("LINQ_API_KEY"),
  linqNumber: () => required("LINQ_PHONE_NUMBER"),
  webhookSecret: () => process.env.LINQ_WEBHOOK_SECRET?.trim() || "",
  port: Number(process.env.PORT || 3000),
  publicUrl: () => process.env.PUBLIC_WEBHOOK_URL?.trim() || "",
};

export const OPT_OUT_KEYWORDS = new Set([
  "STOP",
  "UNSUBSCRIBE",
  "OPTOUT",
  "CANCEL",
  "END",
  "QUIT",
]);

/** True if text looks like it contains a URL (sandbox rejects these on first outbound). */
export function containsUrl(text: string): boolean {
  return /https?:\/\/|www\./i.test(text);
}

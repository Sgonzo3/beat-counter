import { readFileSync, existsSync } from "node:fs";
import LinqAPIV3 from "@linqapp/sdk";
import { config } from "./config.js";

/** Re-read .env so `npm start` can write LINQ_WEBHOOK_SECRET after the server boots. */
function readEnvFileValue(key: string): string {
  if (!existsSync(".env")) return "";
  const match = readFileSync(".env", "utf8").match(new RegExp(`^${key}=(.*)$`, "m"));
  return match?.[1]?.trim() ?? "";
}

export function createLinqClient(webhookSecret?: string) {
  const secret =
    webhookSecret ||
    config.webhookSecret() ||
    readEnvFileValue("LINQ_WEBHOOK_SECRET") ||
    "";

  if (secret) process.env.LINQ_WEBHOOK_SECRET = secret;

  return new LinqAPIV3({
    apiKey: process.env.LINQ_API_KEY || readEnvFileValue("LINQ_API_KEY"),
    webhookSecret: secret || null,
  });
}

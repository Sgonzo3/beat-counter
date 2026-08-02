import LinqAPIV3 from "@linqapp/sdk";
import { config } from "./config.js";

export function createLinqClient(webhookSecret?: string) {
  return new LinqAPIV3({
    apiKey: config.apiKey(),
    webhookSecret: webhookSecret ?? (config.webhookSecret() || null),
  });
}

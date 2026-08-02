# Linq iMessage agent (sandbox)

Minimal TypeScript agent that sends and receives iMessages via the [Linq Partner API](https://docs.linqapp.com/getting-started/quickstart/).

## Sandbox rules this project respects

- **Inbound-first** — someone must text your Linq number before the agent messages them.
- **No links on first outbound** — the first reply is plain text; a link is sent only in a follow-up after the chat exists.
- Up to 100 contacts; number active 7 days; unlimited messages.

## Setup

```bash
cp .env.example .env
# Edit .env with LINQ_API_KEY and LINQ_PHONE_NUMBER from the sandbox dashboard
npm install
```

## Run end-to-end

```bash
npm start
```

This will:

1. Open a public [localtunnel](https://localtunnel.github.io/www/) URL to your local webhook server
2. `POST /api/partner/v3/webhook-subscriptions` for `message.received`
3. Print your Linq number — **text it from your iPhone first**
4. Auto-reply with `Hello from my agent!`, then a follow-up (may include a link)

## Manual send (after inbound)

Uses `POST /api/partner/v3/chats`:

```bash
npm run send -- +1YOURPHONE "Hello from my agent!"
```

Follow-up with a link once you have a chat id:

```bash
npm run send -- +1YOURPHONE "https://docs.linqapp.com" --follow-up <chat_id>
```

## Scripts

| Script | What it does |
|--------|----------------|
| `npm start` | Tunnel + webhook subscribe + server |
| `npm run server` | Webhook server only |
| `npm run subscribe` | Create webhook subscription for `PUBLIC_WEBHOOK_URL` |
| `npm run send` | Send via `POST /v3/chats` or follow-up message |

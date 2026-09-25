# bot-x

Local prototype: mention a private Slack bot and receive Claude API replies in-thread.

## Setup

1. Enable Socket Mode in the Slack app. Create an app token with `connections:write`.
2. Add bot scopes `app_mentions:read` and `chat:write`, subscribe to `app_mention`, install the app, and invite it to a channel.
3. Run `cp .env.example .env` and fill in the values locally. Never commit tokens. The workspace ID is the `T…` portion of your Slack web URL.
4. Set `ECHO_MODE=true` to try Slack without an AI key. Run `npm start` and mention the bot.
5. For Claude replies, set `ECHO_MODE=false`, an Anthropic API key, and a model ID available to your API account. Restart the service.

Claude API usage is billed separately from a Max subscription. Configure billing limits in your Anthropic Console before enabling Claude mode.

## Behavior and limits

- Mention the bot again for each follow-up. Only bot-directed messages and its replies enter context.
- All members who can mention the bot in the configured workspace can query it.
- Thread history stays in memory: six exchanges, one-hour expiry, maximum 200 threads. Restarting clears history and retry deduplication.
- At most four pending requests; requests within a thread run sequentially.
- Input is capped at 12,000 characters and output at 1,200 tokens per request. There is no application-level daily spending cap or per-user quota yet.
- No tools, attachments, channel-history retrieval, or persistent storage. The Mac must stay awake and the process must stay running.
- Shared thread context includes questions from other members in that thread.

## Manual verification

Run `npm run check` to type-check. In echo mode, verify a mention gets one threaded reply and a follow-up stays in that thread. Enable Claude mode and check context recall, separate threads, and queries from a second member. Restart to verify that history resets.

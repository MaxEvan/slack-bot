# bot-x

Local prototype: mention a private Slack bot and receive Claude replies in-thread.

## Setup

1. Enable Socket Mode in the Slack app. Create an app token with `connections:write`.
2. Add bot scopes `app_mentions:read` and `chat:write`, subscribe to `app_mention`, install the app, and invite it to a channel.
3. Run `cp .env.example .env` and fill in the values locally. Never commit tokens. The workspace ID is the `T…` portion of your Slack web URL.
4. Set `ECHO_MODE=true` to try Slack without an AI key. Run `npm start` and mention the bot.
5. For Claude replies, set `ECHO_MODE=false`, an Anthropic API key, and a model ID available to your API account. Restart the service.

Claude API usage is billed separately from a Max subscription. Configure billing limits in your Anthropic Console before enabling Claude mode.

## Behavior and limits

- Mention the bot once to start or join a thread. Subsequent human replies in that active thread automatically receive answers, including image attachments. Unrelated threads, top-level messages without mentions, edits, and bot messages are ignored.
- All members who can mention the bot in the configured workspace can query it.
- Thread history stays in memory: six exchanges, one-hour expiry, maximum 200 threads. Restarting clears history, active-thread tracking, and retry deduplication. Mention the bot again after a restart or if the thread expires or is evicted.
- At most four pending requests; requests within a thread run sequentially.
- Input is capped at 12,000 characters and output at 1,200 tokens per request. There is no application-level daily spending cap or per-user quota yet.
- No tools, non-image attachments, channel-history retrieval, or persistent storage. The Mac must stay awake and the process must stay running.
- Shared thread context includes questions from other members in that thread.

## Manual verification

Run `npm run check` to type-check. In echo mode, verify a mention gets one threaded reply and a follow-up without a mention stays in that thread. Check that another mention produces only one reply, unrelated threads stay silent, and bot replies do not cause loops. Enable Claude mode and check context recall, separate threads, and queries from a second member. Restart to verify that history resets.

For automatic thread replies, add `channels:history` and subscribe to `message.channels` for public channels; add `groups:history` and subscribe to `message.groups` for private channels. Keep `app_mention`, save changes, and reinstall the Slack app.

## Claude Code OAuth backend

Requires the installed Claude Code CLI with `--safe-mode` support (verified with 2.1.236). Set `CLAUDE_BACKEND=code`, `CLAUDE_CODE_OAUTH_TOKEN` to your subscription token, `ANTHROPIC_MODEL=sonnet`, and `ECHO_MODE=false`. Obtain the token through Claude Code's `claude setup-token` flow. Keep it only in the ignored `.env` file.

This backend invokes the unmodified Claude Code CLI, with tools, MCP servers, customizations, and session persistence disabled. Each request runs in a temporary directory, receives only the current thread's bounded history, and has a two-minute timeout. Slack credentials are not passed to the CLI. Answers are capped at 12,000 characters; the API backend's 1,200-token generation cap does not apply to CLI mode.

Technical authentication support does not change Anthropic's credential rules: routing other users' requests through one person's Max credentials is restricted. Use the API backend for the shared organization deployment. Subscription usage and limits apply to the CLI path under the provider's current billing rules.

## Images

Add the bot scope `files:read` and reinstall the Slack app. Upload images with the initial bot mention or in a follow-up in an active thread. PNG, JPEG, GIF, and WebP are supported: up to three images totaling 5 MB per message. PDFs, external links, and images outside active threads without a mention are not retrieved.

The bot downloads images from Slack with the bot token and passes native image content to Claude through either backend. Tools remain disabled. Downloads have timeouts, byte limits, and image signature checks. Image data stays in memory with the thread history; older exchanges are dropped above an 8 MB request budget, and stored conversation data is capped at approximately 64 MB globally. Reattach an image if it has fallen out of context.

To check manually, mention the bot with an image and ask what it shows, then mention it again in the thread with a follow-up. Unsupported or oversized attachments should receive an explanatory reply.

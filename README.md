# bot-x

A Slack bot that answers with Claude in threads and understands image attachments.

## Slack setup

1. [Create a Slack app](https://api.slack.com/apps) and enable **Socket Mode**.
2. Generate an app-level token with `connections:write`.
3. Add bot scopes: `app_mentions:read`, `chat:write`, `files:read`, `channels:history`.
4. Enable Event Subscriptions and add bot events: `app_mention`, `message.channels`.
5. For private channels, also add scope `groups:history` and event `message.groups`.
6. Install/reinstall the app and invite the bot to your channel.

## Run locally

Requires Node.js 22+.

```sh
git clone https://github.com/MaxEvan/slack-bot.git
cd slack-bot
npm ci
cp .env.example .env
```

Fill in `.env`; [.env.example](.env.example) explains every setting. Choose a backend:

- **API:** `CLAUDE_BACKEND=api`, with an Anthropic API key and model ID.
- **Claude Code:** install the Claude Code CLI with `--safe-mode` support, run `claude setup-token`, and set `CLAUDE_BACKEND=code` plus `CLAUDE_CODE_OAUTH_TOKEN`.

```sh
npm start
```

Mention `@bot-x` to start a conversation, then reply in the thread without mentioning it again. Attach images directly to your message (up to 3, totaling 5 MB).

Keep the process running and your computer awake. History resets on restart or after one hour of inactivity; mention the bot again to resume. For a Slack-only check, set `ECHO_MODE=true` and restart.

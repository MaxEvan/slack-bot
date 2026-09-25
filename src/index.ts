import 'dotenv/config';
import { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env before starting.`);
  return value;
}

const echoMode = process.env.ECHO_MODE === 'true';
const teamId = required('SLACK_TEAM_ID');
const model = echoMode ? '' : required('ANTHROPIC_MODEL');
const claude = echoMode ? null : new Anthropic({
  apiKey: required('ANTHROPIC_API_KEY'), timeout: 60_000, maxRetries: 1,
});
const app = new App({
  token: required('SLACK_BOT_TOKEN'),
  appToken: required('SLACK_APP_TOKEN'),
  socketMode: true,
});

// Prototype state expires after one hour and resets when the service restarts.
const sessions = new Map<string, { messages: MessageParam[]; updated: number }>();
const seen = new Map<string, number>();
const queues = new Map<string, Promise<void>>();
let pending = 0;
const hour = 60 * 60 * 1000;
const cleanup = setInterval(() => {
  const cutoff = Date.now() - hour;
  for (const [key, value] of sessions) if (value.updated < cutoff) sessions.delete(key);
  for (const [key, timestamp] of seen) if (timestamp < cutoff) seen.delete(key);
}, 60_000);
cleanup.unref();

app.event('app_mention', async ({ event, body, client, context }) => {
  if (body.team_id !== teamId || event.bot_id || event.user === context.botUserId) return;
  if (seen.has(body.event_id)) return;
  seen.set(body.event_id, Date.now());
  const thread = event.thread_ts ?? event.ts;
  const key = `${teamId}:${event.channel}:${thread}`;
  const prompt = event.text.replaceAll(`<@${context.botUserId}>`, '').trim();
  const reply = async (text: string) => {
    for (let start = 0; start < text.length; start += 3000) {
      await client.chat.postMessage({
        channel: event.channel, thread_ts: thread,
        text: text.slice(start, start + 3000),
        mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
      });
    }
  };
  if (!prompt) { await reply('Mention me with a question.'); return; }
  if (prompt.length > 12_000) { await reply('Please shorten your question to 12,000 characters.'); return; }
  if (pending >= 4) { await reply('I’m busy. Please try again shortly.'); return; }
  pending++;

  const previous = queues.get(key) ?? Promise.resolve();
  const task = previous.then(async () => {
    if (echoMode) { await reply(`Slack connection works. You asked: ${prompt}`); return; }
    const session = sessions.get(key);
    const history = session && Date.now() - session.updated < hour ? session.messages : [];
    const messages: MessageParam[] = [...history, { role: 'user', content: `<@${event.user}>: ${prompt}` }];
    let answer: string;
    try {
      const result = await claude!.messages.create({
        model, max_tokens: 1200,
        system: 'You are bot-x, a helpful assistant in a shared Slack thread. Answer concisely in plain text. User ID prefixes identify speakers. You only see messages addressed to you and your own replies. You have no tools or access to other Slack messages.',
        messages,
      });
      answer = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') || 'No text response was returned.';
      console.info('Claude request completed', { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens });
    } catch {
      console.error('Claude request failed; credentials and message content omitted.');
      await reply('I couldn’t get a response from Claude. Please try again shortly; if it persists, ask the bot owner to check API configuration and billing.');
      return;
    }
    await reply(answer);
    // Keep at most six exchanges per thread and at most 200 active threads.
    if (sessions.size >= 200 && !sessions.has(key)) sessions.delete(sessions.keys().next().value!);
    const completed: MessageParam[] = [...messages, { role: 'assistant', content: answer }];
    sessions.set(key, { messages: completed.slice(-12), updated: Date.now() });
  }).catch(() => {
    console.error('Slack reply failed; credentials and message content omitted.');
  }).finally(() => {
    pending--;
    if (queues.get(key) === task) queues.delete(key);
  });
  queues.set(key, task);
  await task;
});

app.error(async () => { console.error('Slack connection error; check app configuration.'); });

async function main() {
  const identity = await app.client.auth.test();
  if (identity.team_id !== teamId) throw new Error('SLACK_TEAM_ID does not match the bot token workspace.');
  await app.start();
  console.info(`bot-x running in ${echoMode ? 'echo' : 'Claude API'} mode.`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void app.stop().then(() => process.exit(0)); });
}

void main().catch(() => {
  console.error('Startup failed. Check Slack tokens, workspace ID, and Socket Mode settings.');
  process.exitCode = 1;
});

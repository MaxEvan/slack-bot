import 'dotenv/config';
import { App } from '@slack/bolt';
import Anthropic from '@anthropic-ai/sdk';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';
import { queryClaudeCode } from './claude-code';
import { loadImages } from './images';
import type { WebClient } from '@slack/web-api';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`Set ${name} in .env before starting.`);
  return value;
}

const echoMode = process.env.ECHO_MODE === 'true';
const teamId = required('SLACK_TEAM_ID');
const useClaudeCode = process.env.CLAUDE_BACKEND === 'code';
const model = echoMode ? '' : useClaudeCode ? process.env.ANTHROPIC_MODEL?.trim() || 'sonnet' : required('ANTHROPIC_MODEL');
if (!echoMode && useClaudeCode) required('CLAUDE_CODE_OAUTH_TOKEN');
const system = 'You are bot-x, a helpful assistant in a shared Slack thread. Answer concisely in plain text. User ID prefixes identify speakers. You see the initial mention, subsequent user messages in this active thread, attached images, and your own replies. You have no tools or access to other Slack messages.';
const claude = echoMode || useClaudeCode ? null : new Anthropic({
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

type IncomingMessage = {
  channel: string; ts: string; thread_ts?: string; text?: string;
  user?: string; bot_id?: string; subtype?: string;
  files?: { id?: string }[];
};

async function handleMessage(event: IncomingMessage, workspace: string | undefined, botUserId: string | undefined, client: WebClient, mention: boolean) {
  if (workspace !== teamId || !event.user || event.bot_id || event.user === botUserId) return;
  // Ignore edits, deletions, bot posts, and channel bookkeeping events.
  if (event.subtype && !['file_share', 'thread_broadcast'].includes(event.subtype)) return;
  const thread = event.thread_ts ?? event.ts;
  const key = `${teamId}:${event.channel}:${thread}`;
  if (!mention) {
    // Mentions arrive through app_mention too; let that listener own them.
    if (event.text?.includes(`<@${botUserId}>`)) return;
    const session = sessions.get(key);
    const active = queues.has(key) || (session && Date.now() - session.updated < hour);
    if (!event.thread_ts || event.thread_ts === event.ts || !active) return;
  }
  // Slack can deliver one message through multiple events with different event IDs.
  const messageKey = `${teamId}:${event.channel}:${event.ts}`;
  if (seen.has(messageKey)) return;
  seen.set(messageKey, Date.now());
  const prompt = (event.text ?? '').replaceAll(`<@${botUserId}>`, '').trim();
  const files = event.files ?? [];
  let statusTs: string | undefined;
  const reply = async (text: string) => {
    for (let start = 0; start < text.length; start += 3000) {
      if (start === 0 && statusTs) {
        const placeholderTs = statusTs;
        try {
          await client.chat.update({
            channel: event.channel, ts: placeholderTs,
            text: text.slice(0, 3000), parse: 'none',
            blocks: [{ type: 'section', expand: true, text: { type: 'plain_text', text: text.slice(0, 3000) } }],
          });
          statusTs = undefined;
          continue;
        } catch {
          // If the placeholder can't be edited, still try to deliver the answer.
          await client.chat.delete({ channel: event.channel, ts: placeholderTs }).catch(() => {});
          statusTs = undefined;
        }
      }
      await client.chat.postMessage({
        channel: event.channel, thread_ts: thread,
        text: text.slice(start, start + 3000),
        blocks: [{ type: 'section', expand: true, text: { type: 'plain_text', text: text.slice(start, start + 3000) } }],
        mrkdwn: false, parse: 'none', unfurl_links: false, unfurl_media: false,
      });
    }
  };
  if (!prompt && !files.length) { await reply('Mention me with a question.'); return; }
  if (prompt.length > 12_000) { await reply('Please shorten your question to 12,000 characters.'); return; }
  if (pending >= 4) { await reply('I’m busy. Please try again shortly.'); return; }
  pending++;

  const queued = queues.has(key);
  const previous = queues.get(key) ?? Promise.resolve();
  // Start feedback immediately, but register the queue before awaiting Slack.
  const statusReady = client.chat.postMessage({
    channel: event.channel, thread_ts: thread,
    text: queued ? 'Queued — I’ll respond after the previous question.' : 'Thinking…',
    mrkdwn: false,
  }).then(result => { statusTs = result.ts; }).catch(() => {
    console.error('Could not post progress feedback; continuing the request.');
  });
  const task = previous.then(async () => {
    await statusReady;
    if (queued && statusTs) {
      await client.chat.update({ channel: event.channel, ts: statusTs, text: 'Thinking…', parse: 'none' }).catch(() => {});
    }
    if (echoMode) {
      await reply(`Slack connection works. You asked: ${prompt}`);
      if (sessions.size >= 200 && !sessions.has(key)) sessions.delete(sessions.keys().next().value!);
      sessions.set(key, { messages: [], updated: Date.now() });
      return;
    }
    const session = sessions.get(key);
    const history = session && Date.now() - session.updated < hour ? session.messages : [];
    let images;
    try { images = await loadImages(files, client, required('SLACK_BOT_TOKEN')); }
    catch (error) {
      const message = error instanceof Error && !error.message.includes('fetch') ? error.message : 'I couldn’t download the image. Please upload it again.';
      await reply(message);
      return;
    }
    const messages: MessageParam[] = [...history, { role: 'user', content: [
      { type: 'text', text: `<@${event.user}>: ${prompt || 'Describe the attached image.'}` }, ...images,
    ] }];
    // Leave headroom below the CLI's stdin limit when old turns contain images.
    while (messages.length > 1 && JSON.stringify(messages).length > 8 * 1024 * 1024) messages.splice(0, 2);
    let answer: string;
    try {
      if (useClaudeCode) {
        answer = await queryClaudeCode(messages, system, model);
        console.info('Claude Code request completed.');
      } else {
      const result = await claude!.messages.create({
        model, max_tokens: 1200,
        system,
        messages,
      });
      answer = result.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') || 'No text response was returned.';
      console.info('Claude request completed', { inputTokens: result.usage.input_tokens, outputTokens: result.usage.output_tokens });
      }
    } catch {
      console.error('Claude request failed; credentials and message content omitted.');
      await reply('I couldn’t get a response from Claude. Please try again shortly; if it persists, ask the bot owner to check authentication and usage limits.');
      return;
    }
    await reply(answer);
    // Keep at most six exchanges per thread and at most 200 active threads.
    if (sessions.size >= 200 && !sessions.has(key)) sessions.delete(sessions.keys().next().value!);
    const completed: MessageParam[] = [...messages, { role: 'assistant', content: answer }];
    sessions.set(key, { messages: completed.slice(-12), updated: Date.now() });
    // Bound retained base64 image data across all conversations to about 64 MB.
    let retained = [...sessions.values()].reduce((sum, session) => sum + JSON.stringify(session.messages).length, 0);
    for (const [oldKey, oldSession] of sessions) {
      if (retained <= 64 * 1024 * 1024) break;
      retained -= JSON.stringify(oldSession.messages).length;
      sessions.delete(oldKey);
    }
  }).catch(async () => {
    console.error('Slack reply failed; credentials and message content omitted.');
    if (statusTs) await reply('Something went wrong. Please try again.').catch(() => {});
  }).finally(() => {
    pending--;
    if (queues.get(key) === task) queues.delete(key);
  });
  queues.set(key, task);
  await task;
}

app.event('app_mention', async ({ event, body, client, context }) => {
  await handleMessage(event, body.team_id, context.botUserId, client, true);
});

app.event('message', async ({ event, body, client, context }) => {
  if (!('user' in event)) return;
  await handleMessage(event, body.team_id, context.botUserId, client, false);
});

app.error(async () => { console.error('Slack connection error; check app configuration.'); });

async function main() {
  const identity = await app.client.auth.test();
  if (identity.team_id !== teamId) throw new Error('SLACK_TEAM_ID does not match the bot token workspace.');
  await app.start();
  console.info(`bot-x running in ${echoMode ? 'echo' : useClaudeCode ? 'Claude Code' : 'Claude API'} mode.`);
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => { void app.stop().then(() => process.exit(0)); });
}

void main().catch(() => {
  console.error('Startup failed. Check Slack tokens, workspace ID, and Socket Mode settings.');
  process.exitCode = 1;
});

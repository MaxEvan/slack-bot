import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageParam, ContentBlockParam } from '@anthropic-ai/sdk/resources/messages';

export async function queryClaudeCode(messages: MessageParam[], system: string, model: string): Promise<string> {
  const content: ContentBlockParam[] = [];
  for (const message of messages) {
    content.push({ type: 'text', text: `Conversation turn (${message.role}):` });
    if (typeof message.content === 'string') content.push({ type: 'text', text: message.content });
    else content.push(...message.content);
  }
  content.push({ type: 'text', text: 'Respond to the final user turn in the conversation above.' });
  const cwd = await mkdtemp(join(tmpdir(), 'bot-x-'));
  try {
    return await new Promise<string>((resolve, reject) => {
      // Pass only runtime essentials and the intended credential, never Slack tokens.
      const env: NodeJS.ProcessEnv = {};
      for (const key of ['PATH', 'HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
        if (process.env[key]) env[key] = process.env[key];
      }
      env.CLAUDE_CODE_OAUTH_TOKEN = process.env.CLAUDE_CODE_OAUTH_TOKEN;
      const child = spawn('claude', [
        '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--model', model,
        '--safe-mode', '--tools', '', '--disable-slash-commands',
        '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
        '--no-session-persistence', '--system-prompt', system,
      ], { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] });
      let output = '';
      let exceeded = false;
      const timer = setTimeout(() => { exceeded = true; child.kill('SIGKILL'); }, 120_000);
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.length > 1_000_000) { exceeded = true; child.kill('SIGKILL'); }
      });
      child.stderr.resume();
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('Claude Code could not start.')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0 || exceeded) { reject(new Error('Claude Code failed or timed out.')); return; }
        try {
          const result = output.trim().split('\n').reverse().map(line => JSON.parse(line)).find(item => item.type === 'result');
          if (!result || result.is_error || typeof result.result !== 'string' || !result.result.trim()) throw new Error();
          resolve(result.result.slice(0, 12_000));
        } catch { reject(new Error('Claude Code returned no successful text result.')); }
      });
      child.stdin.end(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n');
    });
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

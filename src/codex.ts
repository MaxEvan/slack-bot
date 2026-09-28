import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MessageParam } from '@anthropic-ai/sdk/resources/messages';

export async function queryCodex(messages: MessageParam[], system: string, model?: string): Promise<string> {
  const cwd = await mkdtemp(join(tmpdir(), 'bot-x-codex-'));
  try {
    const images: string[] = [];
    const transcript: { role: string; content: string }[] = [];
    for (const message of messages) {
      const parts: string[] = [];
      if (typeof message.content === 'string') parts.push(message.content);
      else for (const block of message.content) {
        if (block.type === 'text') parts.push(block.text);
        if (block.type === 'image' && block.source.type === 'base64') {
          const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }[block.source.media_type];
          const file = join(cwd, `image-${images.length + 1}.${extension}`);
          await writeFile(file, Buffer.from(block.source.data, 'base64'), { mode: 0o600 });
          images.push(file);
          parts.push(`[Attached image ${images.length}]`);
        }
      }
      transcript.push({ role: message.role, content: parts.join('\n') });
    }

    const outputFile = join(cwd, 'answer.txt');
    const args = [
      'exec', '--ignore-user-config', '--ignore-rules', '--ephemeral',
      '--skip-git-repo-check', '--sandbox', 'read-only', '--color', 'never',
      '--output-last-message', outputFile,
      '-c', 'approval_policy="never"', '-c', 'forced_login_method="chatgpt"',
      '-c', 'web_search="disabled"', '-c', 'project_doc_max_bytes=0',
      '-c', `developer_instructions=${JSON.stringify(system + ' Answer only the final user turn in the supplied conversation. Images are numbered in attachment order. Do not use tools.')}`,
    ];
    // Keep Slack prompts away from local execution, integrations, and customizations.
    for (const feature of ['shell_tool', 'unified_exec', 'shell_snapshot', 'apps', 'plugins', 'remote_plugin', 'hooks', 'multi_agent', 'computer_use', 'browser_use', 'in_app_browser', 'image_generation', 'skill_search', 'memories']) {
      args.push('--disable', feature);
    }
    args.push('--enable', 'skip_host_skill_discovery');
    if (model) args.push('--model', model);
    for (const file of images) args.push('--image', file);
    args.push('-');

    // Reuse local Codex authentication without passing Slack/Anthropic/API credentials.
    const env: NodeJS.ProcessEnv = {};
    for (const key of ['PATH', 'HOME', 'CODEX_HOME', 'TMPDIR', 'LANG', 'SSL_CERT_FILE', 'NODE_EXTRA_CA_CERTS']) {
      if (process.env[key]) env[key] = process.env[key];
    }
    await new Promise<void>((resolve, reject) => {
      const child = spawn('codex', args, { cwd, env, stdio: ['pipe', 'ignore', 'pipe'] });
      let timedOut = false;
      let diagnostic = '';
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, 120_000);
      child.stderr.on('data', chunk => { diagnostic = (diagnostic + chunk.toString()).slice(-16_000); });
      child.stdin.on('error', () => {});
      child.on('error', () => { clearTimeout(timer); reject(new Error('Codex could not start. Install Codex CLI and run codex login.')); });
      child.on('close', code => {
        clearTimeout(timer);
        if (timedOut) { reject(new Error('Codex timed out after two minutes. Try a shorter request.')); return; }
        if (code !== 0) {
          // Classify locally; never expose raw stderr, prompts, or credentials.
          const reason = /usage limit|rate.limit|quota|429/i.test(diagnostic)
            ? 'Codex usage limit reached. Check your plan limits and try again later.'
            : /unauthorized|401|not logged|authentication|refresh.token/i.test(diagnostic)
              ? 'Codex login needs attention. Run codex login on the bot host, then restart the bot.'
              : 'Codex request failed. Check codex login status, model availability, and CLI version.';
          reject(new Error(reason));
          return;
        }
        resolve();
      });
      child.stdin.end(JSON.stringify(transcript));
    });
    const answer = (await readFile(outputFile, 'utf8')).trim();
    if (!answer) throw new Error('Codex returned an empty answer. Please try again.');
    return answer.slice(0, 12_000);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

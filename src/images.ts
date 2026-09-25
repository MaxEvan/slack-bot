import type { WebClient } from '@slack/web-api';
import type { ImageBlockParam } from '@anthropic-ai/sdk/resources/messages';

const maxBytes = 5 * 1024 * 1024;
const types = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);

export async function loadImages(files: { id?: string }[], client: WebClient, token: string): Promise<ImageBlockParam[]> {
  if (files.length > 3) throw new Error('Attach at most three images per message.');
  const images: ImageBlockParam[] = [];
  let total = 0;
  for (const reference of files) {
    if (!reference.id) throw new Error('This attachment has no Slack file ID. Please upload it again.');
    let file;
    try { file = (await client.files.info({ file: reference.id })).file; }
    catch { throw new Error('I couldn’t access the attachment. Add files:read and reinstall the Slack app, then upload it again.'); }
    if (!file?.mimetype || !types.has(file.mimetype)) throw new Error('Please attach a PNG, JPEG, GIF, or WebP image. Other file types aren’t supported yet.');
    if ((file.size ?? 0) > maxBytes) throw new Error('Please use images totaling no more than 5 MB per message.');
    const url = new URL(file.url_private_download ?? file.url_private ?? 'https://invalid');
    if (url.protocol !== 'https:' || url.hostname !== 'files.slack.com' || url.port || url.username || url.password) throw new Error('Only images uploaded directly to Slack are supported.');
    // Never forward the bot token across a redirect or to an arbitrary host.
    const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(20_000) });
    if (!response.ok || !response.body) throw new Error('Slack couldn’t download this image. Please upload it again.');
    const chunks: Uint8Array[] = [];
    for await (const chunk of response.body) {
      total += chunk.length;
      if (total > maxBytes) throw new Error('Please use images totaling no more than 5 MB per message.');
      chunks.push(chunk);
    }
    const data = Buffer.concat(chunks);
    const valid = file.mimetype === 'image/png' ? data.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
      : file.mimetype === 'image/jpeg' ? data[0] === 255 && data[1] === 216 && data[2] === 255
      : file.mimetype === 'image/gif' ? /^GIF8[79]a$/.test(data.subarray(0, 6).toString())
      : data.subarray(0, 4).toString() === 'RIFF' && data.subarray(8, 12).toString() === 'WEBP';
    if (!valid) throw new Error('The attachment did not download as a valid image. Please upload it again.');
    images.push({ type: 'image', source: { type: 'base64', media_type: file.mimetype as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp', data: data.toString('base64') } });
  }
  return images;
}

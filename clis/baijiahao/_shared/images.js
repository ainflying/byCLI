import { readFile } from 'node:fs/promises';
import { CommandExecutionError } from '@sovovs/bycli/errors';

// Proxy URLs are rewritten on draft save. Compare complete static image pixels,
// never just /bjh/picproxy's shared pathname or a few characters of its token.
export async function imageDigestsDOM(urls) {
  const hex = bytes => [...new Uint8Array(bytes)].map(n => n.toString(16).padStart(2, '0')).join('');
  const rows = [];
  for (const value of urls) {
    const url = new URL(value);
    if (url.username || url.password || url.port) throw new Error('Unsupported image authority');
    if (!(url.protocol === 'data:' && /^data:image\/(png|jpeg|webp|gif);base64,/.test(value))
      && !(url.protocol === 'https:' && (url.hostname === 'baijiahao.baidu.com' && url.pathname === '/bjh/picproxy' || /(?:^|\.)bdstatic\.com$/.test(url.hostname)))) throw new Error('Unsupported image reference');
    const response = await fetch(value, { credentials: url.origin === location.origin ? 'include' : 'omit' });
    if (!response.ok) throw new Error('Image identity read failed');
    const blob = await response.blob(), bytes = new Uint8Array(await blob.arrayBuffer());
    // GIF/animated WebP/APNG need byte identity; a first-frame hash is insufficient.
    const staticImage = /^image\/jpeg(?:;|$)/.test(blob.type) || /^image\/png(?:;|$)/.test(blob.type) && !new TextDecoder('latin1').decode(bytes).includes('acTL');
    if (!staticImage) { rows.push({ method: 'file-sha256', hash: hex(await crypto.subtle.digest('SHA-256', bytes)) }); continue; }
    const image = await createImageBitmap(blob);
    try {
      const canvas = new OffscreenCanvas(image.width, image.height), context = canvas.getContext('2d');
      context.drawImage(image, 0, 0);
      const pixels = context.getImageData(0, 0, image.width, image.height).data;
      rows.push({ method: 'rgba-sha256', width: image.width, height: image.height, hash: hex(await crypto.subtle.digest('SHA-256', pixels)) });
    } finally { image.close(); }
  }
  return rows;
}
export async function imageDigests(page, urls) {
  try { return await page.evaluate(`(${imageDigestsDOM.toString()})(${JSON.stringify(urls)})`); }
  catch { throw new CommandExecutionError('Could not verify complete image identities; no image was substituted or accepted by filename'); }
}
export async function sourceImageDigests(page, images) {
  const urls = [];
  for (const image of images) {
    const ext = image.path.split('.').at(-1).toLowerCase(), type = ['jpg', 'jpeg'].includes(ext) ? 'jpeg' : ext;
    urls.push(`data:image/${type};base64,${(await readFile(image.path)).toString('base64')}`);
  }
  return imageDigests(page, urls);
}

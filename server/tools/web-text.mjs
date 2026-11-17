import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { request } from 'node:https';
import { AppError } from '../errors.mjs';
import { htmlToText } from './documents.mjs';

export function isPublicAddress(address) {
  const version = isIP(address);
  if (version === 4) {
    const [a,b,c] = address.split('.').map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18,19,51].includes(b)) || (a === 192 && b === 0) || (a === 203 && b === 0 && c === 113));
  }
  if (version === 6) {
    const value = new URL(`https://[${address}]/`).hostname.slice(1,-1).toLowerCase();
    if (value.startsWith('::ffff:')) {
      const mapped = value.slice(7);
      if (isIP(mapped) === 4) return isPublicAddress(mapped);
      const parts = mapped.split(':');
      if (parts.length === 2) { const n = parseInt(parts[0],16) * 65536 + parseInt(parts[1],16); return isPublicAddress([n>>>24,(n>>>16)&255,(n>>>8)&255,n&255].join('.')); }
      return false;
    }
    return !(['::','::1'].includes(value) || /^(?:fc|fd|fe[89ab]|ff|2001:db8|2002:|64:ff9b:)/.test(value) || value.startsWith('::'));
  }
  return false;
}
export async function validatePublicURL(input, lookupImpl = lookup) {
  let url;
  try { url = new URL(input); } catch { throw new AppError(400, 'INVALID_WEBSITE_URL', 'Enter a complete public HTTPS website URL.'); }
  if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443') || /(?:^|\.)(?:localhost|local|internal)$/.test(url.hostname)) {
    throw new AppError(400, 'UNSUPPORTED_WEBSITE_URL', 'Website translation accepts public HTTPS pages without credentials or custom ports.');
  }
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  let addresses;
  try { addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookupImpl(hostname, { all: true, verbatim: true }); }
  catch { throw new AppError(422, 'WEBSITE_UNREACHABLE', 'The website hostname could not be resolved.'); }
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new AppError(403, 'PRIVATE_WEBSITE_BLOCKED', 'Private network addresses cannot be used for website translation.');
  return { url, address: addresses[0] };
}
export async function fetchPublicText(input, signal, { lookupImpl = lookup, requestImpl = request } = {}) {
  const combined = AbortSignal.any([AbortSignal.timeout(30000), ...(signal ? [signal] : [])]);
  let next = input;
  for (let redirects = 0; redirects <= 3; redirects++) {
    const { url, address } = await validatePublicURL(next, lookupImpl);
    const result = await new Promise((resolve, reject) => {
      const req = requestImpl(url, { signal: combined, headers: { 'User-Agent': 'LanguageTutorBot/1.0 (user-requested text translation)', Accept: 'text/html,text/plain', 'Accept-Encoding': 'identity' },
        // Pin the validated DNS answer; do not resolve again during connection.
        lookup: (_, options, callback) => callback(null, ...(options.all ? [[address]] : [address.address, address.family])),
      }, async response => {
        if ([301,302,303,307,308].includes(response.statusCode)) {
          const location = response.headers.location; response.resume();
          if (!location) reject(new AppError(422, 'WEBSITE_UNREADABLE', 'The website returned an invalid redirect.'));
          else { try { resolve({ redirect: new URL(location,url).href }); } catch { reject(new AppError(422,'WEBSITE_UNREADABLE','The website returned an invalid redirect.')); } }
          return;
        }
        if (response.statusCode !== 200 || !/^(text\/html|text\/plain)/i.test(response.headers['content-type'] || '') || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          response.resume(); reject(new AppError(422, 'WEBSITE_UNREADABLE', 'This page is not readable public web text. Paste the content instead.')); return;
        }
        try {
          const chunks = []; let size = 0;
          for await (const chunk of response) { size += chunk.length; if (size > 2_000_000) throw new AppError(413, 'WEBSITE_TOO_LARGE', 'This web page is too large. Paste a shorter section.'); chunks.push(chunk); }
          const raw = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
          const text = response.headers['content-type'].startsWith('text/html') ? htmlToText(raw) : raw.trim();
          if (!text || text.length > 24000) throw new AppError(422, 'WEBSITE_UNREADABLE', 'The page has no readable text or exceeds 24,000 characters. Paste a section instead.');
          resolve({ text, source: 'public-web-text', sourceUrl: url.href });
        } catch (error) { reject(error instanceof AppError ? error : new AppError(422,'WEBSITE_UNREADABLE','This page does not contain readable UTF-8 text. Paste the content instead.')); }
      });
      req.setTimeout(15000, () => req.destroy(new Error('Website timeout')));
      req.on('error', () => reject(new AppError(combined.aborted ? 504 : 422, 'WEBSITE_UNREACHABLE', 'The website could not be reached. Paste the content instead.')));
      req.end();
    });
    if (!result.redirect) return result;
    next = result.redirect;
  }
  throw new AppError(422, 'TOO_MANY_REDIRECTS', 'The website redirects too many times. Paste the content instead.');
}

import { inflateRawSync } from 'node:zlib';
import { AppError } from '../errors.mjs';

export function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (full, entity) => {
    if (!entity.startsWith('#')) return { amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", nbsp:' ' }[entity.toLowerCase()] || full;
    const code = entity[1].toLowerCase() === 'x' ? parseInt(entity.slice(2), 16) : Number(entity.slice(1));
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : full;
  });
}
export function htmlToText(html) {
  return decodeEntities(html.replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '').replace(/<\/(?:p|div|h[1-6]|li|tr|section|article)>|<br\s*\/?>/gi, '\n')
    .replace(/<[^>]*>/g, '')).replace(/[ \t]+/g, ' ').replace(/\n\s*\n\s*\n/g, '\n\n').trim();
}
function docxText(bytes) {
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  if (end < 0) throw new AppError(400, 'INVALID_DOCUMENT', 'The DOCX archive is unreadable.');
  if (bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6)) throw new AppError(422, 'UNSUPPORTED_DOCUMENT', 'Split DOCX archives are unsupported.');
  const entries = bytes.readUInt16LE(end + 10); let offset = bytes.readUInt32LE(end + 16);
  if (entries > 10000) throw new AppError(413, 'DOCUMENT_TOO_LARGE', 'This DOCX archive contains too many entries.');
  for (let i = 0; i < entries; i++) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const flags = bytes.readUInt16LE(offset + 8); const method = bytes.readUInt16LE(offset + 10);
    const packed = bytes.readUInt32LE(offset + 20); const unpacked = bytes.readUInt32LE(offset + 24);
    const nameLength = bytes.readUInt16LE(offset + 28); const extraLength = bytes.readUInt16LE(offset + 30); const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (name === 'word/document.xml') {
      if (flags & 1 || ![0,8].includes(method)) throw new AppError(422, 'UNSUPPORTED_DOCUMENT', 'Encrypted DOCX files and this compression method are unsupported.');
      if (unpacked > 2_000_000 || packed > 2_000_000 || local + 30 > bytes.length || bytes.readUInt32LE(local) !== 0x04034b50) throw new AppError(413, 'DOCUMENT_TOO_LARGE', 'The DOCX content is too large or invalid.');
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      if (start + packed > bytes.length) throw new AppError(400, 'INVALID_DOCUMENT', 'The DOCX file is truncated.');
      let content;
      try { content = method === 8 ? inflateRawSync(bytes.subarray(start, start + packed), { maxOutputLength: 2_000_000 }) : bytes.subarray(start, start + packed); }
      catch { throw new AppError(400, 'INVALID_DOCUMENT', 'The DOCX content could not be decompressed.'); }
      const xml = content.toString('utf8');
      if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new AppError(422, 'UNSUPPORTED_DOCUMENT', 'DOCX content with custom XML entities is unsupported.');
      return decodeEntities(xml.replace(/<\/w:p>/g, '\n').replace(/<w:(?:tab|br)\b[^>]*\/?\s*>/g, ' ').replace(/<[^>]+>/g, '')).trim();
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  throw new AppError(400, 'INVALID_DOCUMENT', 'The DOCX file contains no readable document body.');
}
export function validateUpload(bytes, filename, imageOnly = false) {
  if (!Buffer.isBuffer(bytes) || !bytes.length || bytes.length > 8_000_000) throw new AppError(413, 'UPLOAD_TOO_LARGE', 'Upload a file up to 8 MB.');
  const extension = filename.toLowerCase().split('.').at(-1);
  if (['png','jpg','jpeg'].includes(extension)) {
    const png = bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
    if ((extension === 'png' && !png) || (extension !== 'png' && !jpeg)) throw new AppError(400, 'INVALID_IMAGE', 'The file does not match its PNG or JPEG format.');
    return { extension, mimeType: png ? 'image/png' : 'image/jpeg', needsOCR: true };
  }
  if (imageOnly) throw new AppError(415, 'UNSUPPORTED_IMAGE', 'Choose a PNG or JPEG image.');
  if (extension === 'pdf') {
    if (!bytes.toString('ascii', 0, 5).startsWith('%PDF-')) throw new AppError(400, 'INVALID_DOCUMENT', 'The PDF file header is invalid.');
    return { extension, mimeType: 'application/pdf', needsOCR: true };
  }
  if (extension === 'docx') {
    if (bytes.length < 22 || bytes.readUInt32LE(0) !== 0x04034b50) throw new AppError(400, 'INVALID_DOCUMENT', 'The DOCX archive is invalid.');
    return { extension, needsOCR: false };
  }
  if (['txt','md','csv','html','htm'].includes(extension)) return { extension, needsOCR: false };
  throw new AppError(415, 'UNSUPPORTED_DOCUMENT', 'Supported files: PDF, DOCX, TXT, Markdown, CSV, HTML, PNG, and JPEG.');
}
export function extractLocalDocument(bytes, format) {
  let text;
  if (format.extension === 'docx') text = docxText(bytes);
  else {
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new AppError(400, 'INVALID_DOCUMENT_ENCODING', 'Save this text document using UTF-8 encoding.'); }
    if (text.includes('\0')) throw new AppError(400, 'INVALID_DOCUMENT', 'The file is not a plain-text document.');
    if (['html','htm'].includes(format.extension)) text = htmlToText(text);
  }
  if (!text.trim()) throw new AppError(422, 'NO_TEXT_FOUND', 'No readable text was found in this file.');
  if (text.length > 24000) throw new AppError(413, 'DOCUMENT_TOO_LONG', 'This document exceeds 24,000 characters. Upload a shorter document.');
  return { text: text.trim(), source: 'local-document-parser' };
}
export function splitDocument(text, limit = 3000) {
  const chunks = []; let rest = text;
  while (rest.length > limit) {
    let split = rest.lastIndexOf('\n', limit); if (split < limit / 2) split = rest.lastIndexOf(' ', limit);
    if (split < limit / 2) split = limit;
    chunks.push(rest.slice(0, split)); rest = rest.slice(split);
  }
  if (rest) chunks.push(rest);
  if (chunks.length > 10) throw new AppError(413, 'DOCUMENT_TOO_LONG', 'This document requires too many translation sections.');
  return chunks;
}

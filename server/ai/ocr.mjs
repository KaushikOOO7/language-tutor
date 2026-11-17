import { AppError } from '../errors.mjs';

export class OCRService {
  constructor(settings = {}, fetchImpl = fetch, sleep = ms => new Promise(resolve => setTimeout(resolve, ms))) { this.settings = settings; this.fetch = fetchImpl; this.sleep = sleep; }
  status() {
    const configured = this.settings.provider === 'azure-document-intelligence' && Boolean(this.settings.apiKey && this.settings.baseUrl);
    return { configured, provider: this.settings.provider || 'disabled', formats: ['pdf','png','jpeg'], reason: configured ? null : 'Configure Azure Document Intelligence to extract text from images and PDFs.' };
  }
  async extract({ bytes, mimeType, signal }) {
    if (!this.status().configured) throw new AppError(503, 'OCR_NOT_CONFIGURED', this.status().reason);
    const combined = AbortSignal.any([AbortSignal.timeout(90000), ...(signal ? [signal] : [])]);
    try {
      const initial = await this.fetch(`${this.settings.baseUrl}/documentintelligence/documentModels/prebuilt-read:analyze?api-version=2024-11-30`, {
        method: 'POST', signal: combined, headers: { 'Ocp-Apim-Subscription-Key': this.settings.apiKey, 'Content-Type': mimeType }, body: bytes,
      });
      if (initial.status !== 202) throw new AppError(502, 'OCR_PROVIDER_ERROR', 'OCR could not accept this file. Check the resource credentials, file format, and whether the PDF is encrypted.');
      const operation = initial.headers.get('operation-location');
      if (!operation || new URL(operation).origin !== new URL(this.settings.baseUrl).origin) throw new AppError(502, 'INVALID_OCR_OUTPUT', 'OCR returned an invalid processing location.');
      for (let attempt = 0; attempt < 45; attempt++) {
        combined.throwIfAborted();
        const response = await this.fetch(operation, { signal: combined, headers: { 'Ocp-Apim-Subscription-Key': this.settings.apiKey } });
        if (!response.ok) throw new AppError(502, 'OCR_PROVIDER_ERROR', 'OCR could not retrieve the extracted text.');
        const raw = await response.text(); if (raw.length > 4_000_000) throw new AppError(413, 'DOCUMENT_TOO_LONG', 'This document is too large to extract in one request.');
        const result = JSON.parse(raw);
        if (result.status === 'succeeded') {
          const text = result.analyzeResult?.content;
          if (typeof text !== 'string' || !text.trim()) throw new AppError(422, 'NO_TEXT_FOUND', 'No readable text was found. Use a clearer image or a text-based document.');
          if (text.length > 24000) throw new AppError(413, 'DOCUMENT_TOO_LONG', 'Extracted text exceeds 24,000 characters. Upload a shorter document.');
          return { text, pages: result.analyzeResult.pages?.length || 1, source: 'azure-document-intelligence' };
        }
        if (result.status === 'failed') throw new AppError(422, 'OCR_EXTRACTION_FAILED', 'The text could not be extracted. Try a clearer image or an unencrypted document.');
        if (!['running','notStarted'].includes(result.status)) throw new AppError(502, 'INVALID_OCR_OUTPUT', 'OCR returned an unknown processing status.');
        await this.sleep(1500);
      }
      throw new AppError(504, 'OCR_TIMEOUT', 'OCR is taking too long. Try a smaller document.');
    } catch (error) {
      if (combined.aborted) throw new AppError(504, 'OCR_TIMEOUT', 'The OCR request was interrupted or timed out.');
      if (error instanceof AppError) throw error;
      throw new AppError(502, 'OCR_UNREACHABLE', 'The OCR service could not be reached or returned invalid data.');
    }
  }
}

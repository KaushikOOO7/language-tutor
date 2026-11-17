import test from 'node:test';
import assert from 'node:assert/strict';
import { deflateRawSync } from 'node:zlib';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { validateUpload,extractLocalDocument,splitDocument,htmlToText } from '../server/tools/documents.mjs';
import { OCRService } from '../server/ai/ocr.mjs';
import { TranslationService } from '../server/ai/translation.mjs';
import { isPublicAddress,validatePublicURL,fetchPublicText } from '../server/tools/web-text.mjs';
import { setup } from './fixtures.mjs';
import { toolInput } from '../server/tools/input.mjs';

function docx(xml) {
  const name = Buffer.from('word/document.xml');const content = Buffer.from(xml);const packed = deflateRawSync(content);
  const local = Buffer.alloc(30);local.writeUInt32LE(0x04034b50,0);local.writeUInt16LE(8,8);local.writeUInt32LE(packed.length,18);local.writeUInt32LE(content.length,22);local.writeUInt16LE(name.length,26);
  const central = Buffer.alloc(46);central.writeUInt32LE(0x02014b50,0);central.writeUInt16LE(8,10);central.writeUInt32LE(packed.length,20);central.writeUInt32LE(content.length,24);central.writeUInt16LE(name.length,28);
  const end = Buffer.alloc(22);end.writeUInt32LE(0x06054b50,0);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+name.length,12);end.writeUInt32LE(local.length+name.length+packed.length,16);
  return Buffer.concat([local,name,packed,central,name,end]);
}
for (const [filename,text,expected] of [['sample.txt','ಕನ್ನಡ language','ಕನ್ನಡ language'],['sample.md','# A heading\nText','# A heading\nText'],['sample.csv','a,b\n1,2','a,b\n1,2'],['sample.html','<h1>Hello</h1><script>steal()</script><p>World &amp; friends</p>','Hello\nWorld & friends']]) {
  test(`${filename} extracts actual UTF-8 content`,() => {const bytes = Buffer.from(text);assert.equal(extractLocalDocument(bytes,validateUpload(bytes,filename)).text,expected);});
}
test('DOCX extraction reads compressed document XML and preserves paragraphs without writing files',() => {
  const bytes = docx('<w:document><w:p><w:r><w:t>Hello &amp; ಸ್ವಾಗತ</w:t></w:r></w:p><w:p><w:r><w:t>Next paragraph</w:t></w:r></w:p></w:document>');
  assert.equal(extractLocalDocument(bytes,validateUpload(bytes,'sample.docx')).text,'Hello & ಸ್ವಾಗತ\nNext paragraph');
  const entities = docx('<!DOCTYPE x [<!ENTITY stolen SYSTEM "file:///secret">]><w:t>unsafe</w:t>');
  assert.throws(() => extractLocalDocument(entities,validateUpload(entities,'sample.docx')),{code:'UNSUPPORTED_DOCUMENT'});
});
test('file validation distinguishes PDFs, images, unsupported files and binary text',() => {
  assert.equal(validateUpload(Buffer.from('%PDF-1.7\n'),'sample.pdf').needsOCR,true);
  assert.equal(validateUpload(Buffer.from([255,216,255,224]),'sample.jpeg').mimeType,'image/jpeg');
  assert.throws(() => validateUpload(Buffer.from('not pdf'),'sample.pdf'),{code:'INVALID_DOCUMENT'});
  assert.throws(() => validateUpload(Buffer.from('binary'),'sample.exe'),{code:'UNSUPPORTED_DOCUMENT'});
  assert.throws(() => extractLocalDocument(Buffer.from([255,255]),{extension:'txt'}),{code:'INVALID_DOCUMENT_ENCODING'});
  assert.throws(() => extractLocalDocument(Buffer.from('a\0b'),{extension:'txt'}),{code:'INVALID_DOCUMENT'});
});
test('document splitting preserves every source character across sections',() => {
  const text = 'A sentence in a paragraph.\n'.repeat(240);
  const parts = splitDocument(text);assert.equal(parts.join(''),text);assert.ok(parts.every(part => part.length <= 3000));
  assert.equal(htmlToText('<style>evil()</style><p>&#x0c95;&#x0ca8;&#x0ccd;&#x0ca8;&#x0ca1;</p>'),'ಕನ್ನಡ');
});

test('OCR uses the actual extraction endpoint and waits for completion with no fabricated text',async () => {
  let polls = 0;
  const service = new OCRService({provider:'azure-document-intelligence',apiKey:'test-key',baseUrl:'https://ocr.example'},async (url,options) => {
    assert.equal(options.headers['Ocp-Apim-Subscription-Key'],'test-key');
    if (options.method === 'POST') {assert.match(url,/prebuilt-read:analyze/);assert.ok(Buffer.isBuffer(options.body));return new Response(null,{status:202,headers:{'operation-location':'https://ocr.example/operations/1'}});}
    polls++;return new Response(JSON.stringify(polls === 1 ? {status:'running'} : {status:'succeeded',analyzeResult:{content:'Text actually extracted from the fixture.',pages:[{}]}}));
  },async () => {});
  assert.equal((await service.extract({bytes:Buffer.from('%PDF-1.7'),mimeType:'application/pdf'})).text,'Text actually extracted from the fixture.');
  assert.equal(polls,2);
});
test('OCR refuses unsafe processing locations, empty output and missing credentials',async () => {
  const settings = {provider:'azure-document-intelligence',apiKey:'test',baseUrl:'https://ocr.example'};
  const unsafe = new OCRService(settings,async () => new Response(null,{status:202,headers:{'operation-location':'https://private.example/steal'}}));
  await assert.rejects(unsafe.extract({bytes:Buffer.from('image'),mimeType:'image/png'}),{code:'INVALID_OCR_OUTPUT'});
  const empty = new OCRService(settings,async (_,options) => options.method === 'POST' ? new Response(null,{status:202,headers:{'operation-location':'https://ocr.example/operations/1'}}) : new Response(JSON.stringify({status:'succeeded',analyzeResult:{content:''}})));
  await assert.rejects(empty.extract({bytes:Buffer.from('image'),mimeType:'image/png'}),{code:'NO_TEXT_FOUND'});
  await assert.rejects(new OCRService().extract({}),{code:'OCR_NOT_CONFIGURED'});
});
test('Azure translation checks real language capabilities, translates, detects and transliterates',async () => {
  const service = new TranslationService({provider:'azure',apiKey:'test',region:'centralindia',baseUrl:'https://translation.example'},async (url,options) => {
    if (url.includes('/languages?')) return new Response(JSON.stringify({translation:{kn:{},en:{}},transliteration:{}}));
    assert.equal(options.headers['Ocp-Apim-Subscription-Key'],'test');
    if (url.includes('/translate?')) {assert.match(url,/from=kn/);return new Response(JSON.stringify([{translations:[{text:'Hello'}]}]));}
    if (url.includes('/detect?')) return new Response(JSON.stringify([{language:'kn',score:0.99}]));
    return new Response(JSON.stringify([{text:'namaskara',script:'Latn'}]));
  });
  assert.equal((await service.translate({text:'ನಮಸ್ಕಾರ',sourceLanguage:'Kannada',targetLanguage:'English'})).translatedText,'Hello');
  assert.equal((await service.detect({text:'ನಮಸ್ಕಾರ'})).language,'Kannada');
  assert.equal((await service.transliterate({text:'ನಮಸ್ಕಾರ',sourceLanguage:'Kannada',fromScript:'Knda',toScript:'Latn'})).text,'namaskara');
  await assert.rejects(service.translate({text:'hello',sourceLanguage:'English',targetLanguage:'Sanskrit'}),{code:'TRANSLATION_LANGUAGE_UNSUPPORTED'});
});
test('translation evidence cannot be silently replaced by an agent',async t => {
  const env = setup();t.after(() => env.repository.close());
  env.orchestrator.services.translation = {status:() => ({provider:'azure',configured:true}),translate:async () => ({translatedText:'A service result the test agent will not return.'})};
  await assert.rejects(env.orchestrator.execute(env.user.id,'tool',toolInput('translate',{text:'hello',sourceLanguage:'English',targetLanguage:'Kannada'},env.repository.profile(env.user.id))),{code:'INCONSISTENT_TRANSLATION'});
  assert.equal(env.repository.toolHistory(env.user.id).length,0);
});

test('website URLs reject private, loopback, mapped IPv6, metadata, credentials and insecure schemes',async () => {
  for (const address of ['127.0.0.1','10.0.0.1','172.16.0.1','192.168.0.1','169.254.169.254','::1','0:0:0:0:0:0:0:1','::ffff:192.168.0.1','0:0:0:0:0:ffff:c0a8:1','fd00::1']) assert.equal(isPublicAddress(address),false,address);
  assert.equal(isPublicAddress('8.8.8.8'),true);assert.equal(isPublicAddress('2606:4700:4700::1111'),true);
  await assert.rejects(validatePublicURL('https://example.com',async () => [{address:'10.0.0.1',family:4}]),{code:'PRIVATE_WEBSITE_BLOCKED'});
  await assert.rejects(validatePublicURL('https://user:pass@example.com'),{code:'UNSUPPORTED_WEBSITE_URL'});
  await assert.rejects(validatePublicURL('http://example.com'),{code:'UNSUPPORTED_WEBSITE_URL'});
});
test('website reader pins validated DNS, strips active content and checks redirects again',async () => {
  const lookupImpl = async () => [{address:'8.8.8.8',family:4}];
  const requestImpl = (url,options,callback) => {
    options.lookup('example.com',{},(error,address) => {assert.equal(address,'8.8.8.8');});
    const req = new EventEmitter();req.setTimeout = () => {};req.end = () => {
      const response = Readable.from([Buffer.from('<h1>Hello</h1><script>bad()</script><p>World</p>')]);response.statusCode = 200;response.headers = {'content-type':'text/html'};callback(response);
    };return req;
  };
  const result = await fetchPublicText('https://example.com',null,{lookupImpl,requestImpl});assert.equal(result.text,'Hello\nWorld');
  const redirect = (url,options,callback) => {const req = new EventEmitter();req.setTimeout = () => {};req.end = () => {const response = Readable.from([]);response.statusCode = 302;response.headers = {location:'https://127.0.0.1/secret'};callback(response);};return req;};
  await assert.rejects(fetchPublicText('https://example.com',null,{lookupImpl,requestImpl:redirect}),{code:'PRIVATE_WEBSITE_BLOCKED'});
});

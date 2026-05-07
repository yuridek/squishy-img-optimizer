import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const sharp = require('sharp');

const PORT = Number(process.env.PORT || 4173);
const HOST = process.env.HOST || '127.0.0.1';
const MAX_UPLOAD_BYTES = Number(process.env.MAX_UPLOAD_BYTES || 25 * 1024 * 1024);
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.avif': 'image/avif'
};

createServer(async (request, response) => {
  try {
    if ((request.method === 'GET' || request.method === 'HEAD') && request.url === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'squishy' });
      return;
    }

    if (request.method === 'POST' && request.url === '/api/optimize') {
      await handleOptimize(request, response);
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    sendJson(response, 500, { error: 'Optimization failed', detail: error.message });
  }
}).listen(PORT, HOST, () => {
  console.log(`Squishy running at http://${HOST}:${PORT}`);
});

async function handleOptimize(request, response) {
  const contentType = request.headers['content-type'] || '';
  const boundary = getBoundary(contentType);

  if (!boundary) {
    sendJson(response, 400, { error: 'Expected multipart/form-data upload' });
    return;
  }

  const body = await readRequestBody(request);
  const form = parseMultipart(body, boundary);
  const image = form.files.image;

  if (!image) {
    sendJson(response, 400, { error: 'Missing image file' });
    return;
  }

  const format = normalizeFormat(form.fields.format || 'avif');
  const quality = clamp(Number(form.fields.quality || 50), 1, 100);
  const effort = clamp(Number(form.fields.effort || 4), 0, 9);
  const lossless = form.fields.lossless === 'true';

  const input = sharp(image.data, { limitInputPixels: 80_000_000 });
  const metadata = await input.metadata();
  let pipeline = input.rotate();

  if (format === 'avif') {
    pipeline = pipeline.avif({
      quality,
      effort,
      lossless,
      chromaSubsampling: '4:2:0'
    });
  } else {
    pipeline = pipeline.webp({
      quality,
      effort,
      lossless,
      smartSubsample: true
    });
  }

  const output = await pipeline.toBuffer();
  const mime = format === 'avif' ? 'image/avif' : 'image/webp';

  sendJson(response, 200, {
    filename: buildOutputFilename(image.filename, format),
    format,
    mime,
    quality,
    effort,
    lossless,
    original: {
      filename: image.filename,
      mime: image.mime,
      bytes: image.data.length,
      width: metadata.width || null,
      height: metadata.height || null
    },
    optimized: {
      bytes: output.length,
      base64: output.toString('base64')
    },
    savings: {
      bytes: image.data.length - output.length,
      percent: image.data.length ? Math.round((1 - output.length / image.data.length) * 1000) / 10 : 0
    }
  });
}

async function serveStatic(request, response) {
  const url = new URL(request.url, `http://${request.headers.host}`);
  const requested = url.pathname === '/' ? '/index.html' : url.pathname;
  const safePath = normalize(decodeURIComponent(requested)).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  try {
    const content = await readFile(filePath);
    response.writeHead(200, {
      'Content-Type': MIME_TYPES[extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    response.end(content);
  } catch {
    response.writeHead(404);
    response.end('Not found');
  }
}

function getBoundary(contentType) {
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/i);
  return match ? (match[1] || match[2]) : null;
}

async function readRequestBody(request) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_UPLOAD_BYTES) {
      throw new Error(`Upload exceeds ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function parseMultipart(body, boundary) {
  const boundaryBuffer = Buffer.from(`--${boundary}`);
  const fields = {};
  const files = {};
  let cursor = 0;

  while (cursor < body.length) {
    const partStart = body.indexOf(boundaryBuffer, cursor);
    if (partStart === -1) break;

    const nextStart = body.indexOf(boundaryBuffer, partStart + boundaryBuffer.length);
    if (nextStart === -1) break;

    const part = body.subarray(partStart + boundaryBuffer.length + 2, nextStart - 2);
    const headerEnd = part.indexOf(Buffer.from('\r\n\r\n'));
    if (headerEnd === -1) {
      cursor = nextStart;
      continue;
    }

    const header = part.subarray(0, headerEnd).toString('utf8');
    const data = part.subarray(headerEnd + 4);
    const name = /name="([^"]+)"/.exec(header)?.[1];
    const filename = /filename="([^"]*)"/.exec(header)?.[1];
    const mime = /Content-Type:\s*([^\r\n]+)/i.exec(header)?.[1] || 'application/octet-stream';

    if (name && filename) {
      files[name] = { filename, mime, data };
    } else if (name) {
      fields[name] = data.toString('utf8');
    }

    cursor = nextStart;
  }

  return { fields, files };
}

function normalizeFormat(format) {
  return format === 'webp' ? 'webp' : 'avif';
}

function clamp(value, min, max) {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function buildOutputFilename(filename, format) {
  const clean = filename.replace(/\.[^.]+$/, '');
  return `${clean || 'squishy-output'}.${format}`;
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

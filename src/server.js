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
const API_KEY = process.env.SQUISHY_API_KEY || '';
const ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const PUBLIC_DIR = join(ROOT, 'public');
const IMAGE_MIME_TYPES = new Set(['image/png', 'image/jpeg', 'image/webp', 'image/avif']);

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
    const url = new URL(request.url, `http://${request.headers.host}`);

    if ((request.method === 'GET' || request.method === 'HEAD') && url.pathname === '/healthz') {
      sendJson(response, 200, { ok: true, service: 'squishy' });
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/optimize') {
      await handleOptimize(request, response);
      return;
    }

    if (request.method === 'POST' && url.pathname === '/api/convert') {
      await handleConvert(request, response);
      return;
    }

    if (request.method === 'GET' || request.method === 'HEAD') {
      await serveStatic(request, response);
      return;
    }

    sendJson(response, 405, { error: 'Method not allowed' });
  } catch (error) {
    console.error(error);
    sendJson(response, error.status || 500, {
      error: error.status ? error.message : 'Optimization failed',
      detail: error.status ? undefined : error.message
    });
  }
}).listen(PORT, HOST, () => {
  console.log(`Squishy running at http://${HOST}:${PORT}`);
});

async function handleOptimize(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  const { image, options } = await readOptimizeRequest(request);
  const result = await optimizeImage(image, options);

  sendJson(response, 200, {
    filename: result.filename,
    format: result.format,
    mime: result.mime,
    quality: result.quality,
    effort: result.effort,
    lossless: result.lossless,
    original: result.original,
    optimized: {
      bytes: result.output.length,
      base64: result.output.toString('base64')
    },
    savings: result.savings
  });
}

async function handleConvert(request, response) {
  if (!isAuthorized(request)) {
    sendJson(response, 401, { error: 'Unauthorized' });
    return;
  }

  const { image, options } = await readOptimizeRequest(request);
  const result = await optimizeImage(image, { ...options, format: options.format || 'avif' });

  response.writeHead(200, {
    'Content-Type': result.mime,
    'Content-Length': result.output.length,
    'Content-Disposition': `attachment; filename="${escapeHeaderValue(result.filename)}"`,
    'X-Squishy-Original-Bytes': String(result.original.bytes),
    'X-Squishy-Optimized-Bytes': String(result.output.length),
    'X-Squishy-Savings-Percent': String(result.savings.percent),
    'Cache-Control': 'no-store'
  });
  response.end(result.output);
}

async function readOptimizeRequest(request) {
  const contentType = request.headers['content-type'] || '';
  const boundary = getBoundary(contentType);

  if (!boundary) {
    throw new HttpError(400, 'Expected multipart/form-data upload');
  }

  const body = await readRequestBody(request);
  const form = parseMultipart(body, boundary);
  const image = form.files.image;

  if (!image) {
    throw new HttpError(400, 'Missing image file');
  }

  if (!IMAGE_MIME_TYPES.has(image.mime)) {
    throw new HttpError(415, 'Unsupported image type');
  }

  return {
    image,
    options: {
      format: normalizeFormat(form.fields.format || 'avif'),
      quality: clamp(Number(form.fields.quality || 50), 1, 100),
      effort: clamp(Number(form.fields.effort || 4), 0, 9),
      lossless: form.fields.lossless === 'true'
    }
  };
}

async function optimizeImage(image, options) {
  const format = normalizeFormat(options.format || 'avif');
  const quality = clamp(Number(options.quality || 50), 1, 100);
  const effort = clamp(Number(options.effort || 4), 0, 9);
  const lossless = options.lossless === true;
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
  const original = {
    filename: image.filename,
    mime: image.mime,
    bytes: image.data.length,
    width: metadata.width || null,
    height: metadata.height || null
  };
  const savings = {
    bytes: image.data.length - output.length,
    percent: image.data.length ? Math.round((1 - output.length / image.data.length) * 1000) / 10 : 0
  };

  return {
    filename: buildOutputFilename(image.filename, format),
    format,
    mime,
    quality,
    effort,
    lossless,
    original,
    output,
    savings
  };
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

function isAuthorized(request) {
  if (!API_KEY) return true;

  const header = request.headers.authorization || '';
  return header === `Bearer ${API_KEY}`;
}

function escapeHeaderValue(value) {
  return String(value).replace(/["\\\r\n]/g, '_');
}

function sendJson(response, status, payload) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  response.end(JSON.stringify(payload));
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

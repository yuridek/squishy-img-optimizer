# Squishy Image Optimizer

Squishy is a small local-first image optimizer inspired by the Squoosh workflow.

The first MVP keeps the frontend and API in one Node server:

- upload a JPEG/PNG/WebP/AVIF image
- choose AVIF or WebP
- tune quality, effort and lossless mode
- compare original vs optimized size
- download the optimized result

## Run locally

Install dependencies:

```bash
npm install
```

Start the app:

```bash
npm run dev
```

Open:

```text
http://localhost:4173
```

## Docker

Build:

```bash
docker build -t squishy-img-optimizer .
```

Run:

```bash
docker run --rm -p 4173:4173 squishy-img-optimizer
```

Healthcheck:

```text
http://localhost:4173/healthz
```

## API

`POST /api/optimize`

Multipart fields:

- `image`: image file
- `format`: `avif` or `webp`
- `quality`: `1-100`
- `effort`: `0-9`
- `lossless`: `true` or `false`

The response contains the optimized image as a base64 payload plus size metadata.

`POST /api/convert`

Multipart fields are the same as `/api/optimize`, but the response body is the optimized image bytes directly. This is useful for scripts, Finder Quick Actions and other automation flows.

Example:

```bash
curl -fsS -X POST http://localhost:4173/api/convert \
  -F "image=@sample.png" \
  -F "format=avif" \
  -F "quality=50" \
  -F "effort=4" \
  -F "lossless=false" \
  -o sample.avif
```

Optional API protection:

```bash
SQUISHY_API_KEY="change-me" npm run start
```

When `SQUISHY_API_KEY` is set, API requests must include:

```text
Authorization: Bearer change-me
```

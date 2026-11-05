# Scoutool

Scoutool scans public website pages for publicly listed business email
addresses and streams results to the dashboard. It also provides a campaign
helper for generating email links from scanned addresses.

## Local development

Install dependencies and start the development server:

```text
npm install
npm run dev
```

Open <http://localhost:3000>.

## Environment

The API rate limiter uses Upstash Redis in production. Set these variables in
`.env.local` or the deployment environment:

```text
UPSTASH_REDIS_REST_URL=https://your-instance.upstash.io
UPSTASH_REDIS_REST_TOKEN=your-token
```

The URL must be the HTTPS Upstash REST endpoint. The proxy allows requests
without Redis credentials during development, but production requests return
`503` until rate limiting is configured.

To enable direct campaign sending, also configure:

```text
RESEND_API_KEY=re_...
RESEND_FROM_EMAIL=verified-sender@example.com
```

The sender address must be verified with Resend. If these variables are not
configured, the campaign helper still supports Gmail, mailto links, and CSV
export, while direct sending remains disabled.

## Validation

```text
npm run lint
npx tsc --noEmit
npm run build
```

Scans accept up to 1,000 normalized website domains per request. Requests are
rate-limited and the scanner rejects private or non-public network targets.


import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const maxDuration = 300;

const MAX_DOMAINS = 1000;
const MAX_PAGES = 8;
const TIMEOUT = 8000;
const MAX_HTML_SIZE = 1_000_000;
const BATCH_SIZE = 4;

type Result = {
  email: string;
  site: string;
  path: string;
  country: string;
  language: string;
};

type Outcome = {
  results: Result[];
  status: "success" | "no_email" | "blocked" | "error";
};

const COUNTRIES: Record<string, string> = {
  ae: "United Arab Emirates", uk: "United Kingdom",
  gb: "United Kingdom", us: "United States", ca: "Canada",
  au: "Australia", ng: "Nigeria", za: "South Africa",
  fr: "France", de: "Germany", es: "Spain", it: "Italy",
  nl: "Netherlands", be: "Belgium", ie: "Ireland",
  in: "India", nz: "New Zealand", br: "Brazil",
  mx: "Mexico", sg: "Singapore", jp: "Japan",
  sa: "Saudi Arabia", qa: "Qatar", kw: "Kuwait",
  om: "Oman", bh: "Bahrain", eg: "Egypt", tr: "Turkey",
  pt: "Portugal", ch: "Switzerland", at: "Austria",
  se: "Sweden", no: "Norway", dk: "Denmark",
  fi: "Finland", pl: "Poland", gr: "Greece",
};

const LANGUAGES: Record<string, string> = {
  en: "English", ar: "Arabic", fr: "French",
  de: "German", es: "Spanish", it: "Italian",
  nl: "Dutch", pt: "Portuguese", ru: "Russian",
  zh: "Chinese", ja: "Japanese", ko: "Korean",
  tr: "Turkish", hi: "Hindi", ur: "Urdu",
  sw: "Swahili", pl: "Polish", sv: "Swedish",
  da: "Danish", no: "Norwegian", fi: "Finnish",
};

const SHOPIFY_PATHS = [
  "/pages/contact",
  "/pages/contact-us",
  "/pages/about",
  "/pages/about-us",
  "/pages/faq",
  "/pages/support",
  "/policies/contact-information",
  "/policies/privacy-policy",
];

function isPublicIPv4(address: string): boolean {
  const p = address.split(".").map(Number);
  if (p.length !== 4 || p.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;

  const [a, b, c] = p;

  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 2) ||
    (a === 198 && (b === 18 || b === 19 || b === 51)) ||
    (a === 203 && b === 0 && c === 113)
  );
}

async function isSafeHost(hostname: string): Promise<boolean> {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");

  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    return false;
  }

  if (isIP(host) === 4) return isPublicIPv4(host);
  if (isIP(host) === 6) return false;

  try {
    const addresses = await lookup(host, { family: 4, all: true });
    return addresses.length > 0 && addresses.every(item => isPublicIPv4(item.address));
  } catch {
    return false;
  }
}

function normalizeUrl(value: string): string | null {
  let input = value.trim();
  if (!input) return null;
  if (!/^https?:\/\//i.test(input)) input = `https://${input}`;

  try {
    const url = new URL(input);
    if (!["http:", "https:"].includes(url.protocol) || !url.hostname || url.username || url.password) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}

function decodeHtml(value: string): string {
  return value
    .replace(/&commat;/gi, "@")
    .replace(/&#64;/g, "@")
    .replace(/&#x40;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&#46;/g, ".")
    .replace(/&#x2e;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ");
}

function detectCountry(hostname: string, html: string): string {
  const match = html.match(/"addressCountry"\s*:\s*"([A-Z]{2})"/i);
  if (match) {
    const country = Object.entries(COUNTRIES).find(([code]) => code.toUpperCase() === match[1].toUpperCase());
    if (country) return country[1];
  }

  return COUNTRIES[hostname.split(".").pop()?.toLowerCase() || ""] || "Unknown";
}

function detectLanguage(html: string): string {
  const match =
    html.match(/<html[^>]*\blang=["']([^"']+)["']/i) ||
    html.match(/<meta[^>]+name=["']content-language["'][^>]+content=["']([^"']+)/i);

  if (match?.[1]) {
    const code = match[1].split(/[-_]/)[0].toLowerCase();
    return LANGUAGES[code] || "Unknown";
  }

  const text = html.replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ").slice(0, 15000);

  const scripts = [
    { language: "Arabic", pattern: /[\u0600-\u06FF]/g },
    { language: "Russian", pattern: /[\u0400-\u04FF]/g },
    { language: "Chinese", pattern: /[\u4E00-\u9FFF]/g },
    { language: "Japanese", pattern: /[\u3040-\u30FF]/g },
    { language: "Korean", pattern: /[\uAC00-\uD7AF]/g },
  ];

  const scores = scripts.map(item => ({
    language: item.language,
    count: (text.match(item.pattern) || []).length,
  })).sort((a, b) => b.count - a.count);

  return scores[0]?.count >= 10 ? scores[0].language : "Unknown";
}

function extractEmails(html: string): string[] {
  const decoded = decodeHtml(html);
  const cleaned = decoded
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ");

  const found = cleaned.match(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g) || [];
  const mailto = [...decoded.matchAll(/mailto:([^"'?\s<>]+)/gi)]
    .map(match => {
      try {
        return decodeURIComponent(match[1].split("?")[0]);
      } catch {
        return "";
      }
    });

  return [...new Set([...found, ...mailto].map(email => email.trim().toLowerCase())
    .filter(email => /^[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}$/i.test(email)))];
}

function findContactLinks(html: string, baseUrl: string): string[] {
  const links = html.match(/href=["'][^"']+["']/gi) || [];
  const found = new Set<string>();

  for (const item of links) {
    const value = decodeHtml(item.slice(6, -1));
    if (!/(contact|about|support|help|imprint)/i.test(value)) continue;

    try {
      const url = new URL(value, baseUrl);
      if (url.origin === new URL(baseUrl).origin && ["http:", "https:"].includes(url.protocol)) {
        url.hash = "";
        found.add(url.toString());
      }
    } catch {
      // Ignore invalid links.
    }
  }

  return [...found];
}

async function fetchPublicPage(
  inputUrl: string
): Promise<{ html: string; url: string; blocked: boolean } | null> {
  let currentUrl = inputUrl;

  for (let redirect = 0; redirect < 4; redirect++) {
    let url: URL;
    try {
      url = new URL(currentUrl);
    } catch {
      return null;
    }

    if (!(await isSafeHost(url.hostname))) return null;

    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(TIMEOUT),
        headers: {
          "User-Agent": "ScoutoolPublicContactResearch/1.0",
          Accept: "text/html",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        if (!location) return null;
        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if ([401, 403, 429, 503].includes(response.status)) {
        return { html: "", url: currentUrl, blocked: true };
      }

      if (!response.ok) return null;
      if (!(response.headers.get("content-type") || "").toLowerCase().includes("text/html")) return null;

      const length = Number(response.headers.get("content-length") || 0);
      if (length > MAX_HTML_SIZE) return null;

      const html = await response.text();
      if (html.length > MAX_HTML_SIZE) return null;

      return { html, url: currentUrl, blocked: false };
    } catch {
      return null;
    }
  }

  return null;
}

async function scanWebsite(site: string): Promise<Outcome> {
  const normalized = normalizeUrl(site);
  if (!normalized) return { results: [], status: "error" };

  const homepage = await fetchPublicPage(normalized);
  if (!homepage) return { results: [], status: "error" };
  if (homepage.blocked) return { results: [], status: "blocked" };

  const base = new URL(homepage.url);
  const candidates = new Set<string>();

  for (const path of SHOPIFY_PATHS) {
    candidates.add(new URL(path, base.origin).toString());
  }

  for (const link of findContactLinks(homepage.html, homepage.url)) {
    candidates.add(link);
  }

  const extraPages = await Promise.all(
    [...candidates].slice(0, MAX_PAGES - 1).map(fetchPublicPage)
  );

  const pages = [
    homepage,
    ...extraPages.filter((page): page is NonNullable<typeof page> => page !== null && !page.blocked),
  ].slice(0, MAX_PAGES);

  const wasBlocked = extraPages.some(page => page?.blocked);
  const hostname = base.hostname;
  const country = detectCountry(hostname, pages.map(page => page.html).join(" "));
  const language = detectLanguage(homepage.html);
  const results = new Map<string, Result>();

  for (const page of pages) {
    const path = new URL(page.url).pathname || "/";
    for (const email of extractEmails(page.html)) {
      if (!results.has(email)) {
        results.set(email, { email, site: hostname, path, country, language });
      }
    }
  }

  const found = [...results.values()];

  return {
    results: found,
    status: found.length ? "success" : wasBlocked ? "blocked" : "no_email",
  };
}

export async function POST(request: NextRequest) {
  let body: { domains?: unknown };

  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (!Array.isArray(body.domains)) {
    return Response.json({ error: "Please provide a list of websites." }, { status: 400 });
  }

  const domains = body.domains
    .filter((item): item is string => typeof item === "string")
    .map(item => item.trim())
    .filter(Boolean);

  if (!domains.length) {
    return Response.json({ error: "Enter at least one website." }, { status: 400 });
  }

  if (domains.length > MAX_DOMAINS) {
    return Response.json({ error: `Maximum ${MAX_DOMAINS} websites per run.` }, { status: 400 });
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();
      let processed = 0;
      let successful = 0;
      let errors = 0;
      let blocked = 0;
      let noEmail = 0;
      let emailsFound = 0;

      function send(event: Record<string, unknown>) {
        controller.enqueue(encoder.encode(JSON.stringify(event) + "\n"));
      }

      send({ type: "start", total: domains.length });

      try {
        for (let i = 0; i < domains.length; i += BATCH_SIZE) {
          const batch = domains.slice(i, i + BATCH_SIZE);

          await Promise.all(batch.map(async domain => {
            let outcome: Outcome;

            try {
              outcome = await scanWebsite(domain);
            } catch {
              outcome = { results: [], status: "error" };
            }

            processed++;

            if (outcome.status === "error") errors++;
            else if (outcome.status === "blocked") blocked++;
            else if (outcome.status === "no_email") {
              noEmail++;
              successful++;
            } else {
              successful++;
            }

            for (const result of outcome.results) {
              emailsFound++;
              send({ type: "result", result });
            }

            send({
              type: "progress",
              processed,
              total: domains.length,
              successful,
              errors,
              blocked,
              noEmail,
              emailsFound,
              currentSite: domain,
            });
          }));
        }

        send({
          type: "done",
          processed,
          successful,
          errors,
          blocked,
          noEmail,
          emailsFound,
        });
      } catch {
        send({ type: "error", message: "The scraping process was interrupted." });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

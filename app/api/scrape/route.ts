import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { Agent, fetch as undiciFetch } from "undici";
import * as ipaddr from "ipaddr.js";
import { parse as parseDomain } from "tldts";

export const maxDuration = 300;

// Scanner settings
const MAX_DOMAINS = 1000;
const SITE_CONCURRENCY = 4;
const PAGE_CONCURRENCY = 4;
const MAX_CONTACT_PAGES = 10;
const REQUEST_TIMEOUT = 9000;
const MAX_HTML_SIZE = 1_000_000;
const MAX_SITEMAP_SIZE = 400_000;
const MAX_REQUEST_BYTES = 256 * 1024;

const SCOUTOOL_USER_AGENT =
  "ScoutoolPublicContactResearch/1.0";

type Result = {
  email: string;
  site: string;
  path: string;
  country: string;
  language: string;
};

type Status = "success" | "no_email" | "blocked" | "error";

type Outcome = {
  results: Result[];
  status: Status;
  hostname: string;
  reason?: string;
};

type FetchResult =
  | { status: "ok"; text: string; url: string }
  | {
      status:
        | "missing"
        | "forbidden"
        | "rate_limited"
        | "unreachable"
        | "aborted"
        | "error";
      url: string;
      httpStatus?: number;
    };

type RobotsRule = {
  allow: boolean;
  path: string;
};

type RobotsData = {
  rules: RobotsRule[];
  sitemaps: string[];
};

// --------------------------------------------
// COUNTRY AND LANGUAGE DATA
// --------------------------------------------

const COUNTRIES: Record<string, string> = {
  ae: "United Arab Emirates",
  uk: "United Kingdom",
  gb: "United Kingdom",
  us: "United States",
  ca: "Canada",
  au: "Australia",
  ng: "Nigeria",
  za: "South Africa",
  fr: "France",
  de: "Germany",
  es: "Spain",
  it: "Italy",
  nl: "Netherlands",
  be: "Belgium",
  ch: "Switzerland",
  at: "Austria",
  se: "Sweden",
  no: "Norway",
  dk: "Denmark",
  fi: "Finland",
  ie: "Ireland",
  pt: "Portugal",
  pl: "Poland",
  cz: "Czech Republic",
  gr: "Greece",
  tr: "Turkey",
  ru: "Russia",
  ua: "Ukraine",
  cn: "China",
  hk: "Hong Kong",
  tw: "Taiwan",
  jp: "Japan",
  kr: "South Korea",
  in: "India",
  sg: "Singapore",
  my: "Malaysia",
  id: "Indonesia",
  ph: "Philippines",
  th: "Thailand",
  vn: "Vietnam",
  br: "Brazil",
  mx: "Mexico",
  ar: "Argentina",
  cl: "Chile",
  co: "Colombia",
  pe: "Peru",
  nz: "New Zealand",
  il: "Israel",
  sa: "Saudi Arabia",
  eg: "Egypt",
  ke: "Kenya",
  gh: "Ghana",
};

const LANGUAGE_BY_COUNTRY: Record<string, string> = {
  us: "English",
  gb: "English",
  uk: "English",
  ca: "English",
  au: "English",
  nz: "English",
  ng: "English",
  za: "English",
  gh: "English",
  ke: "English",
  ie: "English",
  in: "English",
  fr: "French",
  be: "French / Dutch",
  ch: "German / French / Italian",
  de: "German",
  at: "German",
  es: "Spanish",
  mx: "Spanish",
  ar: "Spanish",
  cl: "Spanish",
  co: "Spanish",
  pe: "Spanish",
  it: "Italian",
  nl: "Dutch",
  pt: "Portuguese",
  br: "Portuguese",
  ru: "Russian",
  ua: "Ukrainian",
  cn: "Chinese",
  hk: "Chinese / English",
  tw: "Chinese",
  jp: "Japanese",
  kr: "Korean",
  sg: "English",
  my: "Malay",
  id: "Indonesian",
  ph: "Filipino / English",
  th: "Thai",
  vn: "Vietnamese",
  tr: "Turkish",
  gr: "Greek",
  pl: "Polish",
  cz: "Czech",
  se: "Swedish",
  no: "Norwegian",
  dk: "Danish",
  fi: "Finnish",
  il: "Hebrew",
  sa: "Arabic",
  eg: "Arabic",
  ae: "Arabic / English",
};

// --------------------------------------------
// EMAIL FILTER DATA
// --------------------------------------------

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "avif",
  "ico",
  "bmp",
  "tif",
  "tiff",
  "css",
  "js",
  "map",
  "woff",
  "woff2",
  "ttf",
  "eot",
  "otf",
  "pdf",
  "zip",
  "rar",
  "mp4",
  "mp3",
]);

const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.net",
  "test.com",
  "domain.com",
  "email.com",
  "yourdomain.com",
  "website.com",
  "company.com",
  "sentry.io",
  "wixpress.com",
  "squarespace.com",
]);

const PLACEHOLDER_NAMES = new Set([
  "example",
  "test",
  "user",
  "username",
  "yourname",
  "name",
  "email",
  "your.email",
  "yourname",
  "placeholder",
  "sample",
  "demo",
  "admin",
  "webmaster",
  "root",
]);

// --------------------------------------------
// GENERAL HELPERS
// --------------------------------------------

function cleanHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[/, "")
    .replace(/\]$/, "")
    .replace(/\.$/, "");
}

function isPublicAddress(address: string): boolean {
  try {
    const normalized = ipaddr.process(address);
    return normalized.range() === "unicast";
  } catch {
    return false;
  }
}

async function resolvePublicAddresses(
  hostname: string,
): Promise<Array<{ address: string; family: number }>> {
  const host = cleanHostname(hostname);

  if (!host || host === "localhost" || host.endsWith(".localhost")) {
    return [];
  }

  const ipVersion = isIP(host);

  if (ipVersion) {
    return isPublicAddress(host)
      ? [{ address: host, family: ipVersion }]
      : [];
  }

  try {
    const records = await lookup(host, {
      all: true,
      verbatim: true,
    });

    if (!records.length) return [];

    // Reject the entire hostname if even one answer is non-public.
    if (records.some((record) => !isPublicAddress(record.address))) {
      return [];
    }

    return records.map((record) => ({
      address: record.address,
      family: record.family,
    }));
  } catch {
    return [];
  }
}

async function checkHost(hostname: string): Promise<boolean> {
  const addresses = await resolvePublicAddresses(hostname);
  return addresses.length > 0;
}

function createHostValidator() {
  const cache = new Map<string, Promise<boolean>>();

  return async (hostname: string): Promise<boolean> => {
    const host = cleanHostname(hostname);

    if (!cache.has(host)) {
      cache.set(host, checkHost(host));
    }

    return cache.get(host)!;
  };
}

function sameSiteHost(original: string, target: string): boolean {
  const first = cleanHostname(original);
  const second = cleanHostname(target);

  if (!first || !second) return false;
  if (first === second) return true;

  const firstWithoutWww = first.replace(/^www\./, "");
  const secondWithoutWww = second.replace(/^www\./, "");

  return firstWithoutWww === secondWithoutWww;
}

function isAllowedUrl(url: URL, originalHostname: string): boolean {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  if (url.username || url.password) {
    return false;
  }

  if (!sameSiteHost(originalHostname, url.hostname)) {
    return false;
  }

  // Only standard HTTP and HTTPS ports are permitted.
  if (url.port) {
    if (url.protocol === "http:" && url.port !== "80") return false;
    if (url.protocol === "https:" && url.port !== "443") return false;
  }

  return true;
}

function createPinnedAgent(
  hostname: string,
  address: string,
  family: number,
): Agent {
  const expectedHost = cleanHostname(hostname);

  const pinnedLookup = (
    requestedHostname: string,
    options: { all?: boolean },
    callback: (...args: unknown[]) => void,
  ) => {
    if (cleanHostname(requestedHostname) !== expectedHost) {
      callback(new Error("Unexpected hostname"));
      return;
    }

    if (options?.all) {
      callback(null, [{ address, family }]);
    } else {
      callback(null, address, family);
    }
  };

  return new Agent({
    connect: {
      lookup: pinnedLookup as never,
    },
  });
}

async function readLimitedText(
  response: Awaited<ReturnType<typeof undiciFetch>>,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<string | null> {
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let totalBytes = 0;

  try {
    while (true) {
      if (signal?.aborted) {
        await reader.cancel();
        return null;
      }

      const { done, value } = await reader.read();

      if (done) break;

      totalBytes += value.byteLength;

      if (totalBytes > maxBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }
  } catch {
    try {
      await reader.cancel();
    } catch {
      // Ignore cancellation errors.
    }

    return null;
  }

  const combined = new Uint8Array(totalBytes);
  let offset = 0;

  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }

  return new TextDecoder("utf-8", { fatal: false }).decode(combined);
}

async function fetchPublicText(
  inputUrl: string,
  originalHostname: string,
  maxBytes: number,
  isSafeHost: (hostname: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<FetchResult> {
  if (signal?.aborted) {
    return { status: "aborted", url: inputUrl };
  }

  let currentUrl: URL;

  try {
    currentUrl = new URL(inputUrl);
  } catch {
    return { status: "error", url: inputUrl };
  }

  for (let redirectCount = 0; redirectCount <= 4; redirectCount++) {
    if (signal?.aborted) {
      return { status: "aborted", url: currentUrl.toString() };
    }

    if (!isAllowedUrl(currentUrl, originalHostname)) {
      return { status: "error", url: currentUrl.toString() };
    }

    const hostname = cleanHostname(currentUrl.hostname);

    if (!(await isSafeHost(hostname))) {
      return { status: "error", url: currentUrl.toString() };
    }

    // Resolve again for every request and pin the connection to the
    // validated address. This prevents a second DNS lookup from returning
    // a different address between validation and connection.
    const addresses = await resolvePublicAddresses(hostname);

    if (!addresses.length) {
      return { status: "error", url: currentUrl.toString() };
    }

    const selectedAddress = addresses[0];
    const agent = createPinnedAgent(
      hostname,
      selectedAddress.address,
      selectedAddress.family,
    );

   let response: Awaited<ReturnType<typeof undiciFetch>>;

    try {
      response = await undiciFetch(currentUrl.toString(), {
        method: "GET",
        redirect: "manual",
        dispatcher: agent,
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT)])
          : AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: {
          "User-Agent": SCOUTOOL_USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/xml,text/xml,*/*;q=0.5",
        },
      });
    } catch (error) {
      await agent.close().catch(() => undefined);

      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return { status: "aborted", url: currentUrl.toString() };
      }

      return { status: "unreachable", url: currentUrl.toString() };
    }

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get("location")
    ) {
      const location = response.headers.get("location")!;

      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      if (redirectCount === 4) {
        return { status: "error", url: currentUrl.toString() };
      }

      try {
        currentUrl = new URL(location, currentUrl);
      } catch {
        return { status: "error", url: currentUrl.toString() };
      }

      continue;
    }

    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "forbidden",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "missing",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    if (response.status === 429) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "rate_limited",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    if (response.status >= 500) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "unreachable",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "error",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    const contentType = (
      response.headers.get("content-type") || ""
    ).toLowerCase();

    const isTextContent =
      !contentType ||
      contentType.includes("text/") ||
      contentType.includes("application/xml") ||
      contentType.includes("application/xhtml+xml") ||
      contentType.includes("application/json");

    if (!isTextContent) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "error",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    const contentLength = Number(
      response.headers.get("content-length") || 0,
    );

    if (contentLength > maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      await agent.close().catch(() => undefined);

      return {
        status: "error",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    const text = await readLimitedText(response, maxBytes, signal);

    await agent.close().catch(() => undefined);

    if (text === null) {
      return {
        status: "error",
        url: currentUrl.toString(),
        httpStatus: response.status,
      };
    }

    return {
      status: "ok",
      text,
      url: currentUrl.toString(),
    };
  }

  return { status: "error", url: currentUrl.toString() };
}

// --------------------------------------------
// ROBOTS.TXT
// --------------------------------------------

function parseRobotsTxt(text: string): RobotsData {
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];

  const lines = text.split(/\r?\n/);
  let appliesToScoutool = false;
  let hasSpecificAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.split("#")[0].trim();

    if (!line) continue;

    const separator = line.indexOf(":");
    if (separator === -1) continue;

    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (key === "user-agent") {
      const agent = value.toLowerCase();

      if (agent === "*") {
        appliesToScoutool = !hasSpecificAgent;
      } else if (agent.includes("scoutool")) {
        appliesToScoutool = true;
        hasSpecificAgent = true;
      } else {
        appliesToScoutool = false;
      }

      continue;
    }

    if (key === "sitemap" && value) {
      sitemaps.push(value);
      continue;
    }

    if (
      appliesToScoutool &&
      (key === "allow" || key === "disallow") &&
      value
    ) {
      rules.push({
        allow: key === "allow",
        path: value,
      });
    }
  }

  return { rules, sitemaps };
}

function isAllowedByRobots(
  pathname: string,
  rules: RobotsRule[],
): boolean {
  let bestMatch: RobotsRule | null = null;

  for (const rule of rules) {
    if (!pathname.startsWith(rule.path)) continue;

    if (
      !bestMatch ||
      rule.path.length > bestMatch.path.length ||
      (rule.path.length === bestMatch.path.length && rule.allow)
    ) {
      bestMatch = rule;
    }
  }

  return bestMatch ? bestMatch.allow : true;
}

// --------------------------------------------
// SITEMAP DISCOVERY
// --------------------------------------------

function extractSitemapUrls(xml: string): string[] {
  const urls = new Set<string>();

  const matches = xml.matchAll(
    /<loc\b[^>]*>([\s\S]*?)<\/loc>/gi,
  );

  for (const match of matches) {
    const value = decodeHtmlEntities(match[1].trim());

    if (!value) continue;

    try {
      const url = new URL(value);

      if (
        url.protocol === "http:" ||
        url.protocol === "https:"
      ) {
        urls.add(url.toString());
      }
    } catch {
      // Ignore malformed sitemap entries.
    }
  }

  return Array.from(urls);
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex\b/i.test(xml);
}

async function discoverSitemaps(
  baseUrl: URL,
  hostname: string,
  isSafeHost: (hostname: string) => Promise<boolean>,
  signal?: AbortSignal,
): Promise<string[]> {
  const sitemapCandidates = new Set<string>([
    new URL("/sitemap.xml", baseUrl).toString(),
    new URL("/sitemap_index.xml", baseUrl).toString(),
  ]);

  const robots = await fetchPublicText(
    new URL("/robots.txt", baseUrl).toString(),
    hostname,
    100_000,
    isSafeHost,
    signal,
  );

  if (robots.status === "ok") {
    const parsed = parseRobotsTxt(robots.text);

    for (const sitemap of parsed.sitemaps) {
      try {
        const url = new URL(sitemap, baseUrl);

        if (sameSiteHost(hostname, url.hostname)) {
          sitemapCandidates.add(url.toString());
        }
      } catch {
        // Ignore malformed sitemap URLs.
      }
    }
  }

  const discovered = new Set<string>();
  const queue = Array.from(sitemapCandidates);
  const visited = new Set<string>();

  while (queue.length && visited.size < 12) {
    const sitemapUrl = queue.shift()!;

    if (visited.has(sitemapUrl)) continue;
    visited.add(sitemapUrl);

    const result = await fetchPublicText(
      sitemapUrl,
      hostname,
      MAX_SITEMAP_SIZE,
      isSafeHost,
      signal,
    );

    if (result.status !== "ok") continue;

    const urls = extractSitemapUrls(result.text);

    if (isSitemapIndex(result.text)) {
      for (const url of urls) {
        try {
          const parsed = new URL(url);

          if (sameSiteHost(hostname, parsed.hostname)) {
            queue.push(parsed.toString());
          }
        } catch {
          // Ignore malformed sitemap URLs.
        }
      }
    } else {
      for (const url of urls) {
        try {
          const parsed = new URL(url);

          if (sameSiteHost(hostname, parsed.hostname)) {
            discovered.add(parsed.toString());
          }
        } catch {
          // Ignore malformed sitemap URLs.
        }
      }
    }
  }

  return Array.from(discovered);
}

// --------------------------------------------
// HTML AND EMAIL EXTRACTION
// --------------------------------------------

function decodeHtmlEntities(value: string): string {
  const namedEntities: Record<string, string> = {
    amp: "&",
    quot: '"',
    apos: "'",
    lt: "<",
    gt: ">",
    nbsp: " ",
    commat: "@",
    period: ".",
    colon: ":",
    sol: "/",
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi,
    (match, entity: string) => {
      if (entity.startsWith("#x")) {
        const code = parseInt(entity.slice(2), 16);

        return decodeCodePoint(code, match);
      }

      if (entity.startsWith("#")) {
        const code = parseInt(entity.slice(1), 10);

        return decodeCodePoint(code, match);
      }

      return namedEntities[entity.toLowerCase()] ?? match;
    },
  );
}

function decodeCodePoint(code: number, fallback: string): string {
  if (
    !Number.isInteger(code) ||
    code < 0 ||
    code > 0x10ffff ||
    (code >= 0xd800 && code <= 0xdfff)
  ) {
    return fallback;
  }

  return String.fromCodePoint(code);
}

function isValidBusinessEmail(value: string): boolean {
  const email = value.trim().toLowerCase();

  if (email.length > 254) return false;

  const parts = email.split("@");

  if (parts.length !== 2) return false;

  const [local, domain] = parts;

  if (!local || !domain || local.length > 64) return false;

  if (
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/i.test(local)
  ) {
    return false;
  }

  if (
    !/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i.test(
      domain,
    )
  ) {
    return false;
  }

  const labels = domain.split(".");

  if (
    labels.some(
      (label) =>
        label.length > 63 ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return false;
  }

  const tld = labels[labels.length - 1];

  if (IMAGE_EXTENSIONS.has(tld)) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_NAMES.has(local)) return false;

  if (
    /^(no[._-]?reply|do[._-]?not[._-]?reply|noreply)$/i.test(
      local,
    )
  ) {
    return false;
  }

  if (
    /^(gemini_generated_image|logo|thumbnail|icon)[_.-]/i.test(
      local,
    )
  ) {
    return false;
  }

  // Require a recognized public suffix.
  const domainInfo = parseDomain(domain);

  if (!domainInfo.isIcann || !domainInfo.publicSuffix) {
    return false;
  }

  return true;
}

function extractEmails(html: string): string[] {
  const decoded = decodeHtmlEntities(html);
  const candidates = new Set<string>();

  // JSON-LD structured data may contain business contact emails.
  const jsonLdBlocks = decoded.matchAll(
    /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
  );

  for (const block of jsonLdBlocks) {
    const emailMatches = block[1].match(
      /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi,
    );

    if (emailMatches) {
      for (const email of emailMatches) {
        candidates.add(email);
      }
    }
  }

  // Extract mailto links before removing HTML tags.
  const mailtoMatches = decoded.matchAll(
    /href\s*=\s*["']mailto:([^"'?#\s]+)(?:\?[^"']*)?["']/gi,
  );

  for (const match of mailtoMatches) {
    candidates.add(match[1]);
  }

  // Remove comments and non-visible or asset-related markup.
  let visible = decoded
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript\b[^>]*>[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, " ")
    .replace(/<picture\b[^>]*>[\s\S]*?<\/picture>/gi, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<source\b[^>]*>/gi, " ")
    .replace(/<video\b[^>]*>[\s\S]*?<\/video>/gi, " ")
    .replace(/<audio\b[^>]*>[\s\S]*?<\/audio>/gi, " ")
    .replace(/<[^>]+>/g, " ");

  visible = visible
    .replace(/&nbsp;/gi, " ")
    .replace(/&#160;/g, " ")
    .replace(/\s+/g, " ");

  const directMatches = visible.match(
    /[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,63}/gi,
  );

  if (directMatches) {
    for (const email of directMatches) {
      candidates.add(email);
    }
  }

  // Handle common obfuscated email formats.
  const obfuscated = visible.matchAll(
    /([a-z0-9._%+-]+)\s*(?:\[at\]|\(at\)|\s+at\s+)\s*([a-z0-9.-]+)\s*(?:\[dot\]|\(dot\)|\s+dot\s+)\s*([a-z]{2,63})/gi,
  );

  for (const match of obfuscated) {
    candidates.add(`${match[1]}@${match[2]}.${match[3]}`);
  }

  return Array.from(candidates)
    .map((email) => email.trim().toLowerCase())
    .filter(isValidBusinessEmail);
}

// --------------------------------------------
// PAGE DISCOVERY
// --------------------------------------------

const CONTACT_KEYWORDS = [
  "contact",
  "contact-us",
  "contactus",
  "about",
  "about-us",
  "aboutus",
  "team",
  "our-team",
  "support",
  "help",
  "customer-service",
  "customer-support",
  "imprint",
  "impressum",
  "company",
  "who-we-are",
];

function extractPageLinks(
  html: string,
  baseUrl: URL,
  hostname: string,
): string[] {
  const links = new Set<string>();

  const matches = html.matchAll(
    /<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>/gi,
  );

  for (const match of matches) {
    const href = decodeHtmlEntities(match[1].trim());

    if (
      !href ||
      href.startsWith("#") ||
      href.startsWith("mailto:") ||
      href.startsWith("tel:") ||
      href.startsWith("javascript:")
    ) {
      continue;
    }

    try {
      const url = new URL(href, baseUrl);

      if (
        !sameSiteHost(hostname, url.hostname) ||
        (url.protocol !== "http:" && url.protocol !== "https:")
      ) {
        continue;
      }

      url.hash = "";

      const path = url.pathname.toLowerCase();

      if (
        CONTACT_KEYWORDS.some((keyword) =>
          path.includes(keyword),
        )
      ) {
        links.add(url.toString());
      }
    } catch {
      // Ignore malformed links.
    }
  }

  return Array.from(links).slice(0, MAX_CONTACT_PAGES);
}

function extractCountry(
  hostname: string,
  html: string,
  url: string,
): string {
  const host = cleanHostname(hostname);
  const labels = host.split(".");
  const tld = labels[labels.length - 1];

  if (COUNTRIES[tld]) return COUNTRIES[tld];

  const countryCodeMatches = [
    /"addressCountry"\s*:\s*"([a-z]{2})"/i,
    /"country"\s*:\s*"([a-z]{2})"/i,
    /itemprop=["']addressCountry["'][^>]*>\s*([a-z]{2})/i,
  ];

  for (const pattern of countryCodeMatches) {
    const match = html.match(pattern);

    if (match && COUNTRIES[match[1].toLowerCase()]) {
      return COUNTRIES[match[1].toLowerCase()];
    }
  }

  const countryNameMatches = [
    /"addressCountry"\s*:\s*"([^"]+)"/i,
    /"country"\s*:\s*"([^"]+)"/i,
  ];

  for (const pattern of countryNameMatches) {
    const match = html.match(pattern);

    if (match) {
      const value = match[1].trim();

      if (value.length > 2 && value.length < 60) {
        return value;
      }
    }
  }

  try {
    const parsed = new URL(url);

    if (parsed.hostname.endsWith(".com")) {
      return "United States";
    }
  } catch {
    // Ignore malformed URL.
  }

  return "Unknown";
}

function extractLanguage(
  html: string,
  country: string,
): string {
  const langMatch = html.match(
    /<html\b[^>]*\blang=["']([^"']+)["']/i,
  );

  if (langMatch) {
    const language = langMatch[1].split("-")[0].toLowerCase();

    const languageNames: Record<string, string> = {
      en: "English",
      fr: "French",
      de: "German",
      es: "Spanish",
      it: "Italian",
      nl: "Dutch",
      pt: "Portuguese",
      ru: "Russian",
      zh: "Chinese",
      ja: "Japanese",
      ko: "Korean",
      ar: "Arabic",
      hi: "Hindi",
      tr: "Turkish",
      pl: "Polish",
      sv: "Swedish",
      da: "Danish",
      no: "Norwegian",
      fi: "Finnish",
      el: "Greek",
      th: "Thai",
      vi: "Vietnamese",
      id: "Indonesian",
    };

    return languageNames[language] || language;
  }

  const countryCode = Object.entries(COUNTRIES).find(
    ([, name]) => name === country,
  )?.[0];

  if (countryCode && LANGUAGE_BY_COUNTRY[countryCode]) {
    return LANGUAGE_BY_COUNTRY[countryCode];
  }

  return "Unknown";
}

// --------------------------------------------
// SCANNING A SINGLE WEBSITE
// --------------------------------------------

async function scanWebsite(
  input: string,
  signal?: AbortSignal,
): Promise<Outcome> {
  if (signal?.aborted) {
    return {
      results: [],
      status: "error",
      hostname: input,
      reason: "Scan cancelled",
    };
  }

  let baseUrl: URL;

  try {
    const normalized = input.includes("://")
      ? input
      : `https://${input}`;

    baseUrl = new URL(normalized);
  } catch {
    return {
      results: [],
      status: "error",
      hostname: input,
      reason: "Invalid website URL",
    };
  }

  if (
    baseUrl.protocol !== "http:" &&
    baseUrl.protocol !== "https:"
  ) {
    return {
      results: [],
      status: "error",
      hostname: input,
      reason: "Unsupported website protocol",
    };
  }

  if (baseUrl.username || baseUrl.password) {
    return {
      results: [],
      status: "error",
      hostname: input,
      reason: "Website URL credentials are not allowed",
    };
  }

  if (baseUrl.port) {
    if (baseUrl.protocol === "http:" && baseUrl.port !== "80") {
      return {
        results: [],
        status: "error",
        hostname: input,
        reason: "Non-standard ports are not allowed",
      };
    }

    if (baseUrl.protocol === "https:" && baseUrl.port !== "443") {
      return {
        results: [],
        status: "error",
        hostname: input,
        reason: "Non-standard ports are not allowed",
      };
    }
  }

  const hostname = cleanHostname(baseUrl.hostname);

  if (!hostname) {
    return {
      results: [],
      status: "error",
      hostname: input,
      reason: "Invalid hostname",
    };
  }

  const isSafeHost = createHostValidator();

  if (signal?.aborted) {
    return {
      results: [],
      status: "error",
      hostname,
      reason: "Scan cancelled",
    };
  }

  if (!(await isSafeHost(hostname))) {
    return {
      results: [],
      status: "blocked",
      hostname,
      reason: "Website hostname did not resolve to a public address",
    };
  }

  // Try HTTPS first. If it is unreachable, try HTTP.
  let homepage = await fetchPublicText(
    baseUrl.toString(),
    hostname,
    MAX_HTML_SIZE,
    isSafeHost,
    signal,
  );

  if (
    (homepage.status === "unreachable" ||
      homepage.status === "error") &&
    !signal?.aborted
  ) {
    if (baseUrl.protocol === "https:") {
      const httpUrl = new URL(baseUrl.toString());
      httpUrl.protocol = "http:";
      httpUrl.port = "";

      const httpHomepage = await fetchPublicText(
        httpUrl.toString(),
        hostname,
        MAX_HTML_SIZE,
        isSafeHost,
        signal,
      );

      if (httpHomepage.status === "ok") {
        homepage = httpHomepage;
      }
    }
  }

  if (homepage.status !== "ok") {
    return {
      results: [],
      status:
        homepage.status === "forbidden" ||
        homepage.status === "rate_limited"
          ? "blocked"
          : "error",
      hostname,
      reason: `Homepage request failed: ${homepage.status}`,
    };
  }

  const homepageUrl = new URL(homepage.url);
  const robotsResult = await fetchPublicText(
    new URL("/robots.txt", homepageUrl).toString(),
    hostname,
    100_000,
    isSafeHost,
    signal,
  );

  let robotsRules: RobotsRule[] = [];

  if (robotsResult.status === "ok") {
    robotsRules = parseRobotsTxt(robotsResult.text).rules;
  }

  const sitemapUrls = await discoverSitemaps(
    homepageUrl,
    hostname,
    isSafeHost,
    signal,
  );

  const contactLinks = extractPageLinks(
    homepage.text,
    homepageUrl,
    hostname,
  );

  const candidatePages = new Set<string>([
    ...contactLinks,
    ...sitemapUrls.filter((url) => {
      try {
        const path = new URL(url).pathname.toLowerCase();

        return CONTACT_KEYWORDS.some((keyword) =>
          path.includes(keyword),
        );
      } catch {
        return false;
      }
    }),
  ]);

  const selectedPages = Array.from(candidatePages)
    .filter((url) => {
      try {
        return isAllowedByRobots(
          new URL(url).pathname,
          robotsRules,
        );
      } catch {
        return false;
      }
    })
    .slice(0, MAX_CONTACT_PAGES);

  const pagesToScan = [
    {
      url: homepage.url,
      html: homepage.text,
    },
  ];

  const pageResults = await runWithConcurrency(
    selectedPages,
    PAGE_CONCURRENCY,
    async (url) => {
      const result = await fetchPublicText(
        url,
        hostname,
        MAX_HTML_SIZE,
        isSafeHost,
        signal,
      );

      if (result.status === "ok") {
        pagesToScan.push({
          url: result.url,
          html: result.text,
        });
      }
    },
  );

  void pageResults;

  const country = extractCountry(
    hostname,
    homepage.text,
    homepage.url,
  );

  const language = extractLanguage(
    homepage.text,
    country,
  );

  const results = new Map<string, Result>();

  for (const page of pagesToScan) {
    const emails = extractEmails(page.html);

    let pathname = "/";

    try {
      pathname = new URL(page.url).pathname || "/";
    } catch {
      // Keep default path.
    }

    for (const email of emails) {
      if (!results.has(email)) {
        results.set(email, {
          email,
          site: hostname,
          path: pathname,
          country,
          language,
        });
      }
    }
  }

  const finalResults = Array.from(results.values());

  return {
    results: finalResults,
    status: finalResults.length ? "success" : "no_email",
    hostname,
  };
}

// --------------------------------------------
// CONCURRENCY HELPER
// --------------------------------------------

async function runWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  const workers = Array.from(
    {
      length: Math.min(concurrency, items.length),
    },
    async () => {
      while (true) {
        const index = nextIndex++;

        if (index >= items.length) return;

        try {
          results[index] = await worker(items[index], index);
        } catch {
          // Keep the scanner running if one worker fails.
        }
      }
    },
  );

  await Promise.all(workers);

  return results;
}

// --------------------------------------------
// INPUT NORMALIZATION
// --------------------------------------------

function normalizeDomain(value: string): string | null {
  const raw = value.trim();

  if (!raw) return null;

  let parsed: URL;

  try {
    parsed = new URL(
      raw.includes("://") ? raw : `https://${raw}`,
    );
  } catch {
    return null;
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:"
  ) {
    return null;
  }

  if (parsed.username || parsed.password) return null;

  if (parsed.port) {
    if (parsed.protocol === "http:" && parsed.port !== "80") {
      return null;
    }

    if (parsed.protocol === "https:" && parsed.port !== "443") {
      return null;
    }
  }

  const hostname = cleanHostname(parsed.hostname);

  if (
    !hostname ||
    hostname === "localhost" ||
    hostname.endsWith(".localhost")
  ) {
    return null;
  }

  return hostname;
}

function parseInputDomains(body: unknown): string[] {
  if (!body || typeof body !== "object") return [];

  const data = body as Record<string, unknown>;

  const possibleInputs = [
    data.domains,
    data.urls,
    data.websites,
    data.input,
    data.text,
  ];

  let rawValues: string[] = [];

  for (const value of possibleInputs) {
    if (Array.isArray(value)) {
      rawValues = value.filter(
        (item): item is string => typeof item === "string",
      );
      break;
    }

    if (typeof value === "string") {
      rawValues = value.split(/[\r\n,\s]+/);
      break;
    }
  }

  const unique = new Set<string>();

  for (const value of rawValues) {
    const domain = normalizeDomain(value);

    if (domain) {
      unique.add(domain);
    }

    // Keep one extra value so the request handler can reject oversized input
    // instead of silently truncating it to the maximum.
    if (unique.size > MAX_DOMAINS) break;
  }

  return Array.from(unique);
}

// --------------------------------------------
// STREAMING RESPONSE
// --------------------------------------------

function createNDJSONStream(
  domains: string[],
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const abortController = new AbortController();
  let cancelled = false;

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      let completed = 0;
      let totalEmails = 0;

      const emit = (data: Record<string, unknown>) => {
        if (cancelled) return;

        controller.enqueue(
          encoder.encode(`${JSON.stringify(data)}\n`),
        );
      };

      emit({
        type: "start",
        total: domains.length,
      });

      await runWithConcurrency(
        domains,
        SITE_CONCURRENCY,
        async (domain) => {
          let outcome: Outcome;

          try {
            outcome = await scanWebsite(domain, abortController.signal);
          } catch (error) {
            outcome = {
              results: [],
              status: "error",
              hostname: domain,
              reason:
                error instanceof Error
                  ? error.message
                  : "Unexpected scan error",
            };
          }

          completed += 1;
          totalEmails += outcome.results.length;

          emit({
            type: "result",
            domain,
            hostname: outcome.hostname,
            status: outcome.status,
            reason: outcome.reason,
            results: outcome.results,
            completed,
            total: domains.length,
            totalEmails,
          });
        },
      );

      if (!cancelled) {
        emit({
          type: "complete",
          completed,
          total: domains.length,
          totalEmails,
        });

        controller.close();
      }
    },

    cancel() {
      cancelled = true;
      abortController.abort();
    },
  });
}

// --------------------------------------------
// API ROUTE
// --------------------------------------------

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    const contentLength = Number(request.headers.get("content-length") || 0);

    if (contentLength > MAX_REQUEST_BYTES) {
      return Response.json(
        {
          error: "The request body is too large.",
        },
        {
          status: 413,
        },
      );
    }

    const rawBody = await request.text();

    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return Response.json(
        {
          error: "The request body is too large.",
        },
        {
          status: 413,
        },
      );
    }

    body = JSON.parse(rawBody) as unknown;
  } catch {
    return Response.json(
      {
        error: "Invalid JSON request body",
      },
      {
        status: 400,
      },
    );
  }

  const domains = parseInputDomains(body);

  if (!domains.length) {
    return Response.json(
      {
        error: "Please provide at least one valid website domain",
      },
      {
        status: 400,
      },
    );
  }

  if (domains.length > MAX_DOMAINS) {
    return Response.json(
      {
        error: `You can scan a maximum of ${MAX_DOMAINS} websites per request`,
      },
      {
        status: 400,
      },
    );
  }

  return new Response(createNDJSONStream(domains), {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
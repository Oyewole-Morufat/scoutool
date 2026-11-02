import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const maxDuration = 300;

// Discovery-first configuration
const MAX_DOMAINS = 1000;
const SITE_CONCURRENCY = 8;
const PAGE_CONCURRENCY = 4;
const MAX_CONTACT_PAGES = 10;
const REQUEST_TIMEOUT = 9000;
const MAX_HTML_SIZE = 1_000_000;
const MAX_SITEMAP_SIZE = 400_000;

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
};

type FetchResult =
  | { status: "ok"; text: string; url: string }
  | { status: "blocked"; url: string }
  | { status: "missing" | "error"; url: string };

type RobotsRule = {
  allow: boolean;
  path: string;
};

type RobotsData = {
  rules: RobotsRule[];
  sitemaps: string[];
  blocked: boolean;
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
  ie: "Ireland",
  in: "India",
  nz: "New Zealand",
  br: "Brazil",
  mx: "Mexico",
  sg: "Singapore",
  jp: "Japan",
  sa: "Saudi Arabia",
  qa: "Qatar",
  kw: "Kuwait",
  om: "Oman",
  bh: "Bahrain",
  eg: "Egypt",
  tr: "Turkey",
  pt: "Portugal",
  ch: "Switzerland",
  at: "Austria",
  se: "Sweden",
  no: "Norway",
  dk: "Denmark",
  fi: "Finland",
  pl: "Poland",
  gr: "Greece",
  eu: "Europe",
};

const LANGUAGES: Record<string, string> = {
  en: "English",
  ar: "Arabic",
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
  tr: "Turkish",
  hi: "Hindi",
  ur: "Urdu",
  sw: "Swahili",
  pl: "Polish",
  sv: "Swedish",
  da: "Danish",
  no: "Norwegian",
  fi: "Finnish",
};

// Common business contact pages in different languages.
const CONTACT_PATHS = [
  // Shopify
  "/policies/contact-information",
  "/pages/contact",
  "/pages/contact-us",
  "/pages/contacto",
  "/pages/informacion-de-contacto",
  "/pages/aviso-legal",
  "/policies/privacy-policy",

  // English
  "/contact",
  "/contact-us",
  "/contact.html",
  "/about",
  "/about-us",
  "/support",
  "/help",
  "/customer-service",
  "/customer-support",
  "/company",
  "/team",
  "/imprint",

  // Spanish
  "/contacto",
  "/contactanos",
  "/contactenos",
  "/sobre-nosotros",
  "/quienes-somos",
  "/aviso-legal",
  "/atencion-al-cliente",
  "/ayuda",
  "/empresa",
  "/pages/sobre-nosotros",
  "/pages/ayuda",
  "/informacion-de-contacto",

  // French
  "/contactez-nous",
  "/nous-contacter",
  "/a-propos",
  "/mentions-legales",

  // German
  "/kontakt",
  "/impressum",
  "/uber-uns",
  "/kundenservice",
  "/pages/impressum",

  // Italian
  "/contatti",
  "/chi-siamo",
  "/assistenza",

  // Portuguese
  "/contato",
  "/sobre-nos",
  "/quem-somos",

  // Dutch
  "/over-ons",
];

const RELEVANT_PATH =
  /(contact|contacto|contactanos|contactenos|about|sobre|nosotros|quienes|support|help|ayuda|kontakt|impressum|contatti|contato|contacter|contactez|empresa|company|team|customer|cliente|aviso-legal|informacion-de-contacto|privacy|privacidad|legal|imprint|atencion)/i;

// Known domain suffixes used to reject common image extensions
// and obvious example addresses.
const VALID_TLDS = new Set([
  "com", "org", "net", "edu", "gov", "mil", "int",
  "info", "biz", "name", "pro", "co", "io", "ai",
  "app", "dev", "shop", "store", "online", "site",
  "website", "xyz", "tech", "agency", "me", "us",
  "uk", "es", "de", "fr", "it", "nl", "be", "ie",
  "in", "au", "ca", "nz", "br", "mx", "sg", "jp",
  "sa", "qa", "kw", "om", "bh", "eg", "tr", "pt",
  "ch", "at", "se", "no", "dk", "fi", "pl", "gr",
  "eu", "cat", "tv", "cc", "cloud", "design",
  "digital", "group", "life", "world", "solutions",
  "marketing", "consulting", "technology", "email",
  "network", "services", "finance", "center",
  "company", "systems", "land", "space", "store",
]);

const PLACEHOLDER_DOMAINS = new Set([
  "example.com",
  "example.org",
  "example.es",
  "ejemplo.com",
  "ejemplo.es",
  "email.com",
  "correo.com",
  "yourdomain.com",
  "yourcompany.com",
  "votre-domaine.com",
  "domain.com",
  "company.com",
]);

const PLACEHOLDER_NAMES = new Set([
  "example",
  "test",
  "demo",
  "sample",
  "nombre",
  "tu",
  "email",
  "yourname",
  "your-email",
  "su-email",
  "usuario",
  "correo",
]);

// --------------------------------------------
// HOST AND URL VALIDATION
// --------------------------------------------

function isPublicIPv4(address: string): boolean {
  const parts = address.split(".").map(Number);

  if (
    parts.length !== 4 ||
    parts.some(
      (part) =>
        !Number.isInteger(part) ||
        part < 0 ||
        part > 255,
    )
  ) {
    return false;
  }

  const [a, b, c] = parts;

  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    a >= 224 ||
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

async function checkHost(hostname: string): Promise<boolean> {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "");

  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local")
  ) {
    return false;
  }

  if (isIP(host) === 4) {
    return isPublicIPv4(host);
  }

  if (isIP(host) === 6) {
    return false;
  }

  try {
    const addresses = await lookup(host, {
      family: 4,
      all: true,
    });

    return (
      addresses.length > 0 &&
      addresses.every((item) =>
        isPublicIPv4(item.address),
      )
    );
  } catch {
    return false;
  }
}

function createHostValidator() {
  const cache = new Map<string, Promise<boolean>>();

  return (hostname: string): Promise<boolean> => {
    const key = hostname.toLowerCase();

    if (!cache.has(key)) {
      cache.set(key, checkHost(key));
    }

    return cache.get(key)!;
  };
}

function normalizeUrl(value: string): string | null {
  let input = value.trim();

  if (!input) return null;

  if (!/^https?:\/\//i.test(input)) {
    input = `https://${input}`;
  }

  try {
    const url = new URL(input);

    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.username ||
      url.password
    ) {
      return null;
    }

    return url.toString();
  } catch {
    return null;
  }
}

function sameSiteHost(a: string, b: string): boolean {
  const first = a.toLowerCase().replace(/^www\./, "");
  const second = b.toLowerCase().replace(/^www\./, "");

  return (
    first === second ||
    first.endsWith(`.${second}`) ||
    second.endsWith(`.${first}`)
  );
}

// --------------------------------------------
// LIMITED PAGE FETCHING
// --------------------------------------------

async function readLimitedText(
  response: Response,
  maxBytes: number,
): Promise<string | null> {
  if (!response.body) return null;

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) break;

      total += value.length;

      if (total > maxBytes) {
        await reader.cancel();
        return null;
      }

      chunks.push(value);
    }

    const combined = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      combined.set(chunk, offset);
      offset += chunk.length;
    }

    return new TextDecoder().decode(combined);
  } catch {
    await reader.cancel().catch(() => {});
    return null;
  }
}

async function fetchPublicText(
  inputUrl: string,
  hostname: string,
  maxBytes: number,
  isSafeHost: (hostname: string) => Promise<boolean>,
): Promise<FetchResult> {
  let currentUrl = inputUrl;

  for (let redirect = 0; redirect < 4; redirect++) {
    let url: URL;

    try {
      url = new URL(currentUrl);
    } catch {
      return { status: "error", url: currentUrl };
    }

    if (
      !["http:", "https:"].includes(url.protocol) ||
      !sameSiteHost(url.hostname, hostname) ||
      !(await isSafeHost(url.hostname))
    ) {
      return { status: "error", url: currentUrl };
    }

    try {
      const response = await fetch(currentUrl, {
        redirect: "manual",
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        headers: {
          "User-Agent": "ScoutoolPublicContactResearch/1.0",
          Accept: "text/html, text/plain, application/xml, text/xml",
        },
      });

      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");

        if (!location) {
          return { status: "error", url: currentUrl };
        }

        currentUrl = new URL(location, currentUrl).toString();
        continue;
      }

      if (
        [401, 403, 429, 503].includes(response.status)
      ) {
        return { status: "blocked", url: currentUrl };
      }

      if ([404, 410].includes(response.status)) {
        return { status: "missing", url: currentUrl };
      }

      if (!response.ok) {
        return { status: "error", url: currentUrl };
      }

      const contentType = (
        response.headers.get("content-type") || ""
      ).toLowerCase();

      if (
        contentType &&
        !contentType.includes("text/html") &&
        !contentType.includes("text/plain") &&
        !contentType.includes("xml")
      ) {
        return { status: "missing", url: currentUrl };
      }

      const length = Number(
        response.headers.get("content-length") || 0,
      );

      if (length > maxBytes) {
        return { status: "error", url: currentUrl };
      }

      const text = await readLimitedText(response, maxBytes);

      if (text === null) {
        return { status: "error", url: currentUrl };
      }

      return {
        status: "ok",
        text,
        url: currentUrl,
      };
    } catch {
      return { status: "error", url: currentUrl };
    }
  }

  return { status: "error", url: currentUrl };
}

// --------------------------------------------
// ROBOTS.TXT
// --------------------------------------------

function parseRobots(text: string): RobotsData {
  const rules: RobotsRule[] = [];
  const sitemaps: string[] = [];

  let agents: string[] = [];
  let groupRules: RobotsRule[] = [];

  function saveGroup() {
    const appliesToScoutool = agents.some(
      (agent) =>
        agent === "*" ||
        agent.includes("scoutool"),
    );

    if (appliesToScoutool) {
      rules.push(...groupRules);
    }

    agents = [];
    groupRules = [];
  }

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.split("#")[0].trim();

    if (!line) continue;

    const index = line.indexOf(":");
    if (index < 0) continue;

    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();

    if (key === "sitemap") {
      if (value) sitemaps.push(value);
      continue;
    }

    if (key === "user-agent") {
      if (groupRules.length > 0) {
        saveGroup();
      }

      agents.push(value.toLowerCase());
      continue;
    }

    if (
      (key === "allow" || key === "disallow") &&
      agents.length > 0 &&
      value
    ) {
      groupRules.push({
        allow: key === "allow",
        path: value,
      });
    }
  }

  saveGroup();

  return {
    rules,
    sitemaps: [...new Set(sitemaps)],
    blocked: false,
  };
}

function robotsAllows(
  pathname: string,
  rules: RobotsRule[],
): boolean {
  let best: RobotsRule | null = null;
  let bestLength = -1;

  for (const rule of rules) {
    const pattern = rule.path.replace(/\*$/, "");

    if (!pathname.startsWith(pattern)) continue;

    if (pattern.length > bestLength) {
      best = rule;
      bestLength = pattern.length;
    } else if (
      pattern.length === bestLength &&
      rule.allow
    ) {
      best = rule;
    }
  }

  return best?.allow ?? true;
}

async function fetchRobots(
  origin: string,
  hostname: string,
  isSafeHost: (hostname: string) => Promise<boolean>,
): Promise<RobotsData> {
  const result = await fetchPublicText(
    new URL("/robots.txt", origin).toString(),
    hostname,
    100_000,
    isSafeHost,
  );

  if (result.status === "blocked") {
    return {
      rules: [],
      sitemaps: [],
      blocked: true,
    };
  }

  if (result.status === "ok") {
    return parseRobots(result.text);
  }

  return {
    rules: [],
    sitemaps: [],
    blocked: false,
  };
}

// --------------------------------------------
// EMAIL EXTRACTION
// --------------------------------------------

function decodeHtml(value: string): string {
  return value
    .replace(/&commat;/gi, "@")
    .replace(/&#64;/g, "@")
    .replace(/&#x40;/gi, "@")
    .replace(/&period;/gi, ".")
    .replace(/&#46;/g, ".")
    .replace(/&#x2e;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, code) => {
      const number = code.toLowerCase().startsWith("x")
        ? parseInt(code.slice(1), 16)
        : parseInt(code, 10);

      try {
        return Number.isFinite(number)
          ? String.fromCodePoint(number)
          : "";
      } catch {
        return "";
      }
    });
}

function isValidBusinessEmail(value: string): boolean {
  const email = value.trim().toLowerCase();
  const parts = email.split("@");

  if (parts.length !== 2) return false;

  const [local, domain] = parts;
  const tld = domain.split(".").pop() || "";

  if (
    !local ||
    !domain ||
    local.startsWith(".") ||
    local.endsWith(".") ||
    local.startsWith("-") ||
    local.endsWith("-") ||
    local.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  if (!VALID_TLDS.has(tld)) return false;

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
    /^(gemini_generated_image|logo|image|thumbnail|icon)[_.-]/i.test(
      local,
    )
  ) {
    return false;
  }

  return true;
}

function extractEmails(html: string): string[] {
  const decoded = decodeHtml(html);

  // Preserve JSON-LD before removing scripts.
  const jsonLdBlocks = [
    ...decoded.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((match) => match[1]);

  // Remove styles, image elements, scripts and comments
  // to avoid treating image filenames as email addresses.
  const visible = decoded
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<img\b[^>]*>/gi, " ")
    .replace(/<picture\b[\s\S]*?<\/picture>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");

  const direct =
    visible.match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b/g,
    ) || [];

  const mailto = [
    ...decoded.matchAll(/mailto:([^"'?\s<>]+)/gi),
  ].map((match) => {
    try {
      return decodeURIComponent(match[1].split("?")[0]);
    } catch {
      return "";
    }
  });

  // Common publicly visible email obfuscations.
  const atPattern =
    String.raw`(?:\[at\]|\(at\)|\{at\}|\bat\b|\[arroba\]|\(arroba\)|\barroba\b)`;

  const dotPattern =
    String.raw`(?:\[dot\]|\(dot\)|\bdot\b|\[punto\]|\(punto\)|\bpunto\b)`;

  const obfuscatedPattern = new RegExp(
    String.raw`([a-zA-Z0-9._%+-]+)\s*${atPattern}\s*([a-zA-Z0-9.-]+)\s*${dotPattern}\s*([a-zA-Z]{2,24})`,
    "gi",
  );

  const obfuscated = [
    ...visible.matchAll(obfuscatedPattern),
  ].map((match) =>
    `${match[1]}@${match[2]}.${match[3]}`,
  );

  const structured =
    jsonLdBlocks.join(" ").match(
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,24}\b/g,
    ) || [];

  return [
    ...new Set(
      [...direct, ...mailto, ...obfuscated, ...structured]
        .map((email) => email.trim().toLowerCase())
        .filter(isValidBusinessEmail),
    ),
  ];
}

// --------------------------------------------
// COUNTRY AND LANGUAGE
// --------------------------------------------

function detectCountry(
  hostname: string,
  html: string,
): string {
  const match = html.match(
    /"addressCountry"\s*:\s*"([A-Z]{2})"/i,
  );

  if (match) {
    const found = Object.entries(COUNTRIES).find(
      ([code]) =>
        code.toUpperCase() === match[1].toUpperCase(),
    );

    if (found) return found[1];
  }

  const extension =
    hostname.split(".").pop()?.toLowerCase() || "";

  return COUNTRIES[extension] || "Unknown";
}

function detectLanguage(html: string): string {
  const match =
    html.match(/<html[^>]*\blang=["']([^"']+)["']/i) ||
    html.match(
      /<meta[^>]+name=["']content-language["'][^>]+content=["']([^"']+)/i,
    );

  if (match?.[1]) {
    const code = match[1].split(/[-_]/)[0].toLowerCase();

    return LANGUAGES[code] || "Unknown";
  }

  return "Unknown";
}

// --------------------------------------------
// CONTACT LINKS
// --------------------------------------------

function findContactLinks(
  html: string,
  baseUrl: string,
): string[] {
  const links = [
    ...html.matchAll(
      /<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi,
    ),
  ];

  const found = new Set<string>();

  for (const match of links) {
    const href = decodeHtml(match[1]);
    const label = match[2].replace(/<[^>]+>/g, " ");

    if (!RELEVANT_PATH.test(`${href} ${label}`)) {
      continue;
    }

    try {
      const base = new URL(baseUrl);
      const url = new URL(href, baseUrl);

      if (
        url.origin === base.origin &&
        ["http:", "https:"].includes(url.protocol)
      ) {
        url.hash = "";
        found.add(url.toString());
      }
    } catch {
      // Ignore invalid links.
    }
  }

  return [...found];
}

// --------------------------------------------
// SITEMAP DISCOVERY
// --------------------------------------------

function extractSitemapLocations(xml: string): string[] {
  return [
    ...xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi),
  ]
    .map((match) =>
      match[1].trim().replace(/&amp;/g, "&"),
    )
    .filter(Boolean);
}

async function discoverSitemapPages(
  origin: string,
  hostname: string,
  sitemapUrls: string[],
  rules: RobotsRule[],
  isSafeHost: (hostname: string) => Promise<boolean>,
): Promise<string[]> {
  const sitemapCandidates = new Set([
    ...sitemapUrls,
    new URL("/sitemap.xml", origin).toString(),
    new URL("/sitemap_index.xml", origin).toString(),
  ]);

  const safeSitemaps = [...sitemapCandidates]
    .filter((item) => {
      try {
        const url = new URL(item);

        return (
          sameSiteHost(url.hostname, hostname) &&
          robotsAllows(url.pathname, rules)
        );
      } catch {
        return false;
      }
    })
    .slice(0, 3);

  const firstResults = await Promise.all(
    safeSitemaps.map((url) =>
      fetchPublicText(
        url,
        hostname,
        MAX_SITEMAP_SIZE,
        isSafeHost,
      ),
    ),
  );

  const pages = new Set<string>();
  const nestedSitemaps = new Set<string>();

  function processLocations(xml: string) {
    for (const location of extractSitemapLocations(xml)) {
      try {
        const url = new URL(location);

        if (!sameSiteHost(url.hostname, hostname)) {
          continue;
        }

        if (
          /\.xml$/i.test(url.pathname) ||
          /sitemap/i.test(url.pathname)
        ) {
          nestedSitemaps.add(url.toString());
          continue;
        }

        if (
          !RELEVANT_PATH.test(url.pathname) ||
          !robotsAllows(url.pathname, rules)
        ) {
          continue;
        }

        url.hash = "";
        pages.add(url.toString());
      } catch {
        // Ignore invalid entries.
      }
    }
  }

  for (const result of firstResults) {
    if (result.status === "ok") {
      processLocations(result.text);
    }
  }

  const nested = [...nestedSitemaps]
    .sort((a, b) => {
      const aScore = /(pages|blog|index)/i.test(a) ? 1 : 0;
      const bScore = /(pages|blog|index)/i.test(b) ? 1 : 0;

      return bScore - aScore;
    })
    .slice(0, 2);

  const nestedResults = await Promise.all(
    nested.map((url) =>
      fetchPublicText(
        url,
        hostname,
        MAX_SITEMAP_SIZE,
        isSafeHost,
      ),
    ),
  );

  for (const result of nestedResults) {
    if (result.status === "ok") {
      processLocations(result.text);
    }
  }

  return [...pages].sort((a, b) => {
    const score = (url: string) => {
      if (/(contact|contacto|kontakt|contatti|contato)/i.test(url)) return 3;
      if (/(about|sobre|nosotros|company|empresa)/i.test(url)) return 2;
      if (/(privacy|legal|impressum|imprint)/i.test(url)) return 1;
      return 0;
    };

    return score(b) - score(a);
  });
}

// --------------------------------------------
// LIMITED PAGE CONCURRENCY
// --------------------------------------------

async function mapLimit<T, R>(
  items: T[],
  limit: number,
  callback: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const index = nextIndex++;

      if (index >= items.length) return;

      results[index] = await callback(items[index]);
    }
  }

  await Promise.all(
    Array.from(
      { length: Math.min(limit, items.length) },
      () => worker(),
    ),
  );

  return results;
}

// --------------------------------------------
// MAIN WEBSITE SCAN
// --------------------------------------------

async function scanWebsite(site: string): Promise<Outcome> {
  const normalized = normalizeUrl(site);

  if (!normalized) {
    return {
      results: [],
      status: "error",
      hostname: site,
    };
  }

  const base = new URL(normalized);
  const hostname = base.hostname;
  const origin = base.origin;
  const isSafeHost = createHostValidator();

  if (!(await isSafeHost(hostname))) {
    return {
      results: [],
      status: "error",
      hostname,
    };
  }

  // Check the homepage and robots file together.
  const [homepage, robots] = await Promise.all([
    fetchPublicText(
      base.toString(),
      hostname,
      MAX_HTML_SIZE,
      isSafeHost,
    ),
    fetchRobots(
      origin,
      hostname,
      isSafeHost,
    ),
  ]);

  if (homepage.status === "blocked") {
    return {
      results: [],
      status: "blocked",
      hostname,
    };
  }

  if (robots.blocked) {
    return {
      results: [],
      status: "blocked",
      hostname,
    };
  }

  const homepageHtml =
    homepage.status === "ok" ? homepage.text : "";

  const homeLinks = homepageHtml
    ? findContactLinks(homepageHtml, base.toString())
    : [];

  // Search sitemap and homepage links together.
  const sitemapPages = await discoverSitemapPages(
    origin,
    hostname,
    robots.sitemaps,
    robots.rules,
    isSafeHost,
  );

  const extension =
    hostname.split(".").pop()?.toLowerCase() || "";

  const localizedPaths: Record<string, string[]> = {
    es: [
      "/pages/informacion-de-contacto",
      "/pages/aviso-legal",
      "/pages/sobre-nosotros",
      "/contacto",
      "/atencion-al-cliente",
      "/ayuda",
    ],
    de: [
      "/kontakt",
      "/impressum",
      "/pages/impressum",
    ],
    fr: [
      "/contactez-nous",
      "/nous-contacter",
      "/mentions-legales",
    ],
    it: [
      "/contatti",
      "/chi-siamo",
    ],
    pt: [
      "/contato",
      "/sobre-nos",
    ],
    nl: [
      "/over-ons",
    ],
  };

  const localizedUrls = (
    localizedPaths[extension] || []
  ).map((path) =>
    new URL(path, origin).toString(),
  );

  // Prioritize real links and sitemap discoveries.
  const allCandidates = [
    ...homeLinks,
    ...sitemapPages,
    ...localizedUrls,
    ...CONTACT_PATHS.map((path) =>
      new URL(path, origin).toString(),
    ),
  ];

  const candidates = [
    ...new Set(allCandidates),
  ].filter((item) => {
    try {
      const url = new URL(item);

      return (
        url.origin === origin &&
        item !== base.toString() &&
        robotsAllows(url.pathname, robots.rules)
      );
    } catch {
      return false;
    }
  });

  // Do not stop merely because the homepage has an email.
  // Other pages may contain another legitimate business contact.
  const selectedPages = candidates.slice(
    0,
    MAX_CONTACT_PAGES,
  );

  // Crawl up to four pages at once for each website.
  const pageResults = await mapLimit(
    selectedPages,
    PAGE_CONCURRENCY,
    (page) =>
      fetchPublicText(
        page,
        hostname,
        MAX_HTML_SIZE,
        isSafeHost,
      ),
  );

  const successfulPages: Array<{
    text: string;
    url: string;
  }> = [];

  if (homepage.status === "ok") {
    successfulPages.push({
      text: homepage.text,
      url: homepage.url,
    });
  }

  for (const result of pageResults) {
    if (result.status === "ok") {
      successfulPages.push({
        text: result.text,
        url: result.url,
      });
    }
  }

  const combinedHtml = successfulPages
    .map((page) => page.text)
    .join(" ");

  const country = detectCountry(
    hostname,
    combinedHtml,
  );

  const language = detectLanguage(
    homepageHtml || combinedHtml,
  );

  const results = new Map<string, Result>();

  for (const page of successfulPages) {
    const path = new URL(page.url).pathname || "/";

    for (const email of extractEmails(page.text)) {
      if (!results.has(email)) {
        results.set(email, {
          email,
          site: hostname,
          path,
          country,
          language,
        });
      }
    }
  }

  const found = [...results.values()];

  const anyBlocked = pageResults.some(
    (page) => page.status === "blocked",
  );

  let status: Status;

  if (found.length > 0) {
    status = "success";
  } else if (anyBlocked) {
    status = "blocked";
  } else if (successfulPages.length === 0) {
    status = "error";
  } else {
    status = "no_email";
  }

  return {
    results: found,
    status,
    hostname,
  };
}

// --------------------------------------------
// STREAMING API
// --------------------------------------------

export async function POST(request: NextRequest) {
  let body: { domains?: unknown };

  try {
    body = await request.json();
  } catch {
    return Response.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  if (!Array.isArray(body.domains)) {
    return Response.json(
      { error: "Please provide a list of websites." },
      { status: 400 },
    );
  }

  const domains = body.domains
    .filter(
      (item): item is string =>
        typeof item === "string",
    )
    .map((item) => item.trim())
    .filter(Boolean);

  if (domains.length === 0) {
    return Response.json(
      { error: "Enter at least one website." },
      { status: 400 },
    );
  }

  if (domains.length > MAX_DOMAINS) {
    return Response.json(
      {
        error: `Maximum ${MAX_DOMAINS} websites per run.`,
      },
      { status: 400 },
    );
  }

  const stream = new ReadableStream({
    async start(controller) {
      const encoder = new TextEncoder();

      let nextIndex = 0;
      let processed = 0;
      let successful = 0;
      let errors = 0;
      let blocked = 0;
      let noEmail = 0;
      let emailsFound = 0;

      const seenEmails = new Set<string>();

      function send(event: Record<string, unknown>) {
        controller.enqueue(
          encoder.encode(JSON.stringify(event) + "\n"),
        );
      }

      function sendUniqueResults(results: Result[]) {
        for (const result of results) {
          const email = result.email.toLowerCase();

          if (seenEmails.has(email)) continue;

          seenEmails.add(email);
          emailsFound++;

          send({
            type: "result",
            result,
          });
        }
      }

      function sendProgress(currentSite = "") {
        send({
          type: "progress",
          processed,
          total: domains.length,
          successful,
          errors,
          blocked,
          noEmail,
          emailsFound,
          currentSite,
        });
      }

      send({
        type: "start",
        total: domains.length,
      });

      async function worker() {
        while (true) {
          const index = nextIndex++;

          if (index >= domains.length) {
            return;
          }

          const domain = domains[index];
          let outcome: Outcome;

          try {
            outcome = await scanWebsite(domain);
          } catch (error) {
            console.error(
              "[Scoutool] Scan failed:",
              domain,
              error instanceof Error
                ? error.message
                : "Unknown error",
            );

            outcome = {
              results: [],
              status: "error",
              hostname: domain,
            };
          }

          processed++;

          if (outcome.status === "success") {
            successful++;
          } else if (outcome.status === "blocked") {
            blocked++;
          } else if (outcome.status === "no_email") {
            noEmail++;
          } else {
            errors++;
          }

          sendUniqueResults(outcome.results);
          sendProgress(domain);
        }
      }

      try {
        const workers = Array.from(
          {
            length: Math.min(
              SITE_CONCURRENCY,
              domains.length,
            ),
          },
          () => worker(),
        );

        await Promise.all(workers);

        send({
          type: "done",
          processed,
          successful,
          errors,
          blocked,
          noEmail,
          emailsFound,
        });
      } catch (error) {
        console.error(
          "[Scoutool] Scan interrupted:",
          error instanceof Error
            ? error.message
            : "Unknown error",
        );

        send({
          type: "error",
          message: "The scanning process was interrupted.",
        });
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
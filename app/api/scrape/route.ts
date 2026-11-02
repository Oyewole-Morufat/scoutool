import { NextRequest } from "next/server";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

export const maxDuration = 300;

// Scanner settings
const MAX_DOMAINS = 1000;
const SITE_CONCURRENCY = 8;
const PAGE_CONCURRENCY = 4;
const MAX_CONTACT_PAGES = 10;
const REQUEST_TIMEOUT = 9000;
const MAX_HTML_SIZE = 1_000_000;
const MAX_SITEMAP_SIZE = 400_000;

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

const CONTACT_PATHS = [
  "/policies/contact-information",
  "/pages/contact",
  "/pages/contact-us",
  "/pages/contacto",
  "/pages/informacion-de-contacto",
  "/pages/aviso-legal",
  "/pages/sobre-nosotros",
  "/pages/politica-de-privacidad",
  "/policies/privacy-policy",
  "/policies/legal-notice",
  "/policies/terms-of-service",
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
  "/privacy-policy",
  "/contacto",
  "/contactanos",
  "/contactenos",
  "/sobre-nosotros",
  "/quienes-somos",
  "/aviso-legal",
  "/atencion-al-cliente",
  "/ayuda",
  "/empresa",
  "/informacion-de-contacto",
  "/politica-de-privacidad",
  "/politicas-de-privacidad",
  "/contactez-nous",
  "/nous-contacter",
  "/a-propos",
  "/mentions-legales",
  "/kontakt",
  "/impressum",
  "/uber-uns",
  "/kundenservice",
  "/contatti",
  "/chi-siamo",
  "/assistenza",
  "/contato",
  "/sobre-nos",
  "/quem-somos",
  "/over-ons",
];

const RELEVANT_PATH =
  /(contact|contacto|contactanos|contactenos|about|sobre|nosotros|quienes|support|help|ayuda|kontakt|impressum|contatti|contato|contacter|contactez|empresa|company|team|customer|cliente|aviso-legal|informacion-de-contacto|privacy|privacidad|legal|imprint|atencion)/i;

const IMAGE_EXTENSIONS = new Set([
  "png", "jpg", "jpeg", "gif", "svg", "webp",
  "avif", "ico", "bmp", "tif", "tiff",
  "css", "js", "map", "woff", "woff2",
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
  "example", "test", "demo", "sample",
  "nombre", "tu", "email", "yourname",
  "your-email", "su-email", "usuario", "correo",
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
          "User-Agent": SCOUTOOL_USER_AGENT,
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

      if ([401, 403].includes(response.status)) {
        return {
          status: "forbidden",
          url: currentUrl,
          httpStatus: response.status,
        };
      }

      if (response.status === 429) {
        return {
          status: "rate_limited",
          url: currentUrl,
          httpStatus: 429,
        };
      }

      if ([404, 410].includes(response.status)) {
        return {
          status: "missing",
          url: currentUrl,
          httpStatus: response.status,
        };
      }

      if (response.status >= 500) {
        return {
          status: "unreachable",
          url: currentUrl,
          httpStatus: response.status,
        };
      }

      if (!response.ok) {
        return {
          status: "error",
          url: currentUrl,
          httpStatus: response.status,
        };
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

      const size = Number(
        response.headers.get("content-length") || 0,
      );

      if (size > maxBytes) {
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
      return {
        status: "unreachable",
        url: currentUrl,
      };
    }
  }

  return { status: "error", url: currentUrl };
}

// --------------------------------------------
// ROBOTS.TXT
// --------------------------------------------

function parseRobots(text: string): RobotsData {
  const groups: Array<{
    agents: string[];
    rules: RobotsRule[];
  }> = [];

  const sitemaps: string[] = [];

  let agents: string[] = [];
  let groupRules: RobotsRule[] = [];
  let rulesStarted = false;

  function saveGroup() {
    if (agents.length > 0) {
      groups.push({
        agents: [...agents],
        rules: [...groupRules],
      });
    }

    agents = [];
    groupRules = [];
    rulesStarted = false;
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
      if (rulesStarted) {
        saveGroup();
      }

      if (value) agents.push(value.toLowerCase());
      continue;
    }

    if (key === "allow" || key === "disallow") {
      if (agents.length > 0) {
        rulesStarted = true;

        if (value) {
          groupRules.push({
            allow: key === "allow",
            path: value,
          });
        }
      }
    }
  }

  saveGroup();

  const crawlerAgent = SCOUTOOL_USER_AGENT.toLowerCase();
  let longestMatch = 0;

  for (const group of groups) {
    for (const agent of group.agents) {
      if (
        agent !== "*" &&
        crawlerAgent.includes(agent) &&
        agent.length > longestMatch
      ) {
        longestMatch = agent.length;
      }
    }
  }

  const selectedGroups =
    longestMatch > 0
      ? groups.filter((group) =>
          group.agents.some(
            (agent) =>
              agent !== "*" &&
              agent.length === longestMatch &&
              crawlerAgent.includes(agent),
          ),
        )
      : groups.filter((group) =>
          group.agents.includes("*"),
        );

  return {
    rules: selectedGroups.flatMap((group) => group.rules),
    sitemaps: [...new Set(sitemaps)],
  };
}

function robotsAllows(
  pathname: string,
  rules: RobotsRule[],
): boolean {
  let best: RobotsRule | null = null;
  let bestLength = -1;

  for (const rule of rules) {
    const endAnchored = rule.path.endsWith("$");
    const pattern = endAnchored
      ? rule.path.slice(0, -1)
      : rule.path;

    const regexPattern = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");

    const regex = new RegExp(
      `^${regexPattern}${endAnchored ? "$" : ""}`,
    );

    if (!regex.test(pathname)) continue;

    const specificity = Buffer.byteLength(
      pattern.replace(/\*/g, ""),
      "utf8",
    );

    if (specificity > bestLength) {
      best = rule;
      bestLength = specificity;
    } else if (
      specificity === bestLength &&
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
): Promise<{
  rules: RobotsRule[];
  sitemaps: string[];
  allowedToContinue: boolean;
  diagnostic: string;
}> {
  const robotsUrl = new URL("/robots.txt", origin).toString();

  let result = await fetchPublicText(
    robotsUrl,
    hostname,
    100_000,
    isSafeHost,
  );

  if (result.status === "unreachable") {
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 1200);
    });

    result = await fetchPublicText(
      robotsUrl,
      hostname,
      100_000,
      isSafeHost,
    );
  }

  if (result.status === "ok") {
    return {
      ...parseRobots(result.text),
      allowedToContinue: true,
      diagnostic: "robots_ok",
    };
  }

  // A missing or forbidden robots.txt response is treated
  // as unavailable. Webpage-level restrictions still apply.
  if (
    result.status === "forbidden" ||
    result.status === "missing"
  ) {
    return {
      rules: [],
      sitemaps: [],
      allowedToContinue: true,
      diagnostic: `robots_unavailable_${result.httpStatus || "404"}`,
    };
  }

  if (result.status === "rate_limited") {
    return {
      rules: [],
      sitemaps: [],
      allowedToContinue: false,
      diagnostic: "robots_rate_limited",
    };
  }

  if (result.status === "unreachable") {
    return {
      rules: [],
      sitemaps: [],
      allowedToContinue: false,
      diagnostic: "robots_unreachable_after_retry",
    };
  }

  return {
    rules: [],
    sitemaps: [],
    allowedToContinue: false,
    diagnostic: "robots_error",
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
    .replace(/&#46;/gi, ".")
    .replace(/&#x2e;/gi, ".")
    .replace(/&amp;/gi, "&")
    .replace(/&nbsp;/gi, " ")
    .replace(
      /&#(x[0-9a-f]+|\d+);/gi,
      (_, code: string) => {
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
      },
    );
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
    local.includes("..") ||
    domain.startsWith(".") ||
    domain.endsWith(".") ||
    domain.includes("..")
  ) {
    return false;
  }

  if (!/^[a-z]{2,24}$/i.test(tld)) return false;
  if (IMAGE_EXTENSIONS.has(tld)) return false;
  if (PLACEHOLDER_DOMAINS.has(domain)) return false;
  if (PLACEHOLDER_NAMES.has(local)) return false;

  if (
    /^(no[._-]?reply|do[._-]?not[._-]?reply|noreply)$/i.test(local)
  ) {
    return false;
  }

  if (
    /^(gemini_generated_image|logo|thumbnail|icon)[_.-]/i.test(local)
  ) {
    return false;
  }

  return true;
}

function extractEmails(html: string): string[] {
  const decoded = decodeHtml(html);

  const jsonLdBlocks = [
    ...decoded.matchAll(
      /<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ].map((match) => match[1]);

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

  const atPattern =
    String.raw`(?:\[at\]|\(at\)|\{at\}|\bat\b|\[arroba\]|\(arroba\)|\barroba\b)`;

  const dotPattern =
    String.raw`(?:\[dot\]|\(dot\)|\{dot\}|\bdot\b|\[punto\]|\(punto\)|\bpunto\b)`;

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
    jsonLdBlocks
      .join(" ")
      .match(
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
// COUNTRY AND LANGUAGE DETECTION
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
    const code = match[1]
      .split(/[-_]/)[0]
      .toLowerCase();

    return LANGUAGES[code] || "Unknown";
  }

  return "Unknown";
}

// --------------------------------------------
// CONTACT LINK DISCOVERY
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
          robotsAllows(
            url.pathname + url.search,
            rules,
          )
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

        if (!sameSiteHost(url.hostname, hostname)) continue;

        if (
          /\.xml$/i.test(url.pathname) ||
          /sitemap/i.test(url.pathname)
        ) {
          nestedSitemaps.add(url.toString());
          continue;
        }

        if (
          !RELEVANT_PATH.test(url.pathname) ||
          !robotsAllows(
            url.pathname + url.search,
            rules,
          )
        ) {
          continue;
        }

        url.hash = "";
        pages.add(url.toString());
      } catch {
        // Ignore invalid sitemap entries.
      }
    }
  }

  for (const result of firstResults) {
    if (result.status === "ok") {
      processLocations(result.text);
    }
  }

  const nested = [...nestedSitemaps].slice(0, 2);

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
      if (/contact|contacto|kontakt|contatti|contato/i.test(url)) {
        return 3;
      }

      if (/about|sobre|nosotros|company|empresa/i.test(url)) {
        return 2;
      }

      if (/privacy|legal|impressum|imprint/i.test(url)) {
        return 1;
      }

      return 0;
    };

    return score(b) - score(a);
  });
}

// --------------------------------------------
// CONTROLLED CONCURRENCY
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
      reason: "invalid_url",
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
      reason: "host_not_public_or_dns_failed",
    };
  }

  const robots = await fetchRobots(
    origin,
    hostname,
    isSafeHost,
  );

  if (!robots.allowedToContinue) {
    return {
      results: [],
      status: "blocked",
      hostname,
      reason: robots.diagnostic,
    };
  }

  const homepagePath =
    base.pathname + base.search || "/";

  if (!robotsAllows(homepagePath, robots.rules)) {
    return {
      results: [],
      status: "blocked",
      hostname,
      reason: "homepage_disallowed_by_robots",
    };
  }

  const [homepage, sitemapPages] = await Promise.all([
    fetchPublicText(
      base.toString(),
      hostname,
      MAX_HTML_SIZE,
      isSafeHost,
    ),

    discoverSitemapPages(
      origin,
      hostname,
      robots.sitemaps,
      robots.rules,
      isSafeHost,
    ),
  ]);

  if (
    homepage.status === "rate_limited" ||
    homepage.status === "unreachable"
  ) {
    return {
      results: [],
      status: "blocked",
      hostname,
      reason: `homepage_${homepage.status}`,
    };
  }

  const homepageHtml =
    homepage.status === "ok" ? homepage.text : "";

  const homeLinks = homepageHtml
    ? findContactLinks(homepageHtml, base.toString())
    : [];

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
    de: ["/kontakt", "/impressum", "/pages/impressum"],
    fr: ["/contactez-nous", "/nous-contacter", "/mentions-legales"],
    it: ["/contatti", "/chi-siamo"],
    pt: ["/contato", "/sobre-nos"],
    nl: ["/over-ons"],
  };

  const localizedUrls = (
    localizedPaths[extension] || []
  ).map((path) => new URL(path, origin).toString());

  const allCandidates = [
    ...homeLinks,
    ...sitemapPages,
    ...localizedUrls,
    ...CONTACT_PATHS.map((path) =>
      new URL(path, origin).toString(),
    ),
  ];

  const candidates = [...new Set(allCandidates)].filter(
    (item) => {
      try {
        const url = new URL(item);

        return (
          url.origin === origin &&
          item !== base.toString() &&
          robotsAllows(
            url.pathname + url.search,
            robots.rules,
          )
        );
      } catch {
        return false;
      }
    },
  );

  const selectedPages = candidates.slice(
    0,
    MAX_CONTACT_PAGES,
  );

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

  for (const page of pageResults) {
    if (page.status === "ok") {
      successfulPages.push({
        text: page.text,
        url: page.url,
      });
    }
  }

  const combinedHtml = successfulPages
    .map((page) => page.text)
    .join(" ");

  const country = detectCountry(hostname, combinedHtml);
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

  // Count failures by actual type, rather than treating
  // every failed contact URL as a blocked website.
  const forbiddenPages = pageResults.filter(
    (page) => page.status === "forbidden",
  ).length;

  const rateLimitedPages = pageResults.filter(
    (page) => page.status === "rate_limited",
  ).length;

  const unreachablePages = pageResults.filter(
    (page) => page.status === "unreachable",
  ).length;

  let status: Status;
  let reason: string | undefined;

  if (found.length > 0) {
    status = "success";
  } else if (successfulPages.length > 0) {
    // At least one page was accessible. Failed alternative
    // contact URLs do not make the entire website blocked.
    status = "no_email";
  } else if (homepage.status === "forbidden") {
    status = "blocked";
    reason = "homepage_forbidden";
  } else if (rateLimitedPages > 0) {
    status = "blocked";
    reason = "contact_pages_rate_limited";
  } else if (forbiddenPages > 0) {
    status = "blocked";
    reason = "contact_pages_forbidden";
  } else if (unreachablePages > 0) {
    status = "blocked";
    reason = "contact_pages_unreachable";
  } else if (homepage.status === "missing") {
    status = "no_email";
    reason = "homepage_missing";
  } else {
    status = "error";
    reason = `homepage_${homepage.status}`;
  }

  return {
    results: found,
    status,
    hostname,
    reason,
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

  // Shared cancellation state for the stream and workers.
  const streamState = {
    cancelled: false,
  };

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
      const diagnosticCounts: Record<string, number> = {};

      function send(event: Record<string, unknown>) {
        if (streamState.cancelled) return;

        try {
          controller.enqueue(
            encoder.encode(JSON.stringify(event) + "\n"),
          );
        } catch {
          // The browser may have cancelled or closed the stream.
          streamState.cancelled = true;
        }
      }

      function sendUniqueResults(results: Result[]) {
        for (const result of results) {
          if (streamState.cancelled) return;

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
        while (!streamState.cancelled) {
          const index = nextIndex++;

          if (index >= domains.length) return;

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
              reason: "unexpected_scan_error",
            };
          }

          // Do not enqueue new data after client cancellation.
          if (streamState.cancelled) return;

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

          if (outcome.reason) {
            diagnosticCounts[outcome.reason] =
              (diagnosticCounts[outcome.reason] || 0) + 1;
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

        console.info("[Scoutool] Scan diagnostics", {
          processed,
          emailsFound,
          successful,
          blocked,
          errors,
          noEmail,
          reasons: diagnosticCounts,
          cancelled: streamState.cancelled,
        });

        if (!streamState.cancelled) {
          send({
            type: "done",
            processed,
            successful,
            errors,
            blocked,
            noEmail,
            emailsFound,
          });
        }
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
        // Close only when the client has not already cancelled.
        if (!streamState.cancelled) {
          try {
            controller.close();
          } catch {
            streamState.cancelled = true;
          }
        }
      }
    },

    // Called when the browser or client cancels the response.
    cancel() {
      streamState.cancelled = true;
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
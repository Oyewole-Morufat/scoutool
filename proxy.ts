
import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse, type NextRequest } from "next/server";

const MAX_SCANS = 3;
const RATE_LIMIT_WINDOW = "15 m";

let rateLimiter: Ratelimit | undefined;

function normalizeRedisUrl(raw: string): string {
  let value = raw.trim();

  // Remove surrounding quotation marks or backticks.
  for (let i = 0; i < 3; i++) {
    const first = value[0];
    const last = value[value.length - 1];

    if (
      (first === '"' && last === '"') ||
      (first === "'" && last === "'") ||
      (first === "`" && last === "`")
    ) {
      value = value.slice(1, -1).trim();
    } else {
      break;
    }
  }

  // Convert a Markdown link into its actual HTTPS destination.
  const markdownLink = value.match(
    /^\[([^\]]+)\]\((https:\/\/[^)]+)\)$/i
  );

  if (markdownLink) {
    value = markdownLink[2].trim();
  }

  // Remove optional angle brackets.
  if (value.startsWith("<") && value.endsWith(">")) {
    value = value.slice(1, -1).trim();
  }

  const parsed = new URL(value);

  if (
    parsed.protocol !== "https:" ||
    !parsed.hostname.toLowerCase().endsWith(".upstash.io") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    (parsed.port !== "" && parsed.port !== "443") ||
    parsed.pathname !== "/"
  ) {
    throw new Error(
      "Invalid Upstash REST URL. Check the Vercel environment variable."
    );
  }

  return parsed.origin;
}

function getRateLimiter(): Ratelimit {
  if (rateLimiter) {
    return rateLimiter;
  }

  const rawUrl = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!rawUrl || !token) {
    throw new Error("Upstash Redis credentials are missing.");
  }

  const url = normalizeRedisUrl(rawUrl);

  rateLimiter = new Ratelimit({
    redis: new Redis({ url, token }),
    limiter: Ratelimit.slidingWindow(
      MAX_SCANS,
      RATE_LIMIT_WINDOW
    ),
    prefix: "scoutool:scrape-api:v1",
    analytics: false,
    timeout: 3000,
  });

  return rateLimiter;
}

function getClientIdentifier(request: NextRequest): string {
  const forwardedIp =
    request.headers.get("x-vercel-forwarded-for") ||
    request.headers.get("x-real-ip") ||
    request.headers.get("x-forwarded-for");

  const clientIp =
    forwardedIp?.split(",")[0].trim() || "unknown-client";

  const hashedIp = createHash("sha256")
    .update(clientIp)
    .digest("hex");

  return `ip:${hashedIp}`;
}

export async function proxy(request: NextRequest) {
  if (
    !["/api/scrape", "/api/verify-email"].includes(request.nextUrl.pathname) ||
    request.method !== "POST"
  ) {
    return NextResponse.next();
  }

  try {
    const limiter = getRateLimiter();

    const result = await limiter.limit(
      getClientIdentifier(request)
    );

    if (result.reason === "timeout") {
      return NextResponse.json(
        {
          error:
            "The scanning service is temporarily unavailable. Please try again shortly.",
        },
        { status: 503 }
      );
    }

    if (!result.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.reset - Date.now()) / 1000)
      );

      return NextResponse.json(
        {
          error:
            "You have reached the request limit. Please wait before trying again.",
          retryAfterSeconds: retryAfter,
        },
        {
          status: 429,
          headers: {
            "Retry-After": String(retryAfter),
            "X-RateLimit-Limit": String(result.limit),
            "X-RateLimit-Remaining": String(result.remaining),
          },
        }
      );
    }

    return NextResponse.next();
  } catch (error) {
    console.error(
      "[Scoutool] Rate limiter error:",
      error instanceof Error ? error.message : "Unknown error"
    );

    if (process.env.NODE_ENV === "development") {
      return NextResponse.next();
    }

    return NextResponse.json(
      {
        error:
          "The scanning service is temporarily unavailable. Please try again shortly.",
      },
      { status: 503 },
    );
  }
}

export const config = {
  matcher: ["/api/scrape"],
};

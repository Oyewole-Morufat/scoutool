
import { createHash } from "node:crypto";
import { Ratelimit } from "@upstash/ratelimit";
import { Redis } from "@upstash/redis";
import { NextResponse, type NextRequest } from "next/server";

const MAX_SCANS = 3;
const RATE_LIMIT_WINDOW = "15 m";

let rateLimiter: Ratelimit | undefined;

function getRateLimiter(): Ratelimit {
  if (rateLimiter) {
    return rateLimiter;
  }

  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!url || !token) {
    throw new Error("Upstash Redis credentials are missing.");
  }

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
  // Only rate-limit POST requests to the scanning API.
  if (
    request.nextUrl.pathname !== "/api/scrape" ||
    request.method !== "POST"
  ) {
    return NextResponse.next();
  }

  try {
    const limiter = getRateLimiter();
    const identifier = getClientIdentifier(request);

    const result = await limiter.limit(identifier);

    // Fail closed if Redis times out.
    if (result.reason === "timeout") {
      return NextResponse.json(
        {
          error:
            "The scanning service is temporarily unavailable. Please try again shortly.",
        },
        { status: 503 }
      );
    }

    // Reject requests that exceed the scan limit.
    if (!result.success) {
      const retryAfter = Math.max(
        1,
        Math.ceil((result.reset - Date.now()) / 1000)
      );

      return NextResponse.json(
        {
          error:
            "You have reached the scan limit. Please wait before starting another scan.",
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

    return NextResponse.json(
      {
        error:
          "The scanning service is temporarily unavailable. Please try again shortly.",
      },
      { status: 503 }
    );
  }
}

export const config = {
  matcher: ["/api/scrape"],
};

import { resolve4, resolve6, resolveMx } from "node:dns/promises";
import { NextRequest } from "next/server";

const MAX_EMAILS = 200;
const MAX_REQUEST_BYTES = 64 * 1024;
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type Verification = {
  email: string;
  status: "likely" | "invalid_domain" | "uncertain";
  reason: string;
};

async function hasMailDestination(domain: string): Promise<boolean> {
  try {
    const records = await resolveMx(domain);
    if (records.length > 0) return true;
  } catch {
    // Some domains accept mail through an A/AAAA fallback when no MX exists.
  }

  try {
    const [ipv4, ipv6] = await Promise.all([
      resolve4(domain).catch(() => []),
      resolve6(domain).catch(() => []),
    ]);
    return ipv4.length > 0 || ipv6.length > 0;
  } catch {
    return false;
  }
}

export async function POST(request: NextRequest) {
  let body: unknown;

  try {
    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: "The request body is too large." }, { status: 413 });
    }

    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES) {
      return Response.json({ error: "The request body is too large." }, { status: 413 });
    }

    body = JSON.parse(rawBody) as unknown;
  } catch {
    return Response.json({ error: "Invalid JSON request body." }, { status: 400 });
  }

  const emails =
    body &&
    typeof body === "object" &&
    Array.isArray((body as { emails?: unknown }).emails)
      ? (body as { emails: unknown[] }).emails
          .filter((email): email is string => typeof email === "string")
          .map((email) => email.trim().toLowerCase())
          .filter((email, index, values) => values.indexOf(email) === index)
      : [];

  if (emails.length === 0 || emails.length > MAX_EMAILS) {
    return Response.json(
      { error: `Provide between 1 and ${MAX_EMAILS} email addresses.` },
      { status: 400 },
    );
  }

  const results: Verification[] = [];

  for (const email of emails) {
    if (!EMAIL_PATTERN.test(email)) {
      results.push({
        email,
        status: "uncertain",
        reason: "Invalid email format.",
      });
      continue;
    }

    const domain = email.split("@")[1];
    const hasDestination = await hasMailDestination(domain);

    results.push(
      hasDestination
        ? {
            email,
            status: "likely",
            reason: "The mail domain has a reachable DNS mail destination.",
          }
        : {
            email,
            status: "invalid_domain",
            reason: "The mail domain has no reachable MX or A/AAAA record.",
          },
    );
  }

  return Response.json({
    results,
    disclaimer:
      "DNS checks cannot prove that a specific mailbox exists or will not bounce.",
  });
}

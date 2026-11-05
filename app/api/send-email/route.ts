import { NextRequest, NextResponse } from "next/server";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_EMAIL_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_LENGTH = 50_000;
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

type SendEmailBody = {
  to?: unknown;
  subject?: unknown;
  text?: unknown;
};

function isValidEmail(value: string) {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value) && !value.includes("..");
}

export async function POST(request: NextRequest) {
  let payload: SendEmailBody;

  try {
    const rawBody = await request.text();
    if (
      Number(request.headers.get("content-length") || 0) > MAX_REQUEST_BYTES ||
      new TextEncoder().encode(rawBody).byteLength > MAX_REQUEST_BYTES
    ) {
      return NextResponse.json({ error: "The request body is too large." }, { status: 413 });
    }
    payload = JSON.parse(rawBody) as SendEmailBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const to = typeof payload.to === "string" ? payload.to.trim() : "";
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";

  if (!to || !subject || !text) {
    return NextResponse.json(
      { error: "Recipient, subject, and message are required." },
      { status: 400 }
    );
  }
  if (!isValidEmail(to)) {
    return NextResponse.json({ error: "The recipient email address is invalid." }, { status: 400 });
  }
  if (subject.length > MAX_SUBJECT_LENGTH || text.length > MAX_TEXT_LENGTH) {
    return NextResponse.json({ error: "The subject or message is too long." }, { status: 400 });
  }

  const apiKey = process.env.RESEND_API_KEY?.trim();
  const from = process.env.RESEND_FROM_EMAIL?.trim();
  if (!apiKey || !from) {
    return NextResponse.json(
      {
        error:
          "Email sending is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL to the deployment environment.",
      },
      { status: 503 }
    );
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from, to: [to], subject, text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (response.status === 429) {
      return NextResponse.json(
        { error: "The email provider rate limit was reached. Please wait and try again." },
        { status: 429 }
      );
    }
    if (!response.ok) {
      return NextResponse.json({ error: "The email provider rejected the message." }, { status: 502 });
    }
  } catch {
    return NextResponse.json({ error: "The email provider could not be reached." }, { status: 502 });
  }

  return NextResponse.json({ ok: true });
}

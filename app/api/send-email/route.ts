import { NextRequest, NextResponse } from "next/server";

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_EMAIL_LENGTH = 254;
const MAX_SUBJECT_LENGTH = 998;
const MAX_TEXT_LENGTH = 50_000;
const EMAIL_PATTERN =
  /^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

type SendEmailBody = {
  messages?: unknown;
  to?: unknown;
  recipients?: unknown;
  cc?: unknown;
  bcc?: unknown;
  subject?: unknown;
  text?: unknown;
  html?: unknown;
};

function isValidEmail(value: string) {
  return value.length <= MAX_EMAIL_LENGTH && EMAIL_PATTERN.test(value) && !value.includes("..");
}

function getEmails(value: unknown): string[] {
  if (typeof value === "string") return value.split(/[,\s]+/).filter(Boolean);
  if (Array.isArray(value)) return value.filter((item): item is string => typeof item === "string");
  return [];
}

function sanitizeHtml(value: string): string {
  return value
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/\son\w+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/javascript\s*:/gi, "")
    .replace(/<(?!\/?(?:b|strong|i|em|u|br|p|div|ul|ol|li)(?:\s[^>]*)?>)[^>]+>/gi, "");
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

  const to = getEmails(payload.recipients ?? payload.to);
  const cc = getEmails(payload.cc);
  const bcc = getEmails(payload.bcc);
  const subject = typeof payload.subject === "string" ? payload.subject.trim() : "";
  const text = typeof payload.text === "string" ? payload.text.trim() : "";
  const html = typeof payload.html === "string" ? sanitizeHtml(payload.html.trim()) : "";
  const hasMessages = Array.isArray(payload.messages);

  if (!hasMessages && (to.length === 0 || !subject || (!text && !html))) {
    return NextResponse.json(
      { error: "Recipient, subject, and message are required." },
      { status: 400 }
    );
  }
  const allRecipients = [...to, ...cc, ...bcc];
  if (
    !hasMessages &&
    (allRecipients.length > 50 ||
      allRecipients.some((recipient) => !isValidEmail(recipient.trim())))
  ) {
    return NextResponse.json({ error: "The recipient email address is invalid." }, { status: 400 });
  }
  if (
    !hasMessages &&
    (subject.length > MAX_SUBJECT_LENGTH ||
      text.length > MAX_TEXT_LENGTH ||
      html.length > MAX_TEXT_LENGTH)
  ) {
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

  const rawMessages = Array.isArray(payload.messages) ? payload.messages : null;
  const messageInputs = rawMessages
    ? rawMessages
        .filter((message): message is Record<string, unknown> => Boolean(message) && typeof message === "object")
        .map((message) => ({
          to: getEmails(message.to),
          cc: getEmails(message.cc),
          bcc: getEmails(message.bcc),
          subject: typeof message.subject === "string" ? message.subject.trim() : "",
          text: typeof message.text === "string" ? message.text.trim() : "",
          html: typeof message.html === "string" ? sanitizeHtml(message.html.trim()) : "",
        }))
    : null;

  if (messageInputs) {
    if (messageInputs.length === 0 || messageInputs.length > 50) {
      return NextResponse.json({ error: "Send between 1 and 50 messages at a time." }, { status: 400 });
    }

    for (const message of messageInputs) {
      const recipients = [...message.to, ...message.cc, ...message.bcc];
      if (
        message.to.length !== 1 ||
        recipients.some((recipient) => !isValidEmail(recipient)) ||
        !message.subject ||
        (!message.text && !message.html) ||
        message.subject.length > MAX_SUBJECT_LENGTH ||
        message.text.length > MAX_TEXT_LENGTH ||
        message.html.length > MAX_TEXT_LENGTH
      ) {
        return NextResponse.json({ error: "One or more messages are invalid." }, { status: 400 });
      }
    }

    const results: Array<{ to: string; status: "accepted" | "failed"; error?: string }> = [];
    for (const message of messageInputs) {
      try {
        const response = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: message.to,
            cc: message.cc.length > 0 ? message.cc : undefined,
            bcc: message.bcc.length > 0 ? message.bcc : undefined,
            subject: message.subject,
            text: message.text || message.html.replace(/<[^>]+>/g, " "),
            html: message.html || undefined,
          }),
          signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) {
          results.push({ to: message.to[0], status: "failed", error: response.status === 429 ? "Rate limit reached." : "Provider rejected the message." });
        } else {
          results.push({ to: message.to[0], status: "accepted" });
        }
      } catch {
        results.push({ to: message.to[0], status: "failed", error: "Provider could not be reached." });
      }
    }
    return NextResponse.json({ results });
  }

  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from,
        to,
        cc: cc.length > 0 ? cc : undefined,
        bcc: bcc.length > 0 ? bcc : undefined,
        subject,
        text: text || html.replace(/<[^>]+>/g, " "),
        html: html || undefined,
      }),
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

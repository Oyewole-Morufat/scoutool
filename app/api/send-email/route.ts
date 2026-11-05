import { NextRequest, NextResponse } from "next/server";

type SendEmailBody = {
  to?: string;
  subject?: string;
  text?: string;
};

export async function POST(request: NextRequest) {
  let payload: SendEmailBody;

  try {
    payload = (await request.json()) as SendEmailBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON request." }, { status: 400 });
  }

  const to = payload.to?.trim();
  const subject = payload.subject?.trim();
  const text = payload.text?.trim();
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;

  if (!to || !subject || !text) {
    return NextResponse.json(
      { error: "Recipient, subject, and message are required." },
      { status: 400 }
    );
  }

  if (!apiKey || !from) {
    return NextResponse.json(
      {
        error:
          "Email sending is not configured. Add RESEND_API_KEY and RESEND_FROM_EMAIL to .env.local.",
      },
      { status: 503 }
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to: [to], subject, text }),
  });

  if (!response.ok) {
    const details = await response.text();
    return NextResponse.json(
      { error: details || `Email provider returned ${response.status}.` },
      { status: 502 }
    );
  }

  return NextResponse.json({ ok: true });
}

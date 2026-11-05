"use client";

import { useEffect, useRef, useState } from "react";

type Result = {
  email: string;
  site: string;
  path: string;
  country: string;
  language: string;
};

type StreamEvent = {
  type: "start" | "result" | "complete" | "error" | string;
  total?: number;
  completed?: number;
  totalEmails?: number;
  domain?: string;
  hostname?: string;
  status?: "success" | "no_email" | "blocked" | "error";
  results?: Result[];
  reason?: string;
  error?: string;
};

export default function Home() {
  const [emailMode, setEmailMode] = useState(false);
  const [input, setInput] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [errors, setErrors] = useState(0);
  const [blocked, setBlocked] = useState(0);
  const [noEmail, setNoEmail] = useState(0);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [currentSite, setCurrentSite] = useState("");

  const scanLock = useRef(false);
  const scanAbortController = useRef<AbortController | null>(null);

  useEffect(() => {
    return () => {
      scanAbortController.current?.abort();
    };
  }, []);

  const domains = input
    .split(/\r?\n/)
    .map((domain) => domain.trim())
    .filter(Boolean);

  if (emailMode) {
    return <EmailSender onBack={() => setEmailMode(false)} />;
  }

  const progress =
    total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;

  function resetScan() {
    setResults([]);
    setProcessed(0);
    setTotal(0);
    setErrors(0);
    setBlocked(0);
    setNoEmail(0);
    setCurrentSite("");
  }

  function handleEvent(event: StreamEvent) {
    switch (event.type) {
      case "start":
        setTotal(event.total ?? 0);
        setNotice("Scanning started...");
        break;

      case "result": {
        if (event.results) {
          setResults((previous) => {
            const existing = new Set(
              previous.map(
                (result) =>
                  `${result.email.toLowerCase()}|${result.site.toLowerCase()}`
              )
            );
            const next = [...previous];

            for (const result of event.results ?? []) {
              const key = `${result.email.toLowerCase()}|${result.site.toLowerCase()}`;
              if (!existing.has(key)) {
                existing.add(key);
                next.push(result);
              }
            }

            return next;
          });
        }

        if (typeof event.completed === "number") {
          setProcessed(event.completed);
        }
        if (typeof event.total === "number") {
          setTotal(event.total);
        }
        if (event.domain || event.hostname) {
          setCurrentSite(event.domain || event.hostname || "");
        }
        if (event.status === "error") {
          setErrors((previous) => previous + 1);
        } else if (event.status === "blocked") {
          setBlocked((previous) => previous + 1);
        } else if (event.status === "no_email") {
          setNoEmail((previous) => previous + 1);
        }
        break;
      }

      case "complete":
        if (typeof event.completed === "number") {
          setProcessed(event.completed);
        }
        if (typeof event.total === "number") {
          setTotal(event.total);
        }
        setCurrentSite("");
        setNotice("Scan completed successfully.");
        break;

      case "error":
        setNotice(event.error || "The server reported an error.");
        break;

      default:
        console.warn("Unknown scanner event:", event);
    }
  }

  async function startScraping() {
    if (scanLock.current) return;

    if (domains.length === 0) {
      setNotice("Please enter at least one website.");
      return;
    }

    if (domains.length > 1000) {
      setNotice("You can scan a maximum of 1,000 websites at a time.");
      return;
    }

    scanLock.current = true;
    const abortController = new AbortController();
    scanAbortController.current = abortController;
    setRunning(true);
    resetScan();
    setNotice("Connecting to scanner...");

    let reader: ReadableStreamDefaultReader<Uint8Array> | null = null;

    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/x-ndjson",
        },
        signal: abortController.signal,
        body: JSON.stringify({ domains }),
      });

      if (!response.ok) {
        const responseText = await response.text();
        let message = responseText;

        try {
          const errorBody = JSON.parse(responseText) as { error?: unknown };
          if (typeof errorBody.error === "string" && errorBody.error.trim()) {
            message = errorBody.error;
          }
        } catch {
          // Keep the response text when it is not JSON.
        }

        throw new Error(
          message || `Scanner request failed (${response.status}).`
        );
      }

      if (!response.body) {
        throw new Error("The server did not return a readable response stream.");
      }

      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;

      while (!finished) {
        const { value, done } = await reader.read();

        if (done) {
          buffer += decoder.decode();
        } else if (value) {
          buffer += decoder.decode(value, { stream: true });
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const rawLine of lines) {
          const line = rawLine.trim();
          if (!line) continue;

          let event: StreamEvent;

          try {
            event = JSON.parse(line) as StreamEvent;
          } catch {
            console.error("Invalid scanner response line:", line);
            setNotice("Received an unreadable response from the scanner.");
            continue;
          }

          handleEvent(event);

          if (event.type === "complete") {
            finished = true;
            break;
          }
        }

        if (done) {
          const finalLine = buffer.trim();

          if (finalLine && !finished) {
            try {
              const event = JSON.parse(finalLine) as StreamEvent;
              handleEvent(event);
              finished = event.type === "complete";
            } catch {
              console.error("Invalid final scanner response:", finalLine);
            }
          }

          break;
        }
      }

      if (!finished) {
        setNotice((previous) =>
          previous === "Scan completed successfully."
            ? previous
            : "The connection ended before the scanner sent a completion event."
        );
      }
    } catch (error) {
      console.error("Scanner request failed:", error);

      const message =
        error instanceof TypeError && /failed to fetch/i.test(error.message)
          ? `Unable to reach the scanner at ${new URL(
              "/api/scrape",
              window.location.origin,
            ).toString()}. Verify that the published app includes its API route and try again.`
          : error instanceof Error
            ? error.message
            : "An unexpected error occurred.";

      setNotice(message);

      if (reader) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be closed.
        }
      }
    } finally {
      if (scanAbortController.current === abortController) {
        scanAbortController.current = null;
      }
      scanLock.current = false;
      setRunning(false);
      setCurrentSite("");
    }
  }

  function downloadCSV() {
    if (results.length === 0) {
      setNotice("There are no email results to download yet.");
      return;
    }

    const headers = ["Email", "Website", "Path", "Country", "Language"];

    const escapeCSV = (value: string | undefined) =>
      `"${(value ?? "").replace(/"/g, '""')}"`;

    const rows = results.map((result) =>
      [
        result.email,
        result.site,
        result.path,
        result.country,
        result.language,
      ]
        .map(escapeCSV)
        .join(",")
    );

    const csv = [headers.join(","), ...rows].join("\r\n");
    const blob = new Blob(["\uFEFF" + csv], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "scoutool-email-results.csv";
    document.body.appendChild(link);
    link.click();
    link.remove();

    URL.revokeObjectURL(url);
    setNotice("CSV file downloaded.");
  }

  return (
    <main className="app-shell min-h-screen px-4 py-8 text-green-50 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-7xl">
        <header className="mb-8 flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <div className="mb-2 flex items-center gap-2">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-green-500 text-xl font-bold text-green-950 shadow-lg shadow-green-500/25">
                S
              </div>
              <h1 className="text-2xl font-bold tracking-tight">Scoutool</h1>
            </div>
            <p className="text-sm text-green-200/65">
              Website email discovery dashboard
            </p>
          </div>

          <div className="app-panel flex items-center gap-2 self-start rounded-full border px-4 py-2 text-sm">
            <span
              className={`h-2 w-2 rounded-full ${
                running ? "animate-pulse bg-green-300" : "bg-green-400"
              }`}
            />
            {running ? "Scanner running" : "Ready to scan"}
          </div>
        </header>

        <section className="app-panel mb-6 rounded-2xl border p-5 shadow-xl sm:p-7">
          <div className="mb-5 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-lg font-semibold">Website scanner</h2>
              <p className="mt-1 text-sm text-green-100/65">
                Enter one website per line to discover publicly listed email
                addresses.
              </p>
            </div>

            <span className="text-sm text-green-100/60">
              {domains.length.toLocaleString()} / 1,000 websites
            </span>
          </div>

          <textarea
            value={input}
            onChange={(event) => setInput(event.target.value)}
            disabled={running}
            placeholder={"example.com\nhttps://another-example.com\nthird-example.com"}
            rows={8}
            className="app-input w-full resize-y rounded-xl border p-4 text-sm text-green-50 outline-none transition placeholder:text-green-200/35 disabled:cursor-not-allowed disabled:opacity-60"
          />

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p className="text-xs text-green-100/45">
              Maximum 1,000 websites per scan.
            </p>

            <div className="flex flex-wrap gap-3">
              <button
                type="button"
                onClick={() => setInput("")}
                disabled={running || !input}
                className="app-button rounded-xl border px-5 py-3 text-sm font-medium text-green-100/75 transition hover:bg-green-400/10 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Clear
              </button>

              <button
                type="button"
                onClick={startScraping}
                disabled={running || domains.length === 0 || domains.length > 1000}
                className="app-button rounded-xl bg-green-400 px-6 py-3 text-sm font-semibold text-green-950 transition hover:bg-green-300 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {running ? "Scanning..." : "Start Scraping"}
              </button>

              <button
                type="button"
                onClick={() => {
                  scanAbortController.current?.abort();
                  setEmailMode(true);
                }}
                className="app-button rounded-xl border border-green-300/60 bg-green-300/10 px-6 py-3 text-sm font-semibold text-green-200 transition hover:bg-green-300/20 disabled:cursor-not-allowed disabled:opacity-40"
              >
                Send Email
              </button>
            </div>
          </div>
        </section>

        <section className="app-panel mb-6 rounded-2xl border p-5 sm:p-6">
          <div className="mb-4 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold">Scan progress</h2>
              <p className="mt-1 text-sm text-green-100/65">
                {currentSite
                  ? `Currently scanning: ${currentSite}`
                  : notice || "Waiting for a scan to begin."}
              </p>
            </div>

            <span className="text-lg font-bold tabular-nums text-green-300">
              {progress}%
            </span>
          </div>

          <div
            className="h-3 overflow-hidden rounded-full bg-green-950/70"
            role="progressbar"
            aria-label="Scan progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
          >
            <div
              className="h-full rounded-full bg-gradient-to-r from-green-500 to-emerald-300 transition-all duration-300"
              style={{ width: `${progress}%` }}
            />
          </div>

          <div className="mt-3 flex justify-between text-xs text-green-100/45">
            <span>{processed.toLocaleString()} processed</span>
            <span>{total.toLocaleString()} total</span>
          </div>
        </section>

        <section className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <StatCard
            title="Emails Found"
            value={results.length}
            description="Unique email results"
            color="text-green-300"
          />
          <StatCard
            title="Websites Processed"
            value={processed}
            description="Websites checked"
            color="text-green-300"
          />
          <StatCard
            title="Errors"
            value={errors}
            description="Scanning errors reported"
            color="text-red-400"
          />
          <StatCard
            title="Blocked / No Email"
            value={blocked + noEmail}
            description={`${blocked} blocked · ${noEmail} without email`}
            color="text-amber-400"
          />
        </section>

        <section className="app-panel overflow-hidden rounded-2xl border">
          <div className="flex flex-col gap-3 border-b border-green-200/15 p-5 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="font-semibold">Discovered email addresses</h2>
              <p className="mt-1 text-sm text-green-100/65">
                {results.length.toLocaleString()} unique results
              </p>
            </div>

            <button
              type="button"
              onClick={downloadCSV}
              disabled={results.length === 0}
              className="app-button rounded-xl border px-5 py-3 text-sm font-semibold text-green-50 transition hover:border-green-300 hover:bg-green-300/10 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Download CSV
            </button>
          </div>

          {results.length === 0 ? (
            <div className="px-5 py-16 text-center">
              <div className="mb-3 text-3xl">📧</div>
              <h3 className="font-medium text-green-100/80">
                No email addresses found yet
              </h3>
              <p className="mt-2 text-sm text-green-100/45">
                Start a scan to see discovered email addresses here.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[650px] text-left text-sm">
                <caption className="sr-only">
                  Email addresses discovered by Scoutool
                </caption>
                <thead className="bg-green-950/45 text-xs uppercase tracking-wider text-green-100/55">
                  <tr>
                    <th scope="col" className="px-5 py-4">Email</th>
                    <th scope="col" className="px-5 py-4">Website</th>
                    <th scope="col" className="px-5 py-4">Source path</th>
                  </tr>
                </thead>

                <tbody className="divide-y divide-slate-800">
                  {results.map((result, index) => (
                    <tr
                      key={`${result.email}-${result.site}-${index}`}
                      className="transition hover:bg-green-300/5"
                    >
                      <td className="px-5 py-4 font-medium text-green-300">
                        {result.email}
                      </td>
                      <td className="px-5 py-4 text-green-100/75">
                        {result.site}
                      </td>
                      <td className="px-5 py-4 text-green-100/55">
                        {result.path || "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <footer className="mt-8 text-center text-xs text-green-100/35">
          Scoutool · Website email discovery
        </footer>
      </div>
    </main>
  );
}

function StatCard({
  title,
  value,
  description,
  color,
}: {
  title: string;
  value: number;
  description: string;
  color: string;
}) {
  return (
    <div className="app-panel rounded-2xl border p-5">
      <p className="text-sm text-green-100/60">{title}</p>
      <p className={`mt-3 text-3xl font-bold tabular-nums ${color}`}>
        {value.toLocaleString()}
      </p>
      <p className="mt-2 text-xs text-green-100/40">{description}</p>
    </div>
  );
}

type EmailDraft = {
  email: string;
  storeUrl: string;
  store: string;
  subject: string;
  body: string;
  language: string;
  sent: boolean;
  sending?: boolean;
  failed?: boolean;
};

type EmailFilter = "all" | "sent" | "unsent";

const EMAIL_COOLDOWN_KEY = "scoutool-email-cooldowns";
const TWO_DAYS_MS = 2 * 24 * 60 * 60 * 1000;

function getEmailCooldownExpiry() {
  return Date.now() + TWO_DAYS_MS;
}

function EmailSender({ onBack }: { onBack: () => void }) {
  const [emails, setEmails] = useState("");
  const [storeUrls, setStoreUrls] = useState("");
  const [subject, setSubject] = useState("Collaborating with {store}");
  const [body, setBody] = useState(
    "Hi {store}, I love your website and would love to collaborate."
  );
  const [drafts, setDrafts] = useState<EmailDraft[]>([]);
  const [notice, setNotice] = useState("");
  const [intervalSeconds, setIntervalSeconds] = useState(5);
  const [autoSending, setAutoSending] = useState(false);
  const [cooldowns, setCooldowns] = useState<Record<string, number>>({});
  const [emailFilter, setEmailFilter] = useState<EmailFilter>("all");
  const [now, setNow] = useState(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const autoSendTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const nextDraftIndex = useRef(0);
  const autoSendingRef = useRef(false);

  useEffect(() => {
    const loadTimer = window.setTimeout(() => {
      try {
        const saved = window.localStorage.getItem(EMAIL_COOLDOWN_KEY);
        if (saved) {
          const parsed = JSON.parse(saved) as Record<string, number>;
          setCooldowns(
            Object.fromEntries(
              Object.entries(parsed).filter(([, expiresAt]) => expiresAt > Date.now())
            )
          );
        }
      } catch {
        setNotice("Saved email cooldowns could not be loaded.");
      }
      setNow(Date.now());
    }, 0);

    return () => {
      window.clearTimeout(loadTimer);
      if (autoSendTimer.current) {
        clearTimeout(autoSendTimer.current);
      }
    };
  }, []);

  useEffect(() => {
    const refreshCooldowns = () => {
      setNow(Date.now());
      setDrafts((current) => current.map((draft) => {
        const stillCooling = (cooldowns[draft.email.trim().toLowerCase()] ?? 0) > now;
        return stillCooling === draft.sent ? draft : { ...draft, sent: stillCooling };
      }));
    };
    const timer = window.setInterval(refreshCooldowns, 60 * 1000);
    return () => window.clearInterval(timer);
  }, [cooldowns, now]);

  const emailList = emails.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
  const urlList = storeUrls.split(/\r?\n|,/).map((value) => value.trim()).filter(Boolean);
  const readyCount = Math.min(emailList.length, urlList.length);
  const filteredDrafts = drafts.filter((draft) =>
    emailFilter === "all" ||
    (emailFilter === "sent" ? draft.sent : !draft.sent)
  );

  const translations: Record<string, { name: string; subject: string; body: string }> = {
    French: {
      name: "French",
      subject: "Collaboration avec {store}",
      body: "Bonjour {store}, j'aime beaucoup votre site et j'aimerais collaborer avec vous.",
    },
    German: {
      name: "German",
      subject: "Zusammenarbeit mit {store}",
      body: "Hallo {store}, ich mag Ihre Website sehr und würde gerne mit Ihnen zusammenarbeiten.",
    },
    Spanish: {
      name: "Spanish",
      subject: "Colaboración con {store}",
      body: "Hola {store}, me encanta su sitio web y me gustaría colaborar con ustedes.",
    },
    Italian: {
      name: "Italian",
      subject: "Collaborazione con {store}",
      body: "Ciao {store}, mi piace molto il vostro sito e mi piacerebbe collaborare con voi.",
    },
    Portuguese: {
      name: "Portuguese",
      subject: "Colaboração com {store}",
      body: "Olá {store}, gosto muito do seu site e gostaria de colaborar com vocês.",
    },
  };

  function getLanguage(url: string) {
    const hostname = getStoreName(url).toLowerCase();
    const tld = hostname.split(".").pop();
    const byTld: Record<string, keyof typeof translations> = {
      fr: "French",
      de: "German",
      es: "Spanish",
      it: "Italian",
      pt: "Portuguese",
    };
    return byTld[tld || ""] || "English";
  }

  function getTranslatedContent(store: string, url: string) {
    const language = getLanguage(url);
    const translation = translations[language];
    return {
      language,
      subject: (translation?.subject || subject).replace(/\{store\}/gi, store),
      body: (translation?.body || body).replace(/\{store\}/gi, store),
    };
  }

  function stopAutoSend() {
    if (autoSendTimer.current) {
      clearTimeout(autoSendTimer.current);
      autoSendTimer.current = null;
    }
    autoSendingRef.current = false;
    setAutoSending(false);
  }

  function clearSender() {
    stopAutoSend();
    setEmails("");
    setStoreUrls("");
    setDrafts([]);
    setNotice("");
  }

  function isCoolingDown(email: string) {
    return (cooldowns[email.trim().toLowerCase()] ?? 0) > now;
  }

  function markSent(email: string) {
    const key = email.trim().toLowerCase();
    const expiresAt = getEmailCooldownExpiry();
    setCooldowns((current) => {
      const next = { ...current, [key]: expiresAt };
      window.localStorage.setItem(EMAIL_COOLDOWN_KEY, JSON.stringify(next));
      return next;
    });
    setDrafts((current) => current.map((draft) =>
      draft.email.trim().toLowerCase() === key
        ? { ...draft, sent: true, sending: false }
        : draft
    ));
  }

  function cooldownLabel(email: string) {
    const remaining = Math.max(0, (cooldowns[email.trim().toLowerCase()] ?? 0) - now);
    if (remaining === 0) return "";
    const hours = Math.ceil(remaining / (60 * 60 * 1000));
    return `Available in ${hours}h`;
  }

  function getStoreName(url: string) {
    try {
      const normalizedUrl = /^https?:\/\//i.test(url)
        ? url
        : `https://${url}`;

      return new URL(normalizedUrl).hostname.replace(/^www\./, "");
    } catch {
      return url.replace(/^https?:\/\//, "").split("/")[0] || "there";
    }
  }

  function generateDrafts() {
    if (emailList.length === 0) {
      setNotice("Add at least one email.");
      return;
    }
    if (urlList.length === 0) {
      setNotice("Add at least one store URL.");
      return;
    }
    const count = Math.min(emailList.length, urlList.length);
    nextDraftIndex.current = 0;
    setDrafts(emailList.slice(0, count).map((email, index) => {
      const store = getStoreName(urlList[index]);
      const translated = getTranslatedContent(store, urlList[index]);
      return {
        email,
        storeUrl: urlList[index],
        store,
        subject: translated.subject,
        body: translated.body,
        language: translated.language,
        sent: isCoolingDown(email),
      };
    }));
    setNotice(`${count} email${count === 1 ? "" : "s"} ready.`);
  }

  function getMailtoLink(draft: EmailDraft) {
    return `mailto:${encodeURIComponent(draft.email)}?subject=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
  }

  function openGmail(draft: EmailDraft) {
    if (draft.sent || isCoolingDown(draft.email)) {
      setNotice(`${draft.email} cannot be sent again for two days.`);
      return;
    }
    const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(draft.email)}&su=${encodeURIComponent(draft.subject)}&body=${encodeURIComponent(draft.body)}`;
    window.open(url, "_blank", "noopener,noreferrer");
    markSent(draft.email);
    setNotice(`${draft.email} marked sent. It is locked for two days.`);
  }

  async function copyLink(draft: EmailDraft) {
    try {
      await navigator.clipboard.writeText(getMailtoLink(draft));
      setNotice("Email link copied.");
    } catch {
      setNotice("Could not copy the link. Please copy it manually.");
    }
  }

  async function sendDraft(index: number) {
    const draft = drafts[index];
    if (!draft || draft.sent || draft.sending) return false;

    setDrafts((current) => current.map((item, itemIndex) =>
      itemIndex === index ? { ...item, sending: true, failed: false } : item
    ));

    try {
      const response = await fetch("/api/send-email", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: draft.email, subject: draft.subject, text: draft.body }),
      });
      if (!response.ok) {
        const result = (await response.json().catch(() => ({}))) as { error?: string };
        throw new Error(result.error || "The email could not be sent.");
      }
      setDrafts((current) => current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, sent: true, sending: false } : item
      ));
      markSent(draft.email);
      return true;
    } catch (error) {
      setDrafts((current) => current.map((item, itemIndex) =>
        itemIndex === index ? { ...item, sending: false, failed: true } : item
      ));
      setNotice(error instanceof Error ? error.message : "The email could not be sent.");
      return false;
    }
  }

  function scheduleNextAutoSend() {
    if (!autoSendingRef.current) return;
    const nextIndex = nextDraftIndex.current;
    if (nextIndex < 0 || nextIndex >= drafts.length) {
      stopAutoSend();
      setNotice("All emails have already been sent.");
      return;
    }
    nextDraftIndex.current += 1;
    void sendDraft(nextIndex).finally(() => {
      if (nextDraftIndex.current < drafts.length && autoSendingRef.current) {
        autoSendTimer.current = setTimeout(scheduleNextAutoSend, intervalSeconds * 1000);
      } else if (nextDraftIndex.current >= drafts.length) {
        stopAutoSend();
        setNotice("All emails have been sent.");
      }
    });
  }

  function startAutoSend() {
    if (drafts.length === 0) {
      setNotice("Generate emails before starting auto-send.");
      return;
    }
    if (autoSending) return;
    autoSendingRef.current = true;
    setAutoSending(true);
    nextDraftIndex.current = drafts.findIndex((draft) => !draft.sent);
    setNotice("Auto-send started. Emails are being sent in the background.");
    scheduleNextAutoSend();
  }

  function exportCSV() {
    if (drafts.length === 0) {
      setNotice("Generate emails before exporting CSV.");
      return;
    }
    const escape = (value: string) => `"${value.replace(/"/g, '""')}"`;
    const csv = [
      ["Email", "Store URL", "Subject", "Body", "Email Link"].join(","),
      ...drafts.map((draft) =>
        [draft.email, draft.storeUrl, draft.subject, draft.body, getMailtoLink(draft)].map(escape).join(",")
      ),
    ].join("\r\n");
    const url = URL.createObjectURL(new Blob(["\uFEFF" + csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = "scoutool-email-campaign.csv";
    link.click();
    URL.revokeObjectURL(url);
    setNotice("CSV file downloaded.");
  }

  function importCSV(event: React.ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const rows = (typeof reader.result === "string" ? reader.result : "")
        .split(/\r?\n/)
        .slice(1)
        .map(parseCsvRow)
        .filter((row) => row[0]);
      setEmails(rows.map((row) => row[0]).join("\n"));
      setStoreUrls(rows.map((row) => row[1] || "").join("\n"));
      setNotice(`${rows.length} CSV row${rows.length === 1 ? "" : "s"} imported.`);
    };
    reader.readAsText(file);
    event.target.value = "";
  }

  function parseCsvRow(row: string): string[] {
    const values: string[] = [];
    let value = "";
    let quoted = false;

    for (let index = 0; index < row.length; index += 1) {
      const character = row[index];

      if (character === '"') {
        if (quoted && row[index + 1] === '"') {
          value += '"';
          index += 1;
        } else {
          quoted = !quoted;
        }
      } else if (character === "," && !quoted) {
        values.push(value.trim());
        value = "";
      } else {
        value += character;
      }
    }

    values.push(value.trim());
    return values;
  }

  return (
    <main className="app-shell min-h-screen px-4 py-8 text-green-50 sm:px-6 lg:px-10">
      <div className="mx-auto max-w-5xl">
        <header className="mb-8 flex flex-wrap items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button type="button" onClick={onBack} className="text-green-200/65 hover:text-green-200">← Scanner</button>
            <div className="h-8 w-px bg-green-200/20" />
            <div><h1 className="text-2xl font-bold tracking-tight">Scoutool</h1><p className="text-sm text-green-200/65">Email sender</p></div>
          </div>
          <div className="flex gap-2">
            <input ref={fileInput} type="file" accept=".csv,text/csv" onChange={importCSV} className="hidden" />
            <button type="button" onClick={() => fileInput.current?.click()} className="app-button rounded-xl border px-4 py-2 text-sm hover:bg-green-300/10">Import CSV</button>
            <button type="button" onClick={clearSender} className="app-button rounded-xl border px-4 py-2 text-sm hover:bg-green-300/10">Clear</button>
            <button type="button" onClick={() => setNotice("Use {store} in the subject or body to personalize each email.")} className="app-button rounded-xl border px-4 py-2 text-sm hover:bg-green-300/10">Help</button>
          </div>
        </header>

        <section className="app-panel rounded-2xl border p-5 shadow-xl sm:p-7">
          <div className="grid gap-5 md:grid-cols-2">
            <label className="text-sm font-medium text-green-100/80">Emails
              <textarea value={emails} onChange={(event) => setEmails(event.target.value)} placeholder={"email@store.com\nhello@shop.fr"} rows={7} className="app-input mt-2 w-full resize-y rounded-xl border p-4 text-sm text-green-50 outline-none" />
            </label>
            <label className="text-sm font-medium text-green-100/80">Store URLs
              <textarea value={storeUrls} onChange={(event) => setStoreUrls(event.target.value)} placeholder={"https://store.com\nhttps://shop.fr"} rows={7} className="app-input mt-2 w-full resize-y rounded-xl border p-4 text-sm text-green-50 outline-none" />
            </label>
            <label className="text-sm font-medium text-green-100/80">Subject <span className="text-green-200/45">{"{store}"} is personalized</span>
              <input value={subject} onChange={(event) => setSubject(event.target.value)} className="app-input mt-2 w-full rounded-xl border p-3 text-sm text-green-50 outline-none" />
            </label>
            <label className="text-sm font-medium text-green-100/80">Body <span className="text-green-200/45">{"{store}"} is personalized</span>
              <textarea value={body} onChange={(event) => setBody(event.target.value)} rows={3} className="app-input mt-2 w-full resize-y rounded-xl border p-3 text-sm text-green-50 outline-none" />
            </label>
          </div>
          <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
            <span className="text-sm text-green-100/60">{readyCount}/{Math.max(emailList.length, urlList.length)} ready</span>
            <button type="button" onClick={generateDrafts} className="app-button rounded-xl bg-green-400 px-6 py-3 text-sm font-semibold text-green-950 hover:bg-green-300">Generate</button>
          </div>
        </section>

        <section className="app-panel mt-6 overflow-hidden rounded-2xl border">
            <div className="flex flex-wrap items-center justify-between gap-4 border-b border-green-200/15 p-5">
              <div><h2 className="font-semibold">Auto-send</h2><p className="mt-1 text-sm text-green-100/60">{drafts.length ? `${drafts.filter((draft) => !draft.sent).length} unsent · sends directly without opening tabs` : "Generate emails or import a CSV to begin"}</p></div>
              <div className="flex flex-wrap items-center gap-2">
                <label className="text-sm text-green-100/60">Every <input type="number" min={1} value={intervalSeconds} onChange={(event) => setIntervalSeconds(Math.max(1, Number(event.target.value) || 1))} className="app-input ml-1 w-16 rounded-lg border px-2 py-2 text-center text-green-50" /> sec</label>
                <button type="button" onClick={autoSending ? stopAutoSend : startAutoSend} disabled={drafts.length === 0} className="app-button rounded-xl bg-green-400 px-4 py-2 text-sm font-semibold text-green-950 hover:bg-green-300 disabled:cursor-not-allowed disabled:opacity-40">{autoSending ? "Stop" : "Start"}</button>
                <button type="button" onClick={exportCSV} disabled={drafts.length === 0} className="app-button rounded-xl border px-4 py-2 text-sm hover:bg-green-300/10 disabled:cursor-not-allowed disabled:opacity-40">CSV</button>
              </div>
            </div>
            <div className="flex flex-wrap gap-2 border-b border-green-200/15 px-5 pt-4">
              {([
                ["all", "All Emails", drafts.length],
                ["sent", "Sent", drafts.filter((draft) => draft.sent).length],
                ["unsent", "Unsent", drafts.filter((draft) => !draft.sent).length],
              ] as const).map(([filter, label, count]) => (
                <button
                  key={filter}
                  type="button"
                  onClick={() => setEmailFilter(filter)}
                  className={`border-b-2 px-3 py-2 text-sm font-medium transition ${
                    emailFilter === filter
                      ? "border-green-300 text-green-300"
                      : "border-transparent text-green-100/55 hover:text-green-100"
                  }`}
                >
                  {label} ({count})
                </button>
              ))}
            </div>
            <div className="divide-y divide-green-200/10">
              {drafts.length === 0 ? (
                <p className="p-8 text-center text-sm text-green-100/45">Auto-send is ready. Add emails and store URLs above, then click Generate.</p>
              ) : filteredDrafts.length === 0 ? (
                <p className="p-8 text-center text-sm text-green-100/45">No emails in this list.</p>
              ) : filteredDrafts.map((draft, index) => (
                <div key={`${draft.email}-${index}`} className="flex flex-col gap-3 p-5 sm:flex-row sm:items-center sm:justify-between">
                  <div className="min-w-0">
                    <p className="font-medium text-white">
                      <span className={`mr-2 inline-block h-2 w-2 rounded-full ${draft.sent ? "bg-green-950" : "bg-green-300"}`} />
                      {draft.email} <span className="ml-2 text-xs text-green-100/40">{draft.language}</span>
                    </p>
                    <p className="mt-1 truncate text-sm text-green-100/55">Subject: {draft.subject}</p>
                    {draft.sent && <p className="mt-1 text-xs text-green-100/40">{cooldownLabel(draft.email) || "Sent · locked for two days"}</p>}
                    {draft.failed && <p className="mt-1 text-xs text-red-400">Send failed</p>}
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => openGmail(draft)} disabled={draft.sent || draft.sending} className="app-button rounded-lg border px-3 py-2 text-sm hover:bg-green-300/10 disabled:cursor-not-allowed disabled:opacity-40">{draft.sending ? "Sending..." : draft.sent ? "Sent" : "Open Gmail"}</button>
                    <button type="button" onClick={() => copyLink(draft)} className="app-button rounded-lg border px-3 py-2 text-sm hover:bg-green-300/10">Copy link</button>
                  </div>
                </div>
              ))}
            </div>
          </section>
        {notice && <p role="status" className="mt-4 text-center text-sm text-green-100/60">{notice}</p>}
      </div>
    </main>
  );
}

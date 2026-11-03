"use client";

import { useRef, useState } from "react";

type Result = {
  email: string;
  site: string;
  path: string;
  country: string;
  language: string;
};

type StreamEvent = {
  type?: string;
  total?: number;
  processed?: number;
  successful?: number;
  errors?: number;
  blocked?: number;
  noEmail?: number;
  currentSite?: string;
  result?: Result;
  message?: string;
};

export default function Home() {
  const [input, setInput] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [processed, setProcessed] = useState(0);
  const [total, setTotal] = useState(0);
  const [successful, setSuccessful] = useState(0);
  const [errors, setErrors] = useState(0);
  const [blocked, setBlocked] = useState(0);
  const [noEmail, setNoEmail] = useState(0);
  const [running, setRunning] = useState(false);
  const [notice, setNotice] = useState("");
  const [currentSite, setCurrentSite] = useState("");

  // Synchronous lock: prevents duplicate requests before React
  // has time to update the running state.
  const scanLock = useRef(false);

  const domains = input
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter(Boolean);

  const progress =
    total > 0
      ? Math.round((processed / total) * 100)
      : 0;

  async function startScraping() {
    // Stop another request from starting.
    if (scanLock.current) {
      return;
    }

    setNotice("");

    if (domains.length === 0) {
      setNotice("Please enter at least one website.");
      return;
    }

    if (domains.length > 1000) {
      setNotice(
        "Maximum limit is 1,000 websites per batch.",
      );
      return;
    }

    // Lock immediately, before updating React state.
    scanLock.current = true;

    setRunning(true);
    setResults([]);
    setProcessed(0);
    setTotal(domains.length);
    setSuccessful(0);
    setErrors(0);
    setBlocked(0);
    setNoEmail(0);
    setCurrentSite("");
    setNotice("Connecting to websites...");

    let reader: ReadableStreamDefaultReader<Uint8Array> | null =
      null;

    let finished = false;

    try {
      const response = await fetch("/api/scrape", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ domains }),
      });

      if (!response.ok) {
        let errorMessage = "Scraping failed.";

        try {
          const data = await response.json();

          if (
            typeof data.error === "string" &&
            data.error.trim()
          ) {
            errorMessage = data.error;
          }
        } catch {
          // Keep the fallback message.
        }

        throw new Error(errorMessage);
      }

      if (!response.body) {
        throw new Error(
          "Your browser could not read the live results.",
        );
      }

      reader = response.body.getReader();

      const decoder = new TextDecoder();
      let buffer = "";

      // Process one complete event from the NDJSON stream.
      function processEvent(line: string) {
        if (!line.trim()) return;

        const event = JSON.parse(line) as StreamEvent;

        if (event.type === "start") {
          setTotal(event.total ?? domains.length);
          setNotice("Scanning websites...");
          return;
        }

        if (event.type === "result") {
          if (event.result) {
            const result = event.result;

            setResults((previous) => [
              ...previous,
              result,
            ]);
          }

          return;
        }

        if (event.type === "progress") {
          setProcessed(event.processed ?? 0);
          setTotal(event.total ?? domains.length);
          setSuccessful(event.successful ?? 0);
          setErrors(event.errors ?? 0);
          setBlocked(event.blocked ?? 0);
          setNoEmail(event.noEmail ?? 0);
          setCurrentSite(event.currentSite ?? "");
          setNotice("Scanning websites...");

          return;
        }

        if (event.type === "done") {
          setProcessed(event.processed ?? 0);
          setSuccessful(event.successful ?? 0);
          setErrors(event.errors ?? 0);
          setBlocked(event.blocked ?? 0);
          setNoEmail(event.noEmail ?? 0);
          setCurrentSite("");
          setNotice("Scraping completed successfully.");

          finished = true;
          return;
        }

        if (event.type === "error") {
          throw new Error(
            event.message ||
              "The scanning process was interrupted.",
          );
        }
      }

      // Read the stream until the server finishes.
      while (!finished) {
        const { value, done } = await reader.read();

        if (done) {
          // Flush any remaining decoder data.
          buffer += decoder.decode();

          // Process a final event even if it has no newline.
          if (buffer.trim()) {
            processEvent(buffer);
          }

          break;
        }

        buffer += decoder.decode(value, {
          stream: true,
        });

        const lines = buffer.split("\n");

        buffer = lines.pop() || "";

        for (const line of lines) {
          if (finished) break;

          processEvent(line);
        }
      }

      if (!finished) {
        throw new Error(
          "The scraping connection ended before completion.",
        );
      }
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Unable to connect to the scraping service.",
      );

      // Release an unfinished response reader safely.
      if (reader && !finished) {
        await reader.cancel().catch(() => {});
      }
    } finally {
      // Always release the lock when the scan ends.
      scanLock.current = false;

      setRunning(false);
      setCurrentSite("");
    }
  }

  // --------------------------------------------
  // CSV DOWNLOAD
  // --------------------------------------------

  function downloadCSV() {
    if (results.length === 0) {
      setNotice(
        "No email results are available to download yet.",
      );

      return;
    }

    const headers = [
      "Email",
      "Website",
      "Path",
      "Country",
      "Language",
    ];

    const escapeCSV = (value: string) =>
      `"${String(value ?? "").replace(/"/g, '""')}"`;

    const rows = results.map((result) =>
      [
        result.email,
        result.site,
        result.path,
        result.country,
        result.language,
      ]
        .map(escapeCSV)
        .join(","),
    );

    const csv = [
      headers.join(","),
      ...rows,
    ].join("\r\n");

    const blob = new Blob([csv], {
      type: "text/csv;charset=utf-8;",
    });

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = "scoutool-email-results.csv";

    document.body.appendChild(link);
    link.click();
    link.remove();

    // Allow the browser to start the download before cleanup.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  // --------------------------------------------
  // DASHBOARD
  // --------------------------------------------

  return (
    <main className="min-h-screen bg-slate-50 text-slate-900">
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-7xl items-center justify-between px-5 py-5">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">
              Scoutool
              <span className="text-blue-600">.</span>
            </h1>

            <p className="mt-1 text-sm text-slate-500">
              Bulk Website Email Scraper
            </p>
          </div>

          <span className="rounded-full bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700">
            Website Scanner
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-5 py-8">
        <section className="mb-7">
          <h2 className="text-2xl font-bold">
            Find Business Contact Emails
          </h2>

          <p className="mt-2 text-sm text-slate-500">
            Discover publicly listed business contact emails
            from websites.
          </p>
        </section>

        <section className="grid gap-6 lg:grid-cols-[1fr_1.2fr]">
          {/* WEBSITE INPUT */}
          <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex items-center justify-between">
              <h3 className="font-semibold">
                Website Domains
              </h3>

              <span className="text-sm text-slate-500">
                {domains.length}/1,000
              </span>
            </div>

            <textarea
              value={input}
              onChange={(event) =>
                setInput(event.target.value)
              }
              placeholder={
                "https://example.com\nhttps://anotherstore.com\nhttps://website.com"
              }
              disabled={running}
              className="min-h-72 w-full resize-y rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm outline-none transition focus:border-blue-500 focus:ring-2 focus:ring-blue-100 disabled:opacity-60"
            />

            <p className="mt-2 text-xs text-slate-500">
              Enter one website per line. Maximum 1,000
              websites.
            </p>

            <button
              type="button"
              onClick={startScraping}
              disabled={
                running ||
                domains.length === 0 ||
                domains.length > 1000
              }
              aria-busy={running}
              className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-blue-600 px-5 py-3 font-semibold text-white transition hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-slate-300"
            >
              {running && (
                <span className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
              )}

              {running
                ? "Scraping in progress..."
                : "Start Scraping"}
            </button>

            <button
              type="button"
              onClick={downloadCSV}
              disabled={results.length === 0}
              className="mt-3 w-full rounded-lg border border-slate-200 bg-white px-5 py-3 font-semibold text-slate-700 transition hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-40"
            >
              <span className="mr-2">↓</span>
              Download CSV ({results.length})
            </button>

            {/* PROGRESS */}
            {running && (
              <div
                className="mt-5 rounded-lg bg-blue-50 p-4"
                aria-live="polite"
              >
                <div className="flex items-center justify-between text-sm">
                  <span className="font-medium text-blue-800">
                    Scanning websites
                  </span>

                  <span className="font-semibold text-blue-800">
                    {progress}%
                  </span>
                </div>

                <div className="mt-3 h-2 overflow-hidden rounded-full bg-blue-100">
                  <div
                    className="h-full rounded-full bg-blue-600 transition-all duration-300"
                    style={{
                      width: `${progress}%`,
                    }}
                  />
                </div>

                <p className="mt-3 text-xs text-blue-700">
                  Processed {processed} of {total} websites
                </p>

                {currentSite && (
                  <p className="mt-2 break-all text-xs text-blue-600">
                    Currently scanning: {currentSite}
                  </p>
                )}

                <p className="mt-2 text-xs text-blue-700">
                  Emails discovered: {results.length}
                </p>
              </div>
            )}

            {/* STATUS MESSAGE */}
            {notice && (
              <p
                className="mt-4 rounded-lg bg-slate-100 p-3 text-sm text-slate-700"
                role="status"
                aria-live="polite"
              >
                {notice}
              </p>
            )}
          </div>

          {/* RESULTS AND STATISTICS */}
          <div className="space-y-6">
            <div className="grid grid-cols-2 gap-4">
              <StatCard
                label="Processed"
                value={processed}
              />

              <StatCard
                label="Emails Found"
                value={results.length}
              />

              <StatCard
                label="Successful"
                value={successful}
              />

              <StatCard
                label="Errors"
                value={errors}
              />
            </div>

            <div className="grid grid-cols-2 gap-4">
              <StatCard
                label="Blocked"
                value={blocked}
              />

              <StatCard
                label="No Email Found"
                value={noEmail}
              />
            </div>

            {/* LIVE EXTRACTION RESULTS */}
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h3 className="font-semibold">
                    Live Extraction Results
                  </h3>

                  <p className="mt-1 text-xs text-slate-500">
                    New email results appear as they are
                    discovered.
                  </p>
                </div>

                <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-medium text-blue-700">
                  {results.length} found
                </span>
              </div>

              <div className="mt-5 max-h-[520px] overflow-auto">
                <table className="w-full text-left text-sm">
                  <thead className="sticky top-0 bg-white">
                    <tr className="border-b border-slate-200 text-xs text-slate-500">
                      <th className="px-3 py-3 font-medium">
                        Email
                      </th>

                      <th className="px-3 py-3 font-medium">
                        Website
                      </th>

                      <th className="px-3 py-3 font-medium">
                        Path
                      </th>
                    </tr>
                  </thead>

                  <tbody>
                    {results.length === 0 ? (
                      <tr>
                        <td
                          colSpan={3}
                          className="px-3 py-12 text-center text-slate-400"
                        >
                          {running
                            ? "Searching for publicly listed emails..."
                            : "No email results yet. Start scraping to see results here."}
                        </td>
                      </tr>
                    ) : (
                      results.map((result, index) => (
                        <tr
                          key={`${result.email}-${index}`}
                          className="border-b border-slate-100 last:border-0"
                        >
                          <td className="break-all px-3 py-3 font-medium text-blue-700">
                            {result.email}
                          </td>

                          <td className="break-all px-3 py-3 text-slate-600">
                            {result.site}
                          </td>

                          <td className="break-all px-3 py-3 text-slate-500">
                            {result.path}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                </table>
              </div>

              <p className="mt-4 text-xs text-slate-400">
                Country and language are included in the CSV
                when detected.
              </p>
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}

// --------------------------------------------
// STATISTICS CARD
// --------------------------------------------

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm text-slate-500">
        {label}
      </p>

      <p className="mt-2 text-3xl font-bold">
        {value}
      </p>
    </div>
  );
}
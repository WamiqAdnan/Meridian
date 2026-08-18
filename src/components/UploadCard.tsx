"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { INVESTORS } from "@/lib/investors";

interface ImportResult {
  filename: string;
  owner: string;
  broker: string;
  /** learned = an LLM wrote a parser for this broker just now; known/matched = free. */
  parser: "learned" | "known" | "matched";
  parserModel?: string | null;
  parserNotes?: string | null;
  totalParsed: number;
  tradesAdded: number;
  duplicatesSkipped: number;
  countMatches: boolean;
  warnings?: string[];
  period?: string | null;
}

/** Reading a known layout is instant; learning a new one is a model call. */
const LEARNING_HINT_MS = 6000;

export default function UploadCard({
  defaultOwner,
  learningBackend,
}: {
  defaultOwner: string;
  /** Model that would learn an unknown broker's layout; null if none is configured. */
  learningBackend: string | null;
}) {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [slow, setSlow] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [owner, setOwner] = useState<string>(defaultOwner);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [details, setDetails] = useState<string[]>([]);

  useEffect(() => {
    if (!busy) return;
    const timer = setTimeout(() => setSlow(true), LEARNING_HINT_MS);
    return () => clearTimeout(timer);
  }, [busy]);

  async function upload(file: File) {
    setBusy(true);
    setSlow(false);
    setError(null);
    setDetails([]);
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      body.append("owner", owner);
      const res = await fetch("/api/import", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) {
        setDetails(Array.isArray(data.details) ? data.details : []);
        throw new Error(data.error ?? "Import failed");
      }
      setResult(data as ImportResult);
      router.refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onFiles(files: FileList | null) {
    const file = files?.[0];
    if (file) upload(file);
  }

  const busyLabel = slow ? "Working out this broker's layout…" : "Reading statement…";

  return (
    <div>
      <div className="mb-2">
        <span className="mr-2 text-xs font-medium text-neutral-500">Whose report?</span>
        <span className="inline-flex rounded-lg border border-neutral-300 p-0.5 text-xs dark:border-neutral-700">
          {INVESTORS.map((name) => (
            <button
              key={name}
              type="button"
              onClick={() => setOwner(name)}
              className={`rounded-md px-2.5 py-1 font-medium transition-colors ${
                owner === name
                  ? "bg-neutral-900 text-white dark:bg-white dark:text-neutral-900"
                  : "text-neutral-600 hover:bg-neutral-100 dark:text-neutral-400 dark:hover:bg-neutral-800"
              }`}
            >
              {name}
            </button>
          ))}
        </span>
      </div>
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          onFiles(e.dataTransfer.files);
        }}
        onClick={() => inputRef.current?.click()}
        className={`cursor-pointer rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
          dragging
            ? "border-blue-500 bg-blue-50 dark:bg-blue-950/30"
            : "border-neutral-300 hover:border-neutral-400 dark:border-neutral-700 dark:hover:border-neutral-600"
        }`}
      >
        <input
          ref={inputRef}
          type="file"
          accept="application/pdf,.pdf,.csv,.tsv,.txt"
          className="hidden"
          onChange={(e) => onFiles(e.target.files)}
        />
        <p className="text-sm font-medium">
          {busy ? busyLabel : "Drop a broker statement here, or click to choose"}
        </p>
        <p className="mt-1 text-xs text-neutral-500">
          PDF or CSV · trades are deduplicated by trade number
        </p>
        <p className="mt-1 text-xs text-neutral-400">
          {learningBackend
            ? `A broker we haven't seen is read once by ${learningBackend}, then parsed locally forever after.`
            : "Known brokers only — set a learning backend in .env to read a new one."}
        </p>
      </div>

      {result && (
        <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-left text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <div>
            <span className="font-semibold">{result.filename}</span> → <b>{result.owner}</b>: added{" "}
            <b>{result.tradesAdded}</b> new trade{result.tradesAdded === 1 ? "" : "s"},{" "}
            <b>{result.duplicatesSkipped}</b> duplicate{result.duplicatesSkipped === 1 ? "" : "s"}{" "}
            skipped (of {result.totalParsed} parsed).
          </div>
          <div className="mt-1 text-emerald-700 dark:text-emerald-400">
            Read as <b>{result.broker}</b>
            {result.parser === "learned"
              ? ` — new broker, so ${result.parserModel ?? "the model"} worked out the layout and the parser is now saved. The next upload won't need it.`
              : " — using the saved parser, no AI call needed."}
          </div>
          {result.parser === "learned" && result.parserNotes && (
            <div className="mt-1 text-emerald-600 dark:text-emerald-500">{result.parserNotes}</div>
          )}
          {!result.countMatches && (
            <div className="mt-1 text-amber-700 dark:text-amber-400">
              ⚠ Parsed count didn&apos;t match the report&apos;s stated total — check the file.
            </div>
          )}
          {result.warnings?.map((w, i) => (
            <div key={i} className="mt-1 text-amber-700 dark:text-amber-400">
              ⚠ {w}
            </div>
          ))}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg bg-rose-50 p-3 text-left text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          <div>{error}</div>
          {details.length > 0 && (
            <ul className="mt-1 list-disc pl-4 text-rose-600 dark:text-rose-400">
              {details.map((d, i) => (
                <li key={i}>{d}</li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

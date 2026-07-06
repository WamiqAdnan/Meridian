"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface ImportResult {
  filename: string;
  totalParsed: number;
  tradesAdded: number;
  duplicatesSkipped: number;
  countMatches: boolean;
  period?: string | null;
}

export default function UploadCard() {
  const router = useRouter();
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [result, setResult] = useState<ImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function upload(file: File) {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const body = new FormData();
      body.append("file", file);
      const res = await fetch("/api/import", { method: "POST", body });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Import failed");
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

  return (
    <div>
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
        accept="application/pdf,.pdf"
        className="hidden"
        onChange={(e) => onFiles(e.target.files)}
      />
      <p className="text-sm font-medium">
        {busy ? "Reading report…" : "Drop a Finqalab report PDF here, or click to choose"}
      </p>
        <p className="mt-1 text-xs text-neutral-500">
          Periodic Trade Details Report · trades are deduplicated by trade number
        </p>
      </div>

      {result && (
        <div className="mt-3 rounded-lg bg-emerald-50 p-3 text-left text-xs text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span className="font-semibold">{result.filename}</span>: added{" "}
          <b>{result.tradesAdded}</b> new trade{result.tradesAdded === 1 ? "" : "s"},{" "}
          <b>{result.duplicatesSkipped}</b> duplicate{result.duplicatesSkipped === 1 ? "" : "s"} skipped
          {" "}(of {result.totalParsed} parsed).
          {!result.countMatches && (
            <span className="block text-amber-700 dark:text-amber-400">
              ⚠ Parsed count didn&apos;t match the report&apos;s stated total — check the PDF.
            </span>
          )}
        </div>
      )}
      {error && (
        <div className="mt-3 rounded-lg bg-rose-50 p-3 text-left text-xs text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">
          {error}
        </div>
      )}
    </div>
  );
}

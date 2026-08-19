"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";

/**
 * Generate this market's weekly insight on demand.
 *
 * Deliberately a button rather than something a page render triggers: one
 * generation is a model call that can run for minutes against a local model, and
 * the answer is the same for the whole week. The label says so, because a control
 * that looks instant and isn't is worse than no control.
 */
export default function GenerateInsightButton({
  market,
  backend,
  hasInsight,
}: {
  market: string;
  backend: string | null;
  hasInsight: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  if (!backend) {
    return (
      <span
        className="text-xs text-muted"
        title="Set ANTHROPIC_API_KEY, or point AI_BASE_URL and AI_MODEL at a local model."
      >
        No model configured
      </span>
    );
  }

  async function generate() {
    setBusy(true);
    setNote(null);
    try {
      const res = await fetch("/api/insights", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ market, force: hasInsight }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? "Generation failed.");
      if (data.status === "skipped") setNote(`Nothing to explain: ${data.reason}.`);
      router.refresh();
    } catch (e) {
      setNote((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={generate}
        disabled={busy}
        title={`Runs on ${backend}. A local model can take several minutes.`}
        className="rounded-lg border border-line px-3 py-1.5 text-sm font-medium transition-colors hover:bg-surface-raised disabled:opacity-50"
      >
        {busy ? "Thinking…" : hasInsight ? "Regenerate insight" : "Generate insight"}
      </button>
      <span className="text-[11px] text-muted">{note ?? backend}</span>
    </div>
  );
}

"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { INVESTORS } from "@/lib/investors";

/** Inline dropdown to reassign a trade's owner; recomputes holdings on change. */
export default function OwnerSelect({ id, owner }: { id: number; owner: string }) {
  const router = useRouter();
  const [value, setValue] = useState(owner);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState(false);

  async function change(next: string) {
    const prev = value;
    setValue(next);
    setError(false);
    const res = await fetch(`/api/transactions/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ owner: next }),
    });
    if (!res.ok) {
      setValue(prev);
      setError(true);
      return;
    }
    startTransition(() => router.refresh());
  }

  return (
    <select
      value={value}
      disabled={pending}
      onChange={(e) => change(e.target.value)}
      className={`rounded-md border bg-transparent px-1.5 py-0.5 text-xs font-medium ${
        error ? "border-rose-400" : "border-neutral-300 dark:border-neutral-700"
      } ${pending ? "opacity-50" : ""}`}
    >
      {INVESTORS.map((name) => (
        <option key={name} value={name}>
          {name}
        </option>
      ))}
    </select>
  );
}

"use client";

import Form from "next/form";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useId, useRef, useState } from "react";
import { fmtPrice } from "@/lib/format";
import type { SearchRow } from "@/lib/search/view";

/**
 * The search box in the nav: find anything tracked, from anywhere in the app.
 *
 * Built on `next/form`, so it is a working GET form before any JavaScript runs —
 * submitting goes to `/search?q=`, which renders the same ranked results on the
 * server. The typeahead below is an enhancement on top of that, never the only way
 * in. Same instinct as the period switcher and the investor switcher, both of
 * which are plain links.
 *
 * Every row says *why* it is there when that is not obvious: a query for "bullion"
 * returning Gold looks like a bug until the row admits it matched a synonym.
 */

const DEBOUNCE_MS = 150;
const LIMIT = 8;

export default function AssetSearch() {
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);

  const [query, setQuery] = useState("");
  const [rows, setRows] = useState<SearchRow[]>([]);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Look up as you type.
   *
   * The abort on cleanup is what stops a slow answer to an old query overwriting a
   * fast answer to the current one. Clearing the box is handled in `onChange`
   * rather than here: resetting state in an effect body is a cascading render, and
   * an empty box is an event, not something to synchronise with.
   */
  useEffect(() => {
    const q = query.trim();
    if (!q) return;

    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetch(`/api/search?q=${encodeURIComponent(q)}&limit=${LIMIT}`, { signal: controller.signal })
        .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
        .then((data: { results?: SearchRow[] }) => {
          const found = data.results ?? [];
          setRows(found);
          setActive(found.length > 0 ? 0 : -1);
          setError(null);
          setOpen(true);
        })
        .catch((e: Error) => {
          if (e.name === "AbortError") return;
          setRows([]);
          setActive(-1);
          setError("Search is unavailable.");
          setOpen(true);
        })
        .finally(() => {
          if (!controller.signal.aborted) setBusy(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query]);

  /* Clicking anywhere else dismisses the list but keeps what was typed. */
  useEffect(() => {
    if (!open) return;
    function onPointerDown(event: PointerEvent) {
      if (!boxRef.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  /* ⌘K / Ctrl-K from anywhere. */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        inputRef.current?.focus();
        inputRef.current?.select();
      }
    }
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  function onChange(value: string) {
    setQuery(value);
    if (value.trim()) {
      setBusy(true);
      return;
    }
    setRows([]);
    setOpen(false);
    setBusy(false);
    setError(null);
  }

  function go(row: SearchRow) {
    setOpen(false);
    inputRef.current?.blur();
    router.push(row.href);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Escape") {
      setOpen(false);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (rows.length === 0) return;
      event.preventDefault();
      setOpen(true);
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + rows.length) % rows.length);
      return;
    }
    // Enter on a highlighted row opens that asset; Enter on none falls through to
    // the form, which is the whole-results page. Never preventDefault both ways.
    if (event.key === "Enter" && open && active >= 0 && rows[active]) {
      event.preventDefault();
      go(rows[active]);
    }
  }

  return (
    <div ref={boxRef} className="relative ml-auto w-40 shrink-0 sm:w-56 lg:w-72">
      <Form action="/search" onSubmit={() => setOpen(false)} className="flex">
        <input
          ref={inputRef}
          type="search"
          name="q"
          value={query}
          onChange={(e) => onChange(e.target.value)}
          onFocus={() => rows.length > 0 && setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder="Search assets…"
          autoComplete="off"
          role="combobox"
          aria-label="Search assets"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined}
          aria-busy={busy}
          className="w-full rounded-lg border border-line bg-surface px-2.5 py-1.5 text-sm placeholder:text-muted focus:border-accent"
        />
      </Form>

      {open && (
        <div className="absolute right-0 z-30 mt-1 w-[min(22rem,calc(100vw-2rem))] overflow-hidden rounded-lg border border-line bg-surface shadow-lg">
          {error ? (
            <p className="px-3 py-3 text-xs text-loss">{error}</p>
          ) : rows.length === 0 ? (
            <p className="px-3 py-3 text-xs text-muted">
              {busy ? "Searching…" : `Nothing tracked matches “${query.trim()}”.`}
            </p>
          ) : (
            <>
              {/* The option is the link, so a middle-click and a copied address
                  still work — a dropdown of divs quietly takes both away. */}
              <ul id={listId} role="listbox" aria-label="Matching assets" className="divide-y divide-line">
                {rows.map((row, i) => (
                  <li key={row.id}>
                    <Link
                      id={`${listId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      href={row.href}
                      onClick={() => setOpen(false)}
                      onMouseEnter={() => setActive(i)}
                      className={`flex items-baseline gap-2 px-3 py-2 text-sm ${
                        i === active ? "bg-surface-raised" : ""
                      }`}
                    >
                      <span className="font-medium">{row.symbol}</span>
                      <span className="min-w-0 flex-1 truncate text-xs text-muted">
                        {row.name}
                        {row.note && <span className="italic"> · {row.note}</span>}
                      </span>
                      {row.held && (
                        <span className="shrink-0 rounded border border-line px-1 text-[10px] text-muted">
                          held
                        </span>
                      )}
                      <span className="shrink-0 text-xs tabular-nums text-muted">
                        {fmtPrice(row.price, row.currency)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
              <Link
                href={`/search?q=${encodeURIComponent(query.trim())}`}
                onClick={() => setOpen(false)}
                className="block border-t border-line px-3 py-2 text-xs text-muted hover:bg-surface-raised hover:text-foreground"
              >
                All results for “{query.trim()}” →
              </Link>
            </>
          )}
        </div>
      )}
    </div>
  );
}

"use client";

import { useEffect } from "react";
import Link from "next/link";

/**
 * The error boundary for every route.
 *
 * Almost everything that can throw in this app is a read of data a provider was
 * meant to have filled in, so "try again" is a genuinely likely fix rather than
 * the usual empty gesture — `unstable_retry` re-renders the segment on the
 * server, which re-runs the query and any refresh behind it.
 *
 * **The prop is `unstable_retry`, not `reset`.** Next 16 renamed it; a boundary
 * written from memory type-checks against `any` and then renders a button that
 * calls `undefined()`, which is an error page that throws when you click it.
 *
 * `error.message` is only the real message in development. In production it is a
 * generic string plus `digest`, which is deliberate — the message could carry a
 * connection string — so the digest is shown as the thing to grep the server log
 * for rather than hidden.
 */
export default function Error({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <div className="mx-auto w-full max-w-2xl px-4 py-20 sm:px-6">
      <p className="text-sm font-medium uppercase tracking-wide text-loss">Error</p>
      <h1 className="mt-2 text-2xl font-bold tracking-tight">This page did not load</h1>
      <p className="mt-2 text-sm text-muted">
        Something threw while the page was being built on the server. Prices, news and
        insights are all read from local storage, so the page itself is usually the
        only thing that is broken — the data is still there.
      </p>

      <div className="mt-6 flex flex-wrap gap-3">
        <button
          type="button"
          onClick={() => unstable_retry()}
          className="rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium hover:border-accent"
        >
          Try again
        </button>
        <Link
          href="/"
          className="rounded-lg border border-line px-4 py-2 text-sm font-medium text-muted hover:border-accent hover:text-foreground"
        >
          Back to the overview
        </Link>
      </div>

      <dl className="mt-8 space-y-1 text-xs text-muted">
        {error.digest && (
          <div>
            <dt className="inline font-medium">Digest </dt>
            <dd className="inline font-mono">{error.digest}</dd>
            <span> — grep the server log for this.</span>
          </div>
        )}
        <div>
          <dt className="inline font-medium">Message </dt>
          <dd className="inline">{error.message || "withheld in production"}</dd>
        </div>
      </dl>
    </div>
  );
}

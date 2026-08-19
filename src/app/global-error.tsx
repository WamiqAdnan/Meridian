"use client";

import "./globals.css";

/**
 * The last resort: an error thrown by the root layout itself, where there is no
 * shell left to render into.
 *
 * It replaces the root layout, so it has to supply its own `<html>` and `<body>`
 * — and it cannot rely on the fonts, which are loaded by the layout it is
 * standing in for. Only the stylesheet is imported, so the tokens still resolve
 * in both themes; the type falls back to the system stack on purpose rather than
 * importing a font at the moment the app is least able to load one.
 */
export default function GlobalError({
  error,
  unstable_retry,
}: {
  error: Error & { digest?: string };
  unstable_retry: () => void;
}) {
  return (
    <html lang="en">
      <body className="bg-background text-foreground">
        <div className="mx-auto w-full max-w-2xl px-4 py-20 sm:px-6">
          <p className="text-sm font-medium uppercase tracking-wide text-loss">Error</p>
          <h1 className="mt-2 text-2xl font-bold tracking-tight">The app did not start</h1>
          <p className="mt-2 text-sm text-muted">
            Something threw before any page could render. This is the root layout
            failing, so a reload is worth trying before anything else.
          </p>
          <button
            type="button"
            onClick={() => unstable_retry()}
            className="mt-6 rounded-lg border border-line bg-surface-raised px-4 py-2 text-sm font-medium hover:border-accent"
          >
            Try again
          </button>
          {error.digest && (
            <p className="mt-8 text-xs text-muted">
              Digest <span className="font-mono">{error.digest}</span> — grep the server log
              for this.
            </p>
          )}
        </div>
      </body>
    </html>
  );
}

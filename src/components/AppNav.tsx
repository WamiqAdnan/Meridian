"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { BRAND } from "@/lib/brand";

/**
 * The primary navigation, shared by every page.
 *
 * Every existing route is kept and unchanged; `Markets` is the only addition.
 * `Overview` and `Insights` join once the pages behind them exist — a nav link
 * to a 404 is worse than a shorter nav.
 */
const LINKS = [
  { href: "/", label: "Portfolio" },
  { href: "/markets", label: "Markets" },
  { href: "/transactions", label: "Transactions" },
  { href: "/replicate", label: "Replicate" },
];

export default function AppNav() {
  const pathname = usePathname();

  const isActive = (href: string) =>
    href === "/" ? pathname === "/" : pathname === href || pathname.startsWith(`${href}/`);

  return (
    <header className="sticky top-0 z-20 border-b border-line bg-background/85 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-7xl items-center gap-6 px-4 py-3 sm:px-6">
        <Link href="/" className="flex shrink-0 items-baseline gap-2">
          <span className="text-base font-semibold tracking-tight">{BRAND.name}</span>
          <span className="hidden text-xs text-muted sm:inline">{BRAND.tagline}</span>
        </Link>

        <nav className="flex items-center gap-0.5 overflow-x-auto" aria-label="Primary">
          {LINKS.map((link) => {
            const active = isActive(link.href);
            return (
              <Link
                key={link.href}
                href={link.href}
                aria-current={active ? "page" : undefined}
                className={`whitespace-nowrap rounded-md px-2.5 py-1.5 text-sm transition-colors ${
                  active
                    ? "bg-surface-raised font-medium text-foreground"
                    : "text-muted hover:bg-surface-raised hover:text-foreground"
                }`}
              >
                {link.label}
              </Link>
            );
          })}
        </nav>
      </div>
    </header>
  );
}

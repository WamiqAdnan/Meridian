import Link from "next/link";
import { fmtPrice } from "@/lib/format";
import { assetHref } from "@/lib/routes";
import Change from "./Change";
import type { AssetView } from "@/lib/markets/view";
import type { Mover } from "@/lib/markets/performance";
import { MARKET_META } from "@/lib/markets/types";

/**
 * A ranked list of movers.
 *
 * Each row names the market it came from, because the whole point of a
 * cross-market list is that a PSX cement stock and a US energy ETF can sit next
 * to each other and you can still tell which is which.
 *
 * Each row links to the *asset*, not its market. A reader who clicks a mover wants
 * that mover; sending them to the market page it happened to be listed under —
 * which is what this did before `/assets/[id]` existed — answers a question they
 * did not ask.
 */
export default function MoversList({
  title,
  movers,
  emptyLabel = "Not enough price history yet.",
}: {
  title: string;
  movers: Mover<AssetView>[];
  emptyLabel?: string;
}) {
  return (
    <div>
      <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">{title}</h3>
      {movers.length === 0 ? (
        <p className="rounded-lg border border-dashed border-line px-3 py-4 text-xs text-muted">
          {emptyLabel}
        </p>
      ) : (
        <ul className="divide-y divide-line overflow-hidden rounded-lg border border-line bg-surface">
          {movers.map(({ item, changePct, change }) => (
            <li key={item.id}>
              <Link
                href={assetHref(item.id)}
                className="flex items-center justify-between gap-3 px-3 py-2 text-sm hover:bg-surface-raised"
              >
                <span className="min-w-0">
                  <span className="font-medium">{item.symbol}</span>
                  <span className="ml-2 truncate text-xs text-muted">
                    {MARKET_META[item.market].label}
                  </span>
                </span>
                <span className="flex shrink-0 items-baseline gap-3">
                  <span className="text-xs tabular-nums text-muted">
                    {fmtPrice(item.price, item.currency)}
                  </span>
                  <Change
                    changePct={changePct}
                    change={change}
                    currency={item.currency}
                    className="w-20 text-right text-sm font-medium"
                  />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

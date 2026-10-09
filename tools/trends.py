#!/usr/bin/env python3
"""
trends.py - Google Trends demand analysis for a local service (salon by default).
Standalone: shares no code with leadfinder.py or market.py.

Answers:
  * What is RISING vs FALLING right now?        (momentum: last 4 weeks vs the 8 before)
  * WHEN does demand peak?                       (peak week + peak month = promo calendar)
  * WHERE is interest highest?                   (province / city breakdown)
  * What related searches are breaking out?      (rising related queries)

Setup:
  pip install -U pytrends pandas

Usage:
  python trends.py                                   # default salon terms, South Africa, last 12 months
  python trends.py --terms "knotless braids,lace front wig,gel nails,lashes,barber" --geo ZA
  python trends.py --geo ZA-GP --timeframe "today 5-y"     # Gauteng only, 5-year view (best for seasonality)
  python trends.py --resolution CITY                       # city-level breakdown instead of province

Outputs (prefix configurable with --out-prefix):
  trends_summary.csv      one row per term: average, momentum %, direction, peak week/month
  trends_over_time.csv    weekly/monthly series, all terms on one comparable scale
  trends_regions.csv      relative interest by region
  trends_rising.csv       rising related queries per term

Notes:
  * pytrends is an UNOFFICIAL wrapper. Google rate-limits it (HTTP 429); the script backs off
    and retries, but if it keeps failing wait a few minutes or lower the number of terms.
  * Values are relative (0-100), not search counts. With more than 5 terms the first term is
    used as an anchor in every batch so all terms share one scale.
"""
import argparse
import sys
import time

DEFAULT_TERMS = ("knotless braids,lace front wig,gel nails,acrylic nails,"
                 "hair salon,eyelash extensions,barber,hair braiding")


# ------------------------------------------------------------------ Fetch (network)
def _retry(fn, tries=4, base=10):
    """Back off and retry only on rate limits / timeouts; other errors fail at once."""
    for i in range(tries):
        try:
            return fn()
        except Exception as e:  # noqa: BLE001
            msg = str(e)
            if "429" in msg or "Too Many" in msg or "timed out" in msg.lower() or "Timeout" in type(e).__name__:
                wait = base * (2 ** i)
                print(f"[!] rate limited / transient error, waiting {wait}s ({i+1}/{tries})", file=sys.stderr)
                time.sleep(wait)
            else:
                raise
    raise RuntimeError("Google Trends kept refusing. Wait a few minutes and retry.")


def fetch_over_time(terms, geo, timeframe):
    """Return one DataFrame (index=date, columns=terms) on a single comparable scale."""
    import pandas as pd
    from pytrends.request import TrendReq
    pt = TrendReq(hl="en-ZA", tz=-120, timeout=(10, 30))
    anchor, rest = terms[0], terms[1:]
    batches = [rest[i:i + 4] for i in range(0, len(rest), 4)] or [[]]
    frames, anchor_mean_first = [], None
    for b in batches:
        kw = [anchor] + b
        _retry(lambda: pt.build_payload(kw, geo=geo, timeframe=timeframe))
        df = _retry(pt.interest_over_time)
        if df is None or df.empty:
            continue
        if "isPartial" in df.columns:
            # The current week/month is incomplete and always looks low; keeping it
            # drags "recent" down and hides rising terms.
            df = df[df["isPartial"].astype(str) != "True"].drop(columns=["isPartial"])
        a_mean = df[anchor].mean()
        if anchor_mean_first is None:
            anchor_mean_first = a_mean
            scaled = df
        else:
            scale = (anchor_mean_first / a_mean) if a_mean else 1.0
            scaled = df.drop(columns=[anchor]) * scale
        frames.append(scaled)
        time.sleep(2)
    if not frames:
        raise RuntimeError("No data returned. Terms may be too niche for this geo/timeframe.")
    return pd.concat(frames, axis=1)


def fetch_regions(terms, geo, resolution):
    import pandas as pd
    from pytrends.request import TrendReq
    pt = TrendReq(hl="en-ZA", tz=-120, timeout=(10, 30))
    parts = []
    for t in terms:
        try:
            _retry(lambda: pt.build_payload([t], geo=geo, timeframe="today 12-m"))
            df = _retry(lambda: pt.interest_by_region(resolution=resolution, inc_low_vol=True))
        except Exception as e:  # noqa: BLE001 - one term without data shouldn't stop the run
            print(f"[!] no region data for '{t}': {e}", file=sys.stderr)
            continue
        if df is not None and not df.empty:
            parts.append(df[[t]])
        time.sleep(2)
    return pd.concat(parts, axis=1) if parts else pd.DataFrame()


def fetch_rising(terms, geo, timeframe):
    import pandas as pd
    from pytrends.request import TrendReq
    pt = TrendReq(hl="en-ZA", tz=-120, timeout=(10, 30))
    rows = []
    for t in terms:
        try:
            _retry(lambda: pt.build_payload([t], geo=geo, timeframe=timeframe))
            rq = (_retry(pt.related_queries) or {}).get(t) or {}
        except Exception as e:  # noqa: BLE001 - pytrends raises IndexError when a term has none
            print(f"[!] no related searches for '{t}': {e}", file=sys.stderr)
            continue
        rising = rq.get("rising")
        if rising is not None and not rising.empty:
            for _, r in rising.head(8).iterrows():
                rows.append({"term": t, "rising_query": r["query"], "growth": r["value"]})
        time.sleep(2)
    return pd.DataFrame(rows)


# ------------------------------------------------------------------ Analysis (pure)
def summarize(df):
    """df: index=datetime, columns=terms. Returns summary DataFrame, strongest momentum first."""
    import pandas as pd
    rows = []
    for t in df.columns:
        s = df[t].astype(float)
        n = len(s)
        recent_n = max(1, min(4, n // 3))
        prior_n = max(1, min(8, n - recent_n))
        recent = s.iloc[-recent_n:].mean()
        prior = s.iloc[-(recent_n + prior_n):-recent_n].mean() if n > recent_n else float("nan")
        if prior and prior == prior and prior > 0:
            momentum = round(100 * (recent - prior) / prior, 1)
        else:
            momentum = float("nan")
        avg = s.mean()
        vs_avg = round(100 * (recent - avg) / avg, 1) if avg else float("nan")
        # short-term momentum catches sharp moves; level-vs-average catches slow sustained climbs/declines
        if momentum != momentum:
            direction = "unknown"
        elif momentum >= 15 or (vs_avg >= 30 and momentum >= 0):
            direction = "RISING"
        elif momentum <= -15 or (vs_avg <= -30 and momentum <= 0):
            direction = "FALLING"
        else:
            direction = "steady"
        peak_idx = s.idxmax()
        by_month = s.groupby(s.index.month).mean()
        rows.append({
            "term": t,
            "avg_interest": round(s.mean(), 1),
            "latest_4wk_avg": round(recent, 1),
            "momentum_pct": momentum,
            "vs_average_pct": vs_avg,
            "direction": direction,
            "peak_week": peak_idx.strftime("%Y-%m-%d"),
            "peak_month": pd.Timestamp(2000, int(by_month.idxmax()), 1).strftime("%B"),
            "low_month": pd.Timestamp(2000, int(by_month.idxmin()), 1).strftime("%B"),
        })
    out = pd.DataFrame(rows)
    return out.sort_values("momentum_pct", ascending=False, na_position="last").reset_index(drop=True)


# ------------------------------------------------------------------ Main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--terms", default=DEFAULT_TERMS, help="comma-separated search terms")
    ap.add_argument("--geo", default="ZA", help='"ZA" country, or province e.g. "ZA-GP" (Gauteng), "ZA-WC", "ZA-KZN"')
    ap.add_argument("--timeframe", default="today 12-m",
                    help='"today 12-m", "today 5-y" (best for seasonality), or "2024-01-01 2026-10-01"')
    ap.add_argument("--resolution", default="REGION", choices=["REGION", "CITY"])
    ap.add_argument("--no-regions", action="store_true", help="skip region breakdown")
    ap.add_argument("--no-rising", action="store_true", help="skip rising related queries")
    ap.add_argument("--out-prefix", default="trends")
    args = ap.parse_args()

    terms = [t.strip() for t in args.terms.split(",") if t.strip()]
    if not terms:
        sys.exit("Give at least one term.")

    print(f"[*] {len(terms)} terms | geo={args.geo} | {args.timeframe}")
    df = fetch_over_time(terms, args.geo, args.timeframe)
    df.to_csv(f"{args.out_prefix}_over_time.csv", index_label="date")
    summary = summarize(df)
    summary.to_csv(f"{args.out_prefix}_summary.csv", index=False)
    print("\n=== Momentum (last ~4 weeks vs the 8 before) ===")
    print(summary.to_string(index=False))

    if not args.no_regions:
        reg = fetch_regions(terms, args.geo, args.resolution)
        if not reg.empty:
            reg.to_csv(f"{args.out_prefix}_regions.csv", index_label="region")
            print("\n=== Top region per term ===")
            for t in reg.columns:
                print(f"{t:<24} {reg[t].idxmax()} ({int(reg[t].max())})")

    if not args.no_rising:
        rising = fetch_rising(terms, args.geo, args.timeframe)
        if not rising.empty:
            rising.to_csv(f"{args.out_prefix}_rising.csv", index=False)
            print("\n=== Breakout related searches ===")
            print(rising.head(15).to_string(index=False))

    print(f"\n[+] wrote {args.out_prefix}_*.csv")


if __name__ == "__main__":
    main()

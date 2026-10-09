#!/usr/bin/env python3
"""
market.py - local market gap + competitor complaint finder.
Standalone: shares no code with leadfinder.py.

What it answers (for a salon, gym, dentist... any local service):
  1. WHERE is the gap?   Per suburb: how many competitors, how many are genuinely
                         strong, how much customer activity (reviews) there is, and
                         service gaps (no Sunday hours, no evening hours, no website).
  2. WHAT do customers hate about the competition?  Complaint themes mined from
                         low-star reviews (waiting, booking, price, quality, hygiene...).

Setup:
  pip install -U httpx
  export GOOGLE_PLACES_API_KEY="your-key"     # Places API (New) enabled

Usage:
  python market.py --suburbs "Randburg,Sandton,Fourways,Roodepoort" --city Johannesburg
  python market.py --suburbs "Randburg,Sandton" --city Johannesburg --category "nail salon" --reviews

Outputs (prefix configurable with --out-prefix):
  market_suburbs.csv     ranked suburb opportunity table
  market_salons.csv      every competitor found
  market_complaints.csv  complaint themes (only with --reviews)

Notes:
  * --reviews requests the reviews field, which Google bills at a higher tier, and
    Google only returns up to 5 reviews per place, so complaint counts are a SAMPLE.
  * 'opportunity' is a proxy (customer activity per strong competitor), not a revenue
    forecast. Population/income data is not included - sanity-check the top suburbs.
"""
import argparse
import csv
import os
import re
import statistics
import sys
from collections import Counter, defaultdict

SEARCH_URL = "https://places.googleapis.com/v1/places:searchText"
BASE_FIELDS = [
    "places.id", "places.displayName", "places.formattedAddress", "places.rating",
    "places.userRatingCount", "places.websiteUri", "places.nationalPhoneNumber",
    "places.googleMapsUri", "places.businessStatus", "places.regularOpeningHours",
]
STRONG_RATING, STRONG_REVIEWS = 4.5, 20

COMPLAINT_THEMES = {
    "waiting / running late": r"\b(wait(ed|ing)?|late|delay(ed)?|took (so |too )?long|slow|running behind|hours? (to|for))\b",
    "booking / no response": r"\b(no (answer|response|reply)|(didn'?t|never|not) (answer|reply|respond|pick)|walk[- ]?ins?|double[- ]?booked|cancel(l?ed)?|appointment)\b",
    "price / hidden charges": r"\b(expensive|overpriced|over[- ]?charged|rip[- ]?off|too much|hidden|extra charge|pricey)\b",
    "poor quality / damage": r"\b(damag(e|ed)|burn(t|ed)?|ruin(ed)?|uneven|botch(ed)?|messy|poor (quality|work|service)|not what i (asked|wanted)|disappoint(ed|ing)|bad (cut|job|colou?r))\b",
    "hygiene": r"\b(dirty|unhygienic|hygiene|filthy|smell(y|s)?|unclean|not clean)\b",
    "staff attitude": r"\b(rude|attitude|unprofessional|ignored|disrespect(ful)?|arrogant|unfriendly)\b",
    "parking / safety / location": r"\b(parking|unsafe|security|hard to find|no parking)\b",
    "hours / closed": r"\b(closed|didn'?t open|not open|opening hours|open late)\b",
}


# ------------------------------------------------------------------ Places
def search_places(api_key, query, max_pages=2, with_reviews=False):
    import httpx
    fields = ["nextPageToken"] + BASE_FIELDS + (["places.reviews"] if with_reviews else [])
    headers = {"X-Goog-Api-Key": api_key, "X-Goog-FieldMask": ",".join(fields),
               "Content-Type": "application/json"}
    body = {"textQuery": query, "pageSize": 20}
    out, token = [], None
    for _ in range(max_pages):
        if token:
            body["pageToken"] = token
        r = httpx.post(SEARCH_URL, json=body, headers=headers, timeout=30)
        if r.status_code != 200:
            print(f"[!] Places API error {r.status_code}: {r.text[:300]}", file=sys.stderr)
            break
        data = r.json()
        out.extend(data.get("places", []))
        token = data.get("nextPageToken")
        if not token:
            break
    return out


# ------------------------------------------------------------------ Analysis (pure)
def opening_flags(place):
    """(open_sunday, open_late) from regularOpeningHours.periods; None if unknown."""
    periods = (place.get("regularOpeningHours") or {}).get("periods")
    if not periods:
        return None, None
    open_sun = any((p.get("open") or {}).get("day") == 0 for p in periods)

    def closes_late(p):
        close = p.get("close")
        if not close:  # no close time = open 24 hours
            return True
        opened = p.get("open") or {}
        if close.get("day") is not None and close.get("day") != opened.get("day"):
            return True  # closes after midnight
        return close.get("hour", 0) >= 19

    open_late = any(closes_late(p) for p in periods)
    return open_sun, open_late


def is_strong(row):
    return (row["rating"] or 0) >= STRONG_RATING and (row["reviews"] or 0) >= STRONG_REVIEWS


def analyze_suburbs(rows):
    """rows: dicts with suburb, rating, reviews, has_site, open_sunday, open_late."""
    by_sub = defaultdict(list)
    for r in rows:
        by_sub[r["suburb"]].append(r)
    out = []
    for sub, rs in by_sub.items():
        n = len(rs)
        strong = sum(1 for r in rs if is_strong(r))
        rated = [r["rating"] for r in rs if r["rating"]]
        total_reviews = sum(r["reviews"] or 0 for r in rs)
        known_sun = [r["open_sunday"] for r in rs if r["open_sunday"] is not None]
        known_late = [r["open_late"] for r in rs if r["open_late"] is not None]
        out.append({
            "suburb": sub,
            "competitors": n,
            "strong_competitors": strong,
            "avg_rating": round(statistics.mean(rated), 2) if rated else "",
            "total_reviews": total_reviews,
            "pct_no_website": round(100 * sum(1 for r in rs if not r["has_site"]) / n),
            "pct_open_sunday": round(100 * sum(known_sun) / len(known_sun)) if known_sun else "",
            "pct_open_late": round(100 * sum(known_late) / len(known_late)) if known_late else "",
            # customer activity per strong competitor: high = busy market, few good options
            "opportunity": round(total_reviews / (1 + strong), 1),
        })
    out.sort(key=lambda s: -s["opportunity"])
    return out


def describe_angle(s):
    """Plain-English reading of one suburb row."""
    bits = []
    if s["strong_competitors"] <= 2 and s["competitors"] >= 8:
        bits.append("busy but few strong players")
    if s["pct_open_sunday"] != "" and s["pct_open_sunday"] <= 25:
        bits.append("Sunday hours are a gap")
    if s["pct_open_late"] != "" and s["pct_open_late"] <= 25:
        bits.append("evening hours are a gap")
    if s["pct_no_website"] >= 50:
        bits.append("most have no website (online booking is a gap)")
    return "; ".join(bits) or "no obvious gap - compete on quality/brand"


def review_text(rv):
    t = (rv.get("text") or {}).get("text") or (rv.get("originalText") or {}).get("text") or ""
    return t.strip()


def mine_complaints(places, max_stars=3):
    """Count complaint themes in low-star reviews. Returns (Counter, examples, n_reviews)."""
    counts, examples, n = Counter(), defaultdict(list), 0
    for p in places:
        for rv in p.get("reviews") or []:
            if (rv.get("rating") or 5) > max_stars:
                continue
            txt = review_text(rv)
            if not txt:
                continue
            n += 1
            low = txt.lower()
            for theme, pat in COMPLAINT_THEMES.items():
                if re.search(pat, low):
                    counts[theme] += 1
                    if len(examples[theme]) < 3:
                        examples[theme].append(txt[:160].replace("\n", " "))
    return counts, examples, n


# ------------------------------------------------------------------ Main
def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--suburbs", required=True, help='comma-separated, e.g. "Randburg,Sandton"')
    ap.add_argument("--city", default="", help='appended to each suburb, e.g. "Johannesburg"')
    ap.add_argument("--category", default="hair salon", help='business type, e.g. "hair salon"')
    ap.add_argument("--pages", type=int, default=2, help="pages of 20 per suburb (max ~3)")
    ap.add_argument("--reviews", action="store_true", help="also mine low-star review complaints (higher API tier)")
    ap.add_argument("--out-prefix", default="market")
    args = ap.parse_args()

    key = os.environ.get("GOOGLE_PLACES_API_KEY")
    if not key:
        sys.exit("Set GOOGLE_PLACES_API_KEY first (Google Cloud > Places API (New)).")

    seen, rows, raw = set(), [], []
    for sub in [s.strip() for s in args.suburbs.split(",") if s.strip()]:
        place = f"{sub}, {args.city}" if args.city else sub
        query = f"{args.category} in {place}"
        print(f"[*] searching: {query}")
        for p in search_places(key, query, args.pages, args.reviews):
            pid = p.get("id")
            if pid in seen or p.get("businessStatus") not in (None, "OPERATIONAL"):
                continue
            seen.add(pid)
            sun, late = opening_flags(p)
            rows.append({
                "suburb": sub,
                "name": p.get("displayName", {}).get("text", ""),
                "rating": p.get("rating"),
                "reviews": p.get("userRatingCount", 0),
                "strong": "",
                "has_site": bool(p.get("websiteUri")),
                "website": p.get("websiteUri", ""),
                "phone": p.get("nationalPhoneNumber", ""),
                "open_sunday": sun,
                "open_late": late,
                "address": p.get("formattedAddress", ""),
                "maps": p.get("googleMapsUri", ""),
            })
            rows[-1]["strong"] = is_strong(rows[-1])
            raw.append(p)

    if not rows:
        sys.exit("No results. Check the API key / billing / category.")

    stats = analyze_suburbs(rows)
    with open(f"{args.out_prefix}_suburbs.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(stats[0].keys()))
        w.writeheader(); w.writerows(stats)
    rows.sort(key=lambda r: (-(r["reviews"] or 0)))
    with open(f"{args.out_prefix}_salons.csv", "w", newline="", encoding="utf-8-sig") as f:
        w = csv.DictWriter(f, fieldnames=list(rows[0].keys()))
        w.writeheader(); w.writerows(rows)

    print(f"\n=== Suburb opportunity ({args.category}) ===")
    for s in stats[:8]:
        print(f"{s['suburb']:<18} comp={s['competitors']:<3} strong={s['strong_competitors']:<2} "
              f"reviews={s['total_reviews']:<6} opp={s['opportunity']:<8} -> {describe_angle(s)}")

    if args.reviews:
        counts, examples, n = mine_complaints(raw)
        with open(f"{args.out_prefix}_complaints.csv", "w", newline="", encoding="utf-8-sig") as f:
            w = csv.writer(f)
            w.writerow(["theme", "mentions", "share_of_low_star_reviews", "example"])
            for theme, c in counts.most_common():
                w.writerow([theme, c, f"{100*c/max(n,1):.0f}%", " | ".join(examples[theme][:1])])
        print(f"\n=== Competitor complaints (sample of {n} low-star reviews) ===")
        for theme, c in counts.most_common():
            print(f"{c:>3}  {theme}")
        if n < 30:
            print("(small sample - Google returns <=5 reviews/place; treat as directional)")

    print(f"\n[+] wrote {args.out_prefix}_suburbs.csv, {args.out_prefix}_salons.csv"
          + (f", {args.out_prefix}_complaints.csv" if args.reviews else ""))


if __name__ == "__main__":
    main()

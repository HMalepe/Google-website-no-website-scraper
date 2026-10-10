// Instagram audience size + engagement for leads whose only "website" is an
// Instagram profile, via Meta's official Business Discovery API (no scraping).
// Works for public Instagram business/creator accounts only, looked up by
// username. Ported from the ig_enrich.py script; used by the dashboard's Instagram tab.
//
// A SOCIAL_ONLY lead with a big, engaged audience is the strongest pitch:
// proven demand, but no storefront they own.

const RESERVED = new Set([
  "p", "reel", "reels", "tv", "stories", "explore", "accounts", "direct",
  "about", "legal", "developer", "web", "challenge", "directory",
]);
// Meta error codes: rate limits (back off) and token problems (stop the run).
const RATE_LIMIT_CODES = new Set([4, 17, 32, 613, 80002]);
const TOKEN_CODES = new Set([190, 102]);
export const HANDLE_PATTERN = /^[A-Za-z0-9._]{1,30}$/;

/** instagram.com/<handle>[/...] -> handle; posts, reels, explore etc. are not profiles. */
export function extractHandle(url) {
  let value = String(url || "").trim();
  if (!value) return null;
  if (!value.includes("://")) value = `https://${value}`;
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase().replace(/^(www\.|m\.)/, "");
  if (host !== "instagram.com" && host !== "instagr.am") return null;
  const first = parsed.pathname.split("/").filter(Boolean)[0];
  if (!first || RESERVED.has(first.toLowerCase())) return null;
  const handle = first.replace(/^@/, "");
  return HANDLE_PATTERN.test(handle) ? handle : null;
}

/** Mean (likes + comments) per recent post as % of followers -> { value, note }. */
export function engagementPct(followers, media) {
  if (!followers || !media?.length) return { value: null, note: "no recent posts" };
  let hidden = 0;
  const totals = media.map((m) => {
    if (m.like_count === undefined || m.like_count === null) hidden++;
    return (m.like_count || 0) + (m.comments_count || 0);
  });
  const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
  return {
    value: Math.round((10000 * mean) / followers) / 100,
    note: hidden ? "likes hidden on some posts - engagement understated" : "",
  };
}

/** Graph API JSON -> { ok, followers, posts, engagement, note } or { ok: false, error, code }. */
export function parseDiscovery(payload) {
  if (payload?.error) {
    const e = payload.error;
    return { ok: false, code: e.code ?? null, error: e.error_user_title || String(e.message || "").slice(0, 120) };
  }
  const bd = payload?.business_discovery;
  if (!bd) return { ok: false, code: null, error: "empty response" };
  const followers = bd.followers_count ?? null;
  const { value, note } = engagementPct(followers, bd.media?.data || []);
  return { ok: true, followers, posts: bd.media_count ?? null, engagement: value, note };
}

export function pitchHint(followers, engagement) {
  const bits = [`${Number(followers || 0).toLocaleString("en-ZA")} followers`];
  if (engagement !== null && engagement !== undefined) bits.push(`${engagement}% engagement`);
  bits.push("sales depend on DMs/Instagram - no site they own, no online booking/ordering");
  return bits.join("; ");
}

export class InstagramTokenError extends Error {}

/**
 * Look one handle up. Retries rate limits with backoff (30s, 60s, 120s...);
 * throws InstagramTokenError for an expired/invalid token so the run stops.
 */
export async function lookup(handle, { userId, token, apiVersion = "", baseUrl, fetchImpl = fetch, sleep, retries = 4 }) {
  if (!HANDLE_PATTERN.test(handle)) return { ok: false, code: null, error: "invalid handle" };
  const wait = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const root = (baseUrl || "https://graph.facebook.com").replace(/\/$/, "");
  const url = new URL(`${root}/${apiVersion ? `${apiVersion}/` : ""}${userId}`);
  url.searchParams.set(
    "fields",
    `business_discovery.username(${handle}){followers_count,media_count,media.limit(12){like_count,comments_count}}`
  );
  url.searchParams.set("access_token", token);

  for (let attempt = 0; attempt < retries; attempt++) {
    let result;
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(30_000) });
      result = parseDiscovery(await res.json().catch(() => ({ error: { message: `bad response ${res.status}` } })));
    } catch (err) {
      result = { ok: false, code: null, error: `network error: ${err.message}` };
    }
    if (result.ok) return result;
    if (RATE_LIMIT_CODES.has(result.code)) {
      await wait(30_000 * 2 ** attempt);
      continue;
    }
    if (TOKEN_CODES.has(result.code)) throw new InstagramTokenError(result.error || "access token problem");
    return result;
  }
  return { ok: false, code: null, error: "gave up after rate limits" };
}

/** Check credentials: who does this token belong to? -> { ok, username } or { ok: false, error }. */
export async function verifyAccount({ userId, token, apiVersion = "", baseUrl, fetchImpl = fetch }) {
  const root = (baseUrl || "https://graph.facebook.com").replace(/\/$/, "");
  const url = new URL(`${root}/${apiVersion ? `${apiVersion}/` : ""}${userId}`);
  url.searchParams.set("fields", "username");
  url.searchParams.set("access_token", token);
  try {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000) });
    const data = await res.json().catch(() => ({}));
    if (data.error) return { ok: false, error: data.error.error_user_title || data.error.message || "Meta rejected the token" };
    return { ok: true, username: data.username || "" };
  } catch (err) {
    return { ok: false, error: `can't reach Meta: ${err.message}` };
  }
}

/** Leads with an Instagram profile as their website, one entry per handle. */
export function handlesFromLeads(leads) {
  const seen = new Set();
  const out = [];
  for (const lead of leads) {
    const handle = extractHandle(lead.website);
    if (!handle || seen.has(handle.toLowerCase())) continue;
    seen.add(handle.toLowerCase());
    out.push({ handle, lead });
  }
  return out;
}

// Cloudflare Pages Function — server-side first-party capture for ad-tech.
// =============================================================================
//
// WHY THIS MATTERS
//   Adblockers (Brave Aggressive, uBlock Hard Mode, Privacy Badger, ...) routinely
//   block the JS-side cookie creation done by `fbevents.js`, `gtag.js` and even our
//   own `lib/`. Setting cookies + injecting context server-side closes that gap:
//   every HTML response carries identity + attribution + device + geo data captured
//   AT THE EDGE before any browser script executes.
//
//   Client-side libraries (`lib/konclui-tracking.ts`, `lib/utm.ts`, `lib/tracking.ts`)
//   READ these cookies as the canonical source. Their JS-side capture stays as
//   redundant fallback for the rare case where the edge worker missed something
//   (e.g. SPA route change without a fresh request).
//
// WHAT THE MIDDLEWARE SETS / INJECTS
//
//   Cookies (first-party, SameSite=Lax, Secure):
//     - _fbc, _fbp                       — Meta canonical (Pixel-compatible names)
//     - _konclui_uid                     — durable external_id (UUID v4, 400d)
//     - _gclid / _gbraid / _wbraid /
//       _gclsrc / _dclid / _gad_source   — Google Ads click IDs
//     - _msclkid                         — Microsoft/Bing
//     - _ttclid                          — TikTok
//     - _twclid                          — X/Twitter
//     - _li_fat_id                       — LinkedIn
//     - _sccid                           — Snapchat
//     - _epik                            — Pinterest
//     - _rdt_cid                         — Reddit
//     - _tblci                           — Taboola
//     - _ob_orig_url                     — Outbrain
//     - _qclid                           — Quora
//     - _ymclk                           — Yahoo DSP
//     - k_attr_ft / k_attr_lt            — UTM first-touch / last-touch JSON
//     - _kc_landing_first                — first landing URL (full)
//     - _kc_referrer_first               — first referrer (Referer header)
//     - _kc_first_seen                   — ISO timestamp of first ever visit
//     - _kc_visit_count                  — incremented every full page hit
//     - _kc_session_id                   — UUID rotated every 30min idle
//     - _kc_bot_score                    — Cloudflare Bot Management 1..99
//
//   Window globals injected into `<head>`:
//     - __cfGeo      — { ct, st, zp, lat, lon, tz, dma, regionCode, country, continent }
//     - __cfDevice   — { uaPlatform, uaMobile, uaBrand, uaBrandVersion, uaPlatformVersion }
//     - __cfNet      — { httpProtocol, tlsVersion, asn, asOrg }
//     - __cfBot      — { score, verifiedBot } (when Bot Management is enabled)
//     - __pvEventId  — UUID for Pixel ↔ CAPI deduplication on PageView
//
//   Headers:
//     - Set-Cookie (every cookie above when missing)
//     - Accept-CH: Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform,
//                  Sec-CH-UA-Platform-Version, Sec-CH-UA-Model
//                  → tells the browser to send these on subsequent requests
//     - Critical-CH (same set) → upgraded immediately on next nav
//     - Permissions-Policy: ch-ua-* — opt-in to deliver UA hints
//     - Content-Security-Policy / X-Frame-Options
//
//   Server-side dispatched events:
//     - Meta CAPI PageView (skipped if bot score < 30) with em + ph not yet
//       available (anonymous PageView), but enriched user_data (IP, UA, fbc, fbp,
//       external_id, country, ct, st, zp).
//
// CONTRACT WITH CLIENT-SIDE
//   - Cookie names match what the JS libs already read (so existing code is
//     unaffected — server-side just becomes the source of truth).
//   - First-touch invariants are preserved: a cookie is NEVER overwritten if
//     present. The only mutating cookies are `k_attr_lt`, `_kc_visit_count`,
//     `_kc_session_id`, `_kc_bot_score` (semantic last-touch / counter / TTL).

/// <reference types="@cloudflare/workers-types" />

// ── Types ────────────────────────────────────────────────────────────────────

interface IncomingRequestCfProperties {
  country?: string;
  city?: string;
  region?: string;
  regionCode?: string;
  postalCode?: string;
  latitude?: string;
  longitude?: string;
  timezone?: string;
  metroCode?: string;
  continent?: string;
  asn?: number;
  asOrganization?: string;
  httpProtocol?: string;
  tlsVersion?: string;
  colo?: string;
  botManagement?: {
    score?: number;
    verifiedBot?: boolean;
    staticResource?: boolean;
    ja3Hash?: string;
  };
}

interface CFContext {
  request: Request & { cf?: IncomingRequestCfProperties };
  next: () => Promise<Response>;
  waitUntil: (promise: Promise<unknown>) => void;
  env: {
    META_PIXEL_ID?: string;
    META_CAPI_TOKEN?: string;
    META_TEST_EVENT_CODE?: string;
    DEFAULT_COUNTRY?: string;
    PUBLIC_CSP_REPORT_URI?: string;
  };
}

// ── Constants ────────────────────────────────────────────────────────────────

/** 400d — browser maximum (Chrome cap). Used for stable identifiers. */
const COOKIE_MAX_AGE_LONG = 400 * 86400;
/** 90d — aligned with `lib/utm.ts` for click IDs and UTM JSON. */
const COOKIE_MAX_AGE_MEDIUM = 90 * 86400;
/** 30min — session rotation window (idle timeout). */
const SESSION_IDLE_SECONDS = 30 * 60;

const SKIP_PATHS = ['/_astro/', '/images/', '/videos/', '/fonts/', '/api/', '/favicon', '/robots', '/sitemap'];

/** Click-ID URL params → first-party cookie names. Matches `lib/konclui-tracking.ts`
 *  and `lib/utm.ts` so client-side reads what the server-side wrote. */
const CLICK_ID_MAP: Array<{ urlParam: string; cookie: string }> = [
  { urlParam: 'gclid',      cookie: '_gclid' },
  { urlParam: 'gbraid',     cookie: '_gbraid' },
  { urlParam: 'wbraid',     cookie: '_wbraid' },
  { urlParam: 'gclsrc',     cookie: '_gclsrc' },
  { urlParam: 'dclid',      cookie: '_dclid' },
  { urlParam: 'gad_source', cookie: '_gad_source' },
  { urlParam: 'msclkid',    cookie: '_msclkid' },
  { urlParam: 'ttclid',     cookie: '_ttclid' },
  { urlParam: 'twclid',     cookie: '_twclid' },
  { urlParam: 'li_fat_id',  cookie: '_li_fat_id' },
  { urlParam: 'ScCid',      cookie: '_sccid' },
  { urlParam: 'epik',       cookie: '_epik' },
  { urlParam: 'rdt_cid',    cookie: '_rdt_cid' },
  { urlParam: 'tblci',      cookie: '_tblci' },
  { urlParam: 'obOrigUrl',  cookie: '_ob_orig_url' },
  { urlParam: 'qclid',      cookie: '_qclid' },
  { urlParam: 'ymclk',      cookie: '_ymclk' },
];

const UTM_KEYS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term', 'utm_channel', 'ref_code'] as const;

/** Auto-detect source/medium from click IDs when UTM params are absent. */
const CLICK_ID_DEFAULTS: Record<string, { source: string; medium: string }> = {
  gclid:      { source: 'google',    medium: 'cpc' },
  gbraid:     { source: 'google',    medium: 'cpc' },
  wbraid:     { source: 'google',    medium: 'cpc' },
  gclsrc:     { source: 'google',    medium: 'cpc' },
  dclid:      { source: 'google',    medium: 'display' },
  gad_source: { source: 'google',    medium: 'cpc' },
  fbclid:     { source: 'facebook',  medium: 'paid_social' },
  msclkid:    { source: 'bing',      medium: 'cpc' },
  ttclid:     { source: 'tiktok',    medium: 'paid_social' },
  twclid:     { source: 'twitter',   medium: 'paid_social' },
  li_fat_id:  { source: 'linkedin',  medium: 'paid_social' },
  ScCid:      { source: 'snapchat',  medium: 'paid_social' },
  epik:       { source: 'pinterest', medium: 'paid_social' },
  rdt_cid:    { source: 'reddit',    medium: 'paid_social' },
  tblci:      { source: 'taboola',   medium: 'native' },
  obOrigUrl:  { source: 'outbrain',  medium: 'native' },
  qclid:      { source: 'quora',     medium: 'cpc' },
  ymclk:      { source: 'yahoo',     medium: 'cpc' },
};

/** Bot Management threshold — events with score below this are treated as
 *  non-human and skip CAPI fire. CF docs: 1..29 = automated/likely bot,
 *  30..99 = humans (likely / verified). Verified bots (Googlebot, etc.) are
 *  flagged separately via `verifiedBot`. */
const BOT_HUMAN_THRESHOLD = 30;

/** Conservative UA heuristic for the case where Cloudflare Bot Management is
 *  not available (Free tier, preview deploys, ...). Only blocks known crawler
 *  signatures — false negatives are fine, false positives matter (we'd skip
 *  CAPI for a real human). When Bot Management IS enabled, this is unused. */
const KNOWN_BOT_UA_PATTERN =
  /\b(?:bot|crawler|spider|slurp|duckduckbot|applebot|facebookexternalhit|telegrambot|whatsapp|pingdom|uptimerobot|gtmetrix|lighthouse|headlesschrome|phantomjs|puppeteer|playwright|chrome-lighthouse|googlebot|bingbot|yandex|baidu|sogou|petalbot|ahrefsbot|semrushbot|mj12bot|dotbot)\b/i;

/** URL parameters that may contain PII or credentials and must be stripped
 *  from any URL before persisting to a cookie (source_url, landing_first,
 *  referrer_first). Marketing campaigns sometimes leak email/phone/auth
 *  tokens into query strings — those values would otherwise echo back in
 *  every subsequent `Cookie` request header for 90-400 days. */
const SENSITIVE_PARAM_PATTERN =
  /^(?:e?mail|phone|tel(?:efone)?|cellphone|whatsapp|name|nome|cpf|cnpj|document|doc|password|pass|pwd|secret|token|access[_-]?token|refresh[_-]?token|auth(?:orization)?|bearer|api[_-]?key|otp|code|jwt|sig|signature|hash|key|session(?:[_-]?id)?)$/i;

function sanitizeUrlForCookie(rawUrl: string): string {
  if (!rawUrl) return '';
  try {
    const u = new URL(rawUrl);
    const toDelete: string[] = [];
    u.searchParams.forEach((_, key) => {
      if (SENSITIVE_PARAM_PATTERN.test(key)) toDelete.push(key);
    });
    for (const k of toDelete) u.searchParams.delete(k);
    return u.toString();
  } catch {
    return rawUrl;
  }
}

// ── Cookie utilities ─────────────────────────────────────────────────────────

function parseCookies(header: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const name = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    if (name) out[name] = value;
  }
  return out;
}

function buildSetCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value};path=/;max-age=${maxAge};SameSite=Lax;Secure`;
}

// ── Capture: click IDs (first-touch) ─────────────────────────────────────────
//
// Read every supported click ID from the URL query string. If a corresponding
// cookie already exists, NEVER overwrite — first-touch attribution wins. The
// `_fbc` cookie is special-cased into Meta canonical format
// (`fb.${subdomain_index}.${creation_time}.${fbclid}`).

function captureClickIds(
  url: URL,
  cookies: Record<string, string>,
  newCookies: string[],
): { fbcSet?: string } {
  const result: { fbcSet?: string } = {};

  // Meta: fbclid → _fbc (canonical Meta format).
  // Strict validation: real fbclids use only `[A-Za-z0-9_-]` (Meta's spec).
  // Anything containing a cookie delimiter (`;`, `,`, whitespace, ...) is
  // either malformed or an injection attempt — skip rather than encode,
  // because Meta's Pixel reads `_fbc` raw and re-encoding would break match.
  if (!cookies['_fbc']) {
    const fbclid = url.searchParams.get('fbclid');
    if (fbclid && /^[A-Za-z0-9_-]{1,512}$/.test(fbclid)) {
      const fbc = `fb.1.${Date.now()}.${fbclid}`;
      newCookies.push(buildSetCookie('_fbc', fbc, COOKIE_MAX_AGE_LONG));
      result.fbcSet = fbc;
    }
  }

  // Generic click IDs: persist URL value as-is
  for (const { urlParam, cookie } of CLICK_ID_MAP) {
    if (cookies[cookie]) continue; // first-touch — never overwrite
    const value = url.searchParams.get(urlParam);
    if (value) {
      newCookies.push(buildSetCookie(cookie, encodeURIComponent(value), COOKIE_MAX_AGE_MEDIUM));
    }
  }

  return result;
}

// ── Capture: UTMs (first-touch + last-touch) ─────────────────────────────────
//
// Mirror of the client-side logic in `lib/utm.ts`:
//   - first-touch (`k_attr_ft`): set ONCE on first visit, never overwritten.
//   - last-touch (`k_attr_lt`):  refreshed whenever the URL has new UTM/click params.
//   - referrer-derived source/medium when no explicit params anywhere.
//
// Stores as JSON-encoded cookies so `lib/utm.ts` reads identical structure.

function readJsonCookie<T>(value: string | undefined): Partial<T> | null {
  if (!value) return null;
  try {
    return JSON.parse(decodeURIComponent(value));
  } catch {
    return null;
  }
}

function detectReferrerSource(referrer: string): { source: string; medium: string } | null {
  if (!referrer) return null;
  const lower = referrer.toLowerCase();
  // Mirrors a curated subset of `lib/utm.ts` REFERRER_PATTERNS — enough to
  // populate canonical source/medium when UTMs are absent. Keep it lean —
  // any pattern not here just falls through to the hostname-based default.
  const PATTERNS: Array<{ p: string; source: string; medium: string }> = [
    { p: 'mail.google.com',     source: 'gmail',      medium: 'email' },
    { p: 'gemini.google.com',   source: 'gemini',     medium: 'ai' },
    { p: 'google.',             source: 'google',     medium: 'organic' },
    { p: 'bing.com',            source: 'bing',       medium: 'organic' },
    { p: 'duckduckgo.com',      source: 'duckduckgo', medium: 'organic' },
    { p: 'yahoo.com',           source: 'yahoo',      medium: 'organic' },
    { p: 'instagram.com',       source: 'instagram',  medium: 'social' },
    { p: 'facebook.com',        source: 'facebook',   medium: 'social' },
    { p: 'l.facebook.com',      source: 'facebook',   medium: 'social' },
    { p: 'youtube.com',         source: 'youtube',    medium: 'video' },
    { p: 'tiktok.com',          source: 'tiktok',     medium: 'social' },
    { p: 'linkedin.com',        source: 'linkedin',   medium: 'social' },
    { p: 'whatsapp.com',        source: 'whatsapp',   medium: 'social' },
    { p: 'wa.me',               source: 'whatsapp',   medium: 'social' },
    { p: 't.me',                source: 'telegram',   medium: 'social' },
    { p: 'twitter.com',         source: 'twitter',    medium: 'social' },
    { p: 'x.com',               source: 'twitter',    medium: 'social' },
    { p: 'chatgpt.com',         source: 'chatgpt',    medium: 'ai' },
    { p: 'claude.ai',           source: 'claude',     medium: 'ai' },
    { p: 'perplexity.ai',       source: 'perplexity', medium: 'ai' },
  ];
  for (const { p, source, medium } of PATTERNS) {
    if (lower.includes(p)) return { source, medium };
  }
  try {
    const host = new URL(referrer).hostname.replace(/^www\./, '');
    return { source: host, medium: 'referral' };
  } catch {
    return null;
  }
}

function captureUtms(
  url: URL,
  cookies: Record<string, string>,
  referer: string,
  newCookies: string[],
): void {
  const params = url.searchParams;
  const fromUrl: Record<string, string> = {};
  for (const k of UTM_KEYS) {
    const v = params.get(k);
    if (v) fromUrl[k] = v;
  }
  // Accept all spellings the partner program may emit: `ref_code` (canonical),
  // `refCode` (camelCase variant some campaigns use), and `ref` (short form
  // generated by the partner portal's RefCodeWidget at
  // konclui-partner/src/features/dashboard/lib/referralLinks.ts).
  if (!fromUrl.ref_code) {
    const v = params.get('refCode') || params.get('ref');
    if (v) fromUrl.ref_code = v;
  }
  for (const { urlParam } of CLICK_ID_MAP) {
    const v = params.get(urlParam);
    if (v) fromUrl[urlParam] = v;
  }
  const fbclid = params.get('fbclid');
  if (fbclid) fromUrl['fbclid'] = fbclid;

  // Auto-derive source/medium from click IDs when not explicit
  if (!fromUrl.utm_source || !fromUrl.utm_medium) {
    const candidates = ['fbclid', ...CLICK_ID_MAP.map((c) => c.urlParam)];
    for (const cid of candidates) {
      if (fromUrl[cid] && CLICK_ID_DEFAULTS[cid]) {
        if (!fromUrl.utm_source) fromUrl.utm_source = CLICK_ID_DEFAULTS[cid].source;
        if (!fromUrl.utm_medium) fromUrl.utm_medium = CLICK_ID_DEFAULTS[cid].medium;
        break;
      }
    }
  }

  // Auto-derive from referrer if still nothing
  if (!fromUrl.utm_source && !cookies['k_attr_lt']) {
    const ref = detectReferrerSource(referer);
    if (ref) {
      fromUrl.utm_source = ref.source;
      fromUrl.utm_medium = ref.medium;
    }
  }

  const lastTouch = readJsonCookie<Record<string, string>>(cookies['k_attr_lt']) ?? {};
  // Sensitive params (email/phone/auth/tokens) get stripped before persistence
  // — the cookie echoes back in every future Cookie header, so leaking PII
  // here would propagate it to every downstream tracking call for 90 days.
  const merged = {
    ...lastTouch,
    ...fromUrl,
    source_url: sanitizeUrlForCookie(url.toString()),
    landing_page: lastTouch.landing_page || url.pathname,
    referrer: lastTouch.referrer || (referer ? sanitizeUrlForCookie(referer) : undefined),
    timestamp: lastTouch.timestamp || new Date().toISOString(),
  };
  // Drop empty/null values
  for (const k of Object.keys(merged)) {
    const v = (merged as Record<string, unknown>)[k];
    if (v === undefined || v === null || v === '') delete (merged as Record<string, unknown>)[k];
  }

  // `ref_code` is included so that a returning visitor who lands with only
  // `?ref=...` (no UTMs, no click ID) still refreshes last-touch with the new
  // partner attribution. Without it, the partner code would be parsed but the
  // cookie wouldn't be re-written, letting the previous campaign's last-touch
  // outlive the partner referral.
  const hasNewParams =
    !!fromUrl.utm_source || !!fromUrl.utm_medium || !!fromUrl.utm_campaign ||
    !!fromUrl.ref_code ||
    CLICK_ID_MAP.some(({ urlParam }) => !!fromUrl[urlParam]) || !!fromUrl['fbclid'];

  if (hasNewParams || !cookies['k_attr_lt']) {
    newCookies.push(buildSetCookie('k_attr_lt', encodeURIComponent(JSON.stringify(merged)), COOKIE_MAX_AGE_MEDIUM));
  }
  if (!cookies['k_attr_ft']) {
    newCookies.push(buildSetCookie('k_attr_ft', encodeURIComponent(JSON.stringify(merged)), COOKIE_MAX_AGE_MEDIUM));
  }
}

// ── Capture: identity (uid, session, counters) ───────────────────────────────

interface IdentityResult {
  uid: string;
  sessionId: string;
  firstSeen: string;
  visitCount: number;
}

function captureIdentity(
  cookies: Record<string, string>,
  newCookies: string[],
): IdentityResult {
  // External ID — durable across all visits, the canonical Meta `external_id`.
  let uid = cookies['_konclui_uid'];
  if (!uid) {
    uid = crypto.randomUUID();
    newCookies.push(buildSetCookie('_konclui_uid', uid, COOKIE_MAX_AGE_LONG));
  }

  // First-seen — set once, never overwritten. Powers `engagement age` MQL.
  let firstSeen = cookies['_kc_first_seen'];
  if (!firstSeen) {
    firstSeen = new Date().toISOString();
    newCookies.push(buildSetCookie('_kc_first_seen', encodeURIComponent(firstSeen), COOKIE_MAX_AGE_LONG));
  } else {
    firstSeen = decodeURIComponent(firstSeen);
  }

  // Visit count — incremented every full HTML response. Cheap signal of intent.
  // We refresh the cookie max-age on each visit so it stays within the 400d window.
  const prevCount = parseInt(cookies['_kc_visit_count'] || '0', 10) || 0;
  const visitCount = prevCount + 1;
  newCookies.push(buildSetCookie('_kc_visit_count', String(visitCount), COOKIE_MAX_AGE_LONG));

  // Session ID — rotates after 30min of inactivity. The cookie max-age IS the
  // idle timeout: each request refreshes it, so the cookie expires (and a new
  // session_id gets minted) only when the user steps away long enough.
  let sessionId = cookies['_kc_session_id'];
  if (!sessionId) {
    sessionId = crypto.randomUUID();
  }
  // Always refresh the TTL so the session stays alive while the user is active.
  newCookies.push(buildSetCookie('_kc_session_id', sessionId, SESSION_IDLE_SECONDS));

  return { uid, sessionId, firstSeen, visitCount };
}

// ── Capture: first landing + referrer (first-touch) ──────────────────────────
//
// Persisted ONCE. Useful for marketing analytics — "what page did this visitor
// LAND on first" and "what site referred them" survive across all subsequent
// pageviews + form submits.

function captureFirstVisit(
  cookies: Record<string, string>,
  url: URL,
  referer: string,
  newCookies: string[],
): void {
  if (!cookies['_kc_landing_first']) {
    const safeLanding = sanitizeUrlForCookie(url.toString());
    newCookies.push(buildSetCookie('_kc_landing_first', encodeURIComponent(safeLanding), COOKIE_MAX_AGE_LONG));
  }
  if (!cookies['_kc_referrer_first'] && referer) {
    const safeReferer = sanitizeUrlForCookie(referer);
    newCookies.push(buildSetCookie('_kc_referrer_first', encodeURIComponent(safeReferer), COOKIE_MAX_AGE_LONG));
  }
}

// ── Geo, device, and bot extraction ──────────────────────────────────────────
//
// Pulls every useful field from `request.cf` and request headers. The shape
// returned here is what gets injected into `<head>` as `__cfGeo`, `__cfDevice`,
// `__cfNet`, `__cfBot` — read by client-side libs to enrich every event.

interface GeoData {
  country: string;
  ct: string;            // city
  st: string;            // region
  zp: string;            // postal code
  lat: string;
  lon: string;
  tz: string;
  dma: string;           // metro code (Google Ads DMA)
  regionCode: string;    // ISO 3166-2
  continent: string;
}

function extractGeo(request: Request & { cf?: IncomingRequestCfProperties }): GeoData {
  const cf = request.cf;
  return {
    country:    String(cf?.country ?? request.headers.get('cf-ipcountry') ?? '').toLowerCase(),
    ct:         String(cf?.city ?? '').toLowerCase(),
    st:         String(cf?.region ?? '').toLowerCase(),
    zp:         String(cf?.postalCode ?? ''),
    lat:        String(cf?.latitude ?? ''),
    lon:        String(cf?.longitude ?? ''),
    tz:         String(cf?.timezone ?? ''),
    dma:        String(cf?.metroCode ?? ''),
    regionCode: String(cf?.regionCode ?? ''),
    continent:  String(cf?.continent ?? '').toLowerCase(),
  };
}

interface DeviceData {
  uaPlatform: string;          // "Windows" | "macOS" | "Android" | "iOS" | "Linux"
  uaPlatformVersion: string;   // e.g. "14.5.0"
  uaMobile: boolean;
  uaBrand: string;             // e.g. "Chromium"
  uaBrandVersion: string;      // e.g. "147"
  uaModel: string;             // mobile only — e.g. "Pixel 7"
}

/** Parse Sec-CH-UA header: '"Chromium";v="147", "Not_A Brand";v="99"'.
 *  Picks the first non-`Not_A Brand`/`Brand` placeholder entry. */
function parseSecChUaBrand(value: string): { brand: string; version: string } {
  if (!value) return { brand: '', version: '' };
  // Each entry: '"NAME";v="X"' separated by commas. We split outside quotes
  // by walking the string — using a regex on commas would mis-split inside
  // values, but since values are always strict numeric versions, a comma
  // outside quotes is safe to use.
  const parts = value.split(/,\s*/);
  for (const part of parts) {
    const m = part.match(/"([^"]+)";v="([^"]+)"/);
    if (!m) continue;
    const brand = m[1];
    if (/not.*a.*brand/i.test(brand)) continue;
    return { brand, version: m[2] };
  }
  return { brand: '', version: '' };
}

function extractDevice(headers: Headers): DeviceData {
  const stripQuotes = (s: string) => s.replace(/^"|"$/g, '');
  const platform = stripQuotes(headers.get('sec-ch-ua-platform') ?? '');
  const platformVersion = stripQuotes(headers.get('sec-ch-ua-platform-version') ?? '');
  const mobile = headers.get('sec-ch-ua-mobile') === '?1';
  const model = stripQuotes(headers.get('sec-ch-ua-model') ?? '');
  const { brand, version } = parseSecChUaBrand(headers.get('sec-ch-ua') ?? '');
  return {
    uaPlatform: platform,
    uaPlatformVersion: platformVersion,
    uaMobile: mobile,
    uaBrand: brand,
    uaBrandVersion: version,
    uaModel: model,
  };
}

interface NetData {
  httpProtocol: string;
  tlsVersion: string;
  asn: string;
  asOrg: string;
}

function extractNet(request: Request & { cf?: IncomingRequestCfProperties }): NetData {
  const cf = request.cf;
  return {
    httpProtocol: String(cf?.httpProtocol ?? ''),
    tlsVersion: String(cf?.tlsVersion ?? ''),
    asn: cf?.asn != null ? String(cf.asn) : '',
    asOrg: String(cf?.asOrganization ?? ''),
  };
}

interface BotData {
  score: number | null;
  verifiedBot: boolean;
  isHuman: boolean;
}

function extractBot(request: Request & { cf?: IncomingRequestCfProperties }): BotData {
  const bm = request.cf?.botManagement;
  if (bm && typeof bm.score === 'number') {
    return {
      score: bm.score,
      verifiedBot: !!bm.verifiedBot,
      isHuman: bm.score >= BOT_HUMAN_THRESHOLD,
    };
  }
  // Bot Management not enabled (Free tier / preview deploys). Apply a
  // conservative UA-based heuristic: if the User-Agent matches a known
  // crawler pattern, treat as bot and skip CAPI. False negatives are fine
  // (real humans never get blocked); false positives just mean we don't
  // double-fire CAPI for an obvious crawler. Empty/short UAs are treated
  // as bots too — real browsers always send a UA.
  const ua = request.headers.get('user-agent') || '';
  const looksLikeBot = !ua || ua.length < 20 || KNOWN_BOT_UA_PATTERN.test(ua);
  return { score: null, verifiedBot: false, isHuman: !looksLikeBot };
}

// ── Main ─────────────────────────────────────────────────────────────────────

export const onRequest = async (context: CFContext) => {
  const { request, next, waitUntil, env } = context;
  const url = new URL(request.url);

  // Skip non-page requests (assets, API, etc.)
  if (SKIP_PATHS.some((p) => url.pathname.startsWith(p) || url.pathname.includes('.'))) {
    return next();
  }

  const response = await next();

  // Only transform HTML responses
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.includes('text/html')) return response;

  // Parse incoming cookies once
  const cookies = parseCookies(request.headers.get('cookie') || '');
  const referer = request.headers.get('referer') || '';
  const ip = request.headers.get('cf-connecting-ip') || '';
  const ua = request.headers.get('user-agent') || '';

  const newCookies: string[] = [];

  // ── 1. Click IDs (Meta + Google + Bing + TikTok + LinkedIn + ...) ──
  const { fbcSet } = captureClickIds(url, cookies, newCookies);

  // ── 2. UTMs first-touch + last-touch ──
  captureUtms(url, cookies, referer, newCookies);

  // ── 3. Identity, session, counters ──
  const identity = captureIdentity(cookies, newCookies);

  // ── 4. First landing + first referrer ──
  captureFirstVisit(cookies, url, referer, newCookies);

  // ── 5. Cloudflare-derived data ──
  const geo = extractGeo(request);
  const device = extractDevice(request.headers);
  const net = extractNet(request);
  const bot = extractBot(request);

  // Persist bot score so client-side / form handlers can read it
  if (bot.score !== null) {
    newCookies.push(buildSetCookie('_kc_bot_score', String(bot.score), SESSION_IDLE_SECONDS));
  }

  // Effective fbc/fbp for downstream use:
  // server-side _fbc just set OR cookie that came in.
  const fbcEffective = fbcSet || cookies['_fbc'] || '';
  const fbpEffective = cookies['_fbp'] || '';

  // ── 6. _fbp generation if missing (kept after capture so fbcEffective is known) ──
  let fbpForCapi = fbpEffective;
  if (!fbpForCapi) {
    fbpForCapi = `fb.1.${Date.now()}.${Math.floor(Math.random() * 9e9) + 1e9}`;
    newCookies.push(buildSetCookie('_fbp', fbpForCapi, COOKIE_MAX_AGE_LONG));
  }

  // ── 7. Generate shared eventID for Pixel↔CAPI dedup ──
  const eventId = crypto.randomUUID();

  // ── 8. Inject window globals ──
  // Escape `</script>` to defeat any chance of accidental script termination
  // when stringifying user-controlled strings (defense in depth — we already
  // control these values, but the sanitization is cheap).
  const safeJson = (obj: unknown) => JSON.stringify(obj).replace(/<\//g, '<\\/');

  // Drop empty fields so JSON stays compact and consumers don't read ''.
  const clean = <T extends Record<string, unknown>>(o: T): Partial<T> => {
    const out: Partial<T> = {};
    for (const [k, v] of Object.entries(o)) {
      if (v !== '' && v !== undefined && v !== null) (out as Record<string, unknown>)[k] = v;
    }
    return out;
  };

  const cfGeoPayload = clean(geo as unknown as Record<string, unknown>);
  const cfDevicePayload = clean(device as unknown as Record<string, unknown>);
  const cfNetPayload = clean(net as unknown as Record<string, unknown>);
  const cfBotPayload = bot.score !== null
    ? { score: bot.score, verifiedBot: bot.verifiedBot, isHuman: bot.isHuman }
    : null;

  const injectScript =
    `<script>` +
    `window.__cfGeo=${safeJson(cfGeoPayload)};` +
    `window.__cfDevice=${safeJson(cfDevicePayload)};` +
    `window.__cfNet=${safeJson(cfNetPayload)};` +
    (cfBotPayload ? `window.__cfBot=${safeJson(cfBotPayload)};` : '') +
    `window.__pvEventId=${JSON.stringify(eventId)};` +
    `window.__kcSession=${safeJson({ uid: identity.uid, sessionId: identity.sessionId, firstSeen: identity.firstSeen, visitCount: identity.visitCount })};` +
    `</script>`;

  const transformedResponse = new HTMLRewriter()
    .on('head', {
      element(el: Element) {
        el.prepend(injectScript, { html: true });
      },
    })
    .on('meta[name="cf-ipcountry"]', {
      element(el) {
        // Only emit a country tag when the edge resolved one. No safe blanket
        // fallback — hardcoding "BR" misreports every non-geo-resolved visitor.
        const resolved = request.cf?.country;
        if (resolved) {
          el.setAttribute('content', resolved.toUpperCase());
        } else if (env.DEFAULT_COUNTRY) {
          el.setAttribute('content', env.DEFAULT_COUNTRY.toUpperCase());
        } else {
          el.setAttribute('content', '');
        }
      },
    })
    .transform(response);

  // ── 9. Headers: CSP + Sec-CH-UA opt-in ─────────────────────────────────────
  //
  // /demo/* allows iframe embed (used in landing-page integrations); every
  // other path locks frame-ancestors to none.
  //
  // `script-src 'unsafe-inline'` is currently required by the GTM and Meta
  // Pixel snippets in BaseLayout — they declare anonymous functions that the
  // browser treats as inline. The bulk of our own JS was already moved to
  // /scripts/*.js (loaded via <script src>) so removing 'unsafe-inline'
  // becomes a contained migration (use nonces or hashes for the two remaining
  // inline blocks). Tracked in the project review notes (B4).
  const isDemo = url.pathname.startsWith('/demo');
  const cspBase = "default-src 'self'; base-uri 'self'; object-src 'none';";
  const cspFrameAncestors = isDemo ? 'frame-ancestors *;' : "frame-ancestors 'none';";
  const cspScripts =
    "script-src 'self' 'unsafe-inline' " +
    'https://static.cloudflareinsights.com ' +
    'https://konclui.com https://*.konclui.com ' +
    'https://politiacademy.com.br https://*.politiacademy.com.br ' +
    'https://connect.facebook.net ' +
    'https://www.googletagmanager.com ' +
    'https://www.googleadservices.com ' +
    'https://googleads.g.doubleclick.net ' +
    'https://www.google-analytics.com ' +
    // PostHog: SDK is bundled from `'self'`, but the session-replay recorder,
    // surveys and toolbar are fetched from eu-assets.i.posthog.com at runtime.
    'https://eu.i.posthog.com https://eu-assets.i.posthog.com;';
  const cspRest =
    "style-src 'self' 'unsafe-inline'; " +
    "font-src 'self' https://fonts.gstatic.com; " +
    "img-src 'self' data: https: blob:; " +
    'frame-src https://konclui.com https://*.konclui.com ' +
    'https://politiacademy.com.br https://*.politiacademy.com.br ' +
    'https://www.facebook.com https://www.googletagmanager.com ' +
    'https://api.leadconnectorhq.com https://portal.konclui.com; ' +
    // PostHog session replay spawns a Web Worker from a blob URL.
    "worker-src 'self' blob:; " +
    "connect-src 'self' https: ; media-src 'self'";

  const reportUri = env.PUBLIC_CSP_REPORT_URI;
  const reportClause = reportUri ? ` report-uri ${reportUri};` : '';
  const cspValue = `${cspBase} ${cspFrameAncestors} ${cspScripts} ${cspRest}${reportClause}`;
  transformedResponse.headers.set('Content-Security-Policy', cspValue);
  // Report-Only emits a STRICTER candidate (no `'unsafe-inline'`) so we
  // can measure how many real violations we'd see if we tightened
  // script-src. Same Report-Only with the enforced policy would emit
  // zero reports — the whole point of having two headers is to compare
  // a tighter target against current reality.
  if (reportUri) {
    const cspScriptsStrict = cspScripts.replace(" 'unsafe-inline'", '');
    const cspRestStrict = cspRest.replace("style-src 'self' 'unsafe-inline';", "style-src 'self';");
    const cspReportValue = `${cspBase} ${cspFrameAncestors} ${cspScriptsStrict} ${cspRestStrict}${reportClause}`;
    transformedResponse.headers.set('Content-Security-Policy-Report-Only', cspReportValue);
  }

  // X-Frame-Options is a legacy header with no "allow all" value — its accepted
  // values are DENY, SAMEORIGIN, or ALLOW-FROM <uri>. For iframe-embedded pages
  // rely on CSP frame-ancestors (set above) and omit the header entirely so
  // browsers don't fall back to default-deny.
  if (!isDemo) {
    transformedResponse.headers.set('X-Frame-Options', 'DENY');
  } else {
    transformedResponse.headers.delete('X-Frame-Options');
  }

  // Client Hints opt-in: tells the browser we want richer UA data on
  // subsequent requests. We deliberately do NOT set `Critical-CH`: that
  // header would force the browser to retry the current navigation when
  // hints are missing, which would re-execute this middleware (incrementing
  // _kc_visit_count and emitting a second CAPI PageView with a different
  // event_id). Accept-CH alone is sufficient — UA hints arrive on the
  // visitor's NEXT page load naturally, no retry storm involved.
  const acceptCh = 'Sec-CH-UA, Sec-CH-UA-Mobile, Sec-CH-UA-Platform, Sec-CH-UA-Platform-Version, Sec-CH-UA-Model';
  transformedResponse.headers.set('Accept-CH', acceptCh);

  // ── 10. Server-side Meta CAPI PageView ─────────────────────────────────────
  // Skip if the request looks like a bot — keeps attribution data clean and
  // avoids burning CAPI rate limits on uptime monitors / scrapers / preview
  // bots. Verified bots (Googlebot etc.) are also skipped.
  const pixelId = env.META_PIXEL_ID;
  const token = env.META_CAPI_TOKEN;
  const shouldFireCapi = bot.isHuman && !bot.verifiedBot && pixelId && token;

  if (shouldFireCapi && pixelId && token) {
    waitUntil(
      sendCapiPageView({
        pixelId,
        token,
        testEventCode: env.META_TEST_EVENT_CODE,
        eventId,
        url: request.url,
        ip,
        ua,
        fbc: fbcEffective,
        fbp: fbpForCapi,
        uid: identity.uid,
        country: geo.country,
        city: geo.ct,
        region: geo.st,
        zip: geo.zp,
      }),
    );
  }

  // ── 11. Apply Set-Cookie headers and return ────────────────────────────────
  if (newCookies.length > 0) {
    const finalResponse = new Response(transformedResponse.body, {
      status: transformedResponse.status,
      headers: transformedResponse.headers,
    });
    for (const cookie of newCookies) {
      finalResponse.headers.append('Set-Cookie', cookie);
    }
    return finalResponse;
  }

  return transformedResponse;
};

// ── Meta CAPI PageView helper ────────────────────────────────────────────────

/** SHA-256 helper using Web Crypto API. Lowercases + trims inputs per Meta's
 *  matching spec — applied to every hashed PII field. */
async function sha256(value: string): Promise<string> {
  if (!value) return '';
  const data = new TextEncoder().encode(value.toLowerCase().trim());
  const hash = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

async function sendCapiPageView(params: {
  pixelId: string;
  token: string;
  testEventCode?: string;
  eventId: string;
  url: string;
  ip: string;
  ua: string;
  fbc: string;
  fbp: string;
  uid: string;
  country: string;
  city: string;
  region: string;
  zip: string;
}): Promise<void> {
  try {
    const userData: Record<string, unknown> = {
      client_ip_address: params.ip,
      client_user_agent: params.ua,
    };

    // Hash PII fields (Meta requires SHA-256 lowercase hex)
    if (params.uid) userData.external_id = [await sha256(params.uid)];
    if (params.country) userData.country = [await sha256(params.country)];
    if (params.city) userData.ct = [await sha256(params.city)];
    if (params.region) userData.st = [await sha256(params.region)];
    if (params.zip) userData.zp = [await sha256(params.zip)];

    // Non-hashed browser identifiers
    if (params.fbc) userData.fbc = params.fbc;
    if (params.fbp) userData.fbp = params.fbp;

    const payload: Record<string, unknown> = {
      data: [
        {
          event_name: 'PageView',
          event_time: Math.floor(Date.now() / 1000),
          event_id: params.eventId,
          event_source_url: params.url,
          action_source: 'website',
          user_data: userData,
        },
      ],
    };

    if (params.testEventCode) {
      payload.test_event_code = params.testEventCode;
    }

    const capiUrl = `https://graph.facebook.com/v21.0/${params.pixelId}/events?access_token=${params.token}`;

    const resp = await fetch(capiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      console.error('[CAPI] PageView failed:', resp.status, await resp.text().catch(() => ''));
    }
  } catch (err) {
    console.error('[CAPI] PageView error:', err);
  }
}

// ── A/B sticky bucket helper (exposed for future call-sites) ─────────────────
//
// Deterministic bucket assignment: hash(uid + experimentName) % 100. Always
// returns the SAME bucket for the SAME visitor across sessions/devices (as
// long as the `_konclui_uid` cookie persists).
//
// Usage (when an experiment is wired in a page or other Pages Function):
//
//     const bucket = await assignBucket(uid, 'pricing-2026q2', [50, 50]);
//     // bucket = 0 or 1 — index into the weights array
//
// The function is exported so other Pages Functions can use it without
// duplicating the hashing logic. No experiment is active right now —
// adding one is opt-in.

export async function assignBucket(
  uid: string,
  experimentName: string,
  weights: number[] = [50, 50],
): Promise<number> {
  if (!uid || !experimentName || weights.length === 0) return 0;
  const data = new TextEncoder().encode(`${uid}:${experimentName}`);
  const hash = await crypto.subtle.digest('SHA-256', data);
  const view = new DataView(hash);
  // Take the first 4 bytes as an unsigned int and project to [0, 99]
  const n = view.getUint32(0, false) % 100;
  let cum = 0;
  for (let i = 0; i < weights.length; i++) {
    cum += weights[i];
    if (n < cum) return i;
  }
  return weights.length - 1;
}

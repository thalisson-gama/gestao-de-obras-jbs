import type { UTMData } from '@components/react/demo-form/types';

// ── Constants ──
//
// IMPORTANT: these cookie names are also written server-side by
// `functions/_middleware.ts`. The Cloudflare Pages middleware is the canonical
// source — it writes `k_attr_ft` / `k_attr_lt` BEFORE any browser script runs,
// resistant to adblockers that filter `gtag.js` / `fbevents.js`. This module
// continues to write the same cookies as a redundant fallback (e.g. SPA-style
// route changes that don't trigger a fresh edge response). Both paths use the
// same JSON shape so reads are interchangeable.

const COOKIE_FT = 'k_attr_ft'; // first-touch (set once, never overwritten)
const COOKIE_LT = 'k_attr_lt'; // last-touch (updated every visit with new params)
const COOKIE_DAYS = 90;

/** All ad-platform click ID params we capture from the URL */
const CLICK_ID_KEYS = [
  'fbclid',     // Meta (Facebook/Instagram)
  'gclid',      // Google Ads
  'gbraid',     // Google Ads (iOS privacy)
  'wbraid',     // Google Ads (app-to-web)
  'gclsrc',     // Google Ads (SA360)
  'dclid',      // Google DV360
  'gad_source',  // Google Ads source
  'msclkid',    // Microsoft/Bing Ads
  'ttclid',     // TikTok Ads
  'twclid',     // X/Twitter Ads
  'li_fat_id',  // LinkedIn Ads
  'ScCid',      // Snapchat Ads
  'epik',       // Pinterest Ads
  'rdt_cid',    // Reddit Ads
  'tblci',      // Taboola
  'obOrigUrl',  // Outbrain
  'qclid',      // Quora Ads
  'ymclk',      // Yahoo DSP
] as const;

const UTM_KEYS = [
  'utm_source', 'utm_medium', 'utm_campaign',
  'utm_content', 'utm_term', 'utm_channel', 'ref_code',
] as const;

/** Auto-detect source/medium from click IDs when UTM params are absent */
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

// ── Attribution data shape ──

export interface AttributionData {
  // UTM params
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
  utm_channel?: string;
  ref_code?: string;

  // Click IDs
  fbclid?: string;
  gclid?: string;
  gbraid?: string;
  wbraid?: string;
  gclsrc?: string;
  dclid?: string;
  gad_source?: string;
  msclkid?: string;
  ttclid?: string;
  twclid?: string;
  li_fat_id?: string;
  ScCid?: string;
  epik?: string;
  rdt_cid?: string;
  tblci?: string;
  obOrigUrl?: string;
  qclid?: string;
  ymclk?: string;

  // Context
  source_url?: string;
  landing_page?: string;
  referrer?: string;
  timestamp?: string;
}

// ── Referrer patterns ──

interface ReferrerPattern { pattern: string; source: string; medium: string }

// IMPORTANT: detectReferrer returns the FIRST pattern whose substring matches
// referrer.includes(pattern). Generic entries (e.g. 'google.') must come AFTER
// any more specific entry they'd swallow (e.g. 'mail.google.com',
// 'maps.google.', 'gemini.google.com'). Adding a new specific Google/Yahoo
// variant? Put it before the generic catch-all.
const REFERRER_PATTERNS: ReferrerPattern[] = [
  // ── Google ecosystem (specific before generic) ──
  { pattern: 'mail.google.com', source: 'gmail', medium: 'email' },
  { pattern: 'maps.google.', source: 'google_maps', medium: 'local' },
  { pattern: 'google.com/maps', source: 'google_maps', medium: 'local' },
  { pattern: 'gemini.google.com', source: 'gemini', medium: 'ai' },
  { pattern: 'google.', source: 'google', medium: 'organic' },

  // ── Yahoo ecosystem (specific before generic) ──
  { pattern: 'mail.yahoo.com', source: 'yahoo_mail', medium: 'email' },
  { pattern: 'search.yahoo.', source: 'yahoo', medium: 'organic' },
  { pattern: 'yahoo.com', source: 'yahoo', medium: 'organic' },

  // ── Other search engines ──
  { pattern: 'bing.com', source: 'bing', medium: 'organic' },
  { pattern: 'duckduckgo.com', source: 'duckduckgo', medium: 'organic' },
  { pattern: 'yandex.', source: 'yandex', medium: 'organic' },
  { pattern: 'baidu.com', source: 'baidu', medium: 'organic' },
  { pattern: 'ecosia.org', source: 'ecosia', medium: 'organic' },
  { pattern: 'search.brave.com', source: 'brave', medium: 'organic' },
  { pattern: 'search.aol.com', source: 'aol', medium: 'organic' },
  { pattern: 'ask.com', source: 'ask', medium: 'organic' },
  { pattern: 'naver.com', source: 'naver', medium: 'organic' },
  { pattern: 'sogou.com', source: 'sogou', medium: 'organic' },
  { pattern: 'coccoc.com', source: 'coccoc', medium: 'organic' },
  { pattern: 'qwant.com', source: 'qwant', medium: 'organic' },
  { pattern: 'startpage.com', source: 'startpage', medium: 'organic' },

  // ── Meta ──
  { pattern: 'instagram.com', source: 'instagram', medium: 'social' },
  { pattern: 'l.instagram.com', source: 'instagram', medium: 'social' },
  { pattern: 'facebook.com', source: 'facebook', medium: 'social' },
  { pattern: 'fb.com', source: 'facebook', medium: 'social' },
  { pattern: 'fb.me', source: 'facebook', medium: 'social' },
  { pattern: 'l.facebook.com', source: 'facebook', medium: 'social' },
  { pattern: 'lm.facebook.com', source: 'facebook', medium: 'social' },
  { pattern: 'm.facebook.com', source: 'facebook', medium: 'social' },

  // ── Video ──
  { pattern: 'youtube.com', source: 'youtube', medium: 'video' },
  { pattern: 'youtu.be', source: 'youtube', medium: 'video' },
  { pattern: 'tiktok.com', source: 'tiktok', medium: 'social' },
  { pattern: 'kwai.com', source: 'kwai', medium: 'social' },
  { pattern: 'likee.video', source: 'likee', medium: 'social' },
  { pattern: 'vimeo.com', source: 'vimeo', medium: 'video' },

  // ── Social (major) ──
  { pattern: 'linkedin.com', source: 'linkedin', medium: 'social' },
  { pattern: 'lnkd.in', source: 'linkedin', medium: 'social' },
  { pattern: 'twitter.com', source: 'twitter', medium: 'social' },
  { pattern: 'x.com', source: 'twitter', medium: 'social' },
  { pattern: 't.co', source: 'twitter', medium: 'social' },
  { pattern: 'pinterest.com', source: 'pinterest', medium: 'social' },
  { pattern: 'pin.it', source: 'pinterest', medium: 'social' },
  { pattern: 'reddit.com', source: 'reddit', medium: 'social' },
  { pattern: 'snapchat.com', source: 'snapchat', medium: 'social' },
  { pattern: 'threads.net', source: 'threads', medium: 'social' },
  { pattern: 'bsky.app', source: 'bluesky', medium: 'social' },
  { pattern: 'tumblr.com', source: 'tumblr', medium: 'social' },
  { pattern: 'quora.com', source: 'quora', medium: 'social' },
  { pattern: 'lemon8-app.com', source: 'lemon8', medium: 'social' },

  // ── Messaging ──
  { pattern: 'whatsapp.com', source: 'whatsapp', medium: 'social' },
  { pattern: 'wa.me', source: 'whatsapp', medium: 'social' },
  { pattern: 'web.whatsapp.com', source: 'whatsapp', medium: 'social' },
  { pattern: 'telegram.org', source: 'telegram', medium: 'social' },
  { pattern: 't.me', source: 'telegram', medium: 'social' },
  { pattern: 'discord.com', source: 'discord', medium: 'social' },
  { pattern: 'discord.gg', source: 'discord', medium: 'social' },
  { pattern: 'slack.com', source: 'slack', medium: 'social' },

  // ── Mastodon / Fediverse (major instances) ──
  { pattern: 'mastodon.social', source: 'mastodon', medium: 'social' },
  { pattern: 'mastodon.online', source: 'mastodon', medium: 'social' },
  { pattern: 'mstdn.social', source: 'mastodon', medium: 'social' },

  // ── Email / Webmail (mail.google.com and mail.yahoo.com handled above) ──
  { pattern: 'outlook.live.com', source: 'outlook', medium: 'email' },
  { pattern: 'outlook.office.com', source: 'outlook', medium: 'email' },

  // ── Content / Native ads ──
  { pattern: 'taboola.com', source: 'taboola', medium: 'native' },
  { pattern: 'outbrain.com', source: 'outbrain', medium: 'native' },
  { pattern: 'flipboard.com', source: 'flipboard', medium: 'content' },
  { pattern: 'getpocket.com', source: 'pocket', medium: 'content' },
  { pattern: 'medium.com', source: 'medium', medium: 'content' },
  { pattern: 'substack.com', source: 'substack', medium: 'content' },

  // ── Review / Marketplace ──
  { pattern: 'trustpilot.com', source: 'trustpilot', medium: 'review' },
  { pattern: 'g2.com', source: 'g2', medium: 'review' },
  { pattern: 'capterra.com', source: 'capterra', medium: 'review' },
  { pattern: 'reclameaqui.com.br', source: 'reclameaqui', medium: 'review' },

  // ── News / Portal (BR) ──
  { pattern: 'uol.com.br', source: 'uol', medium: 'referral' },
  { pattern: 'globo.com', source: 'globo', medium: 'referral' },
  { pattern: 'terra.com.br', source: 'terra', medium: 'referral' },
  { pattern: 'ig.com.br', source: 'ig', medium: 'referral' },

  // ── AI / ChatBots ──
  { pattern: 'chatgpt.com', source: 'chatgpt', medium: 'ai' },
  { pattern: 'chat.openai.com', source: 'chatgpt', medium: 'ai' },
  { pattern: 'claude.ai', source: 'claude', medium: 'ai' },
  { pattern: 'perplexity.ai', source: 'perplexity', medium: 'ai' },
  // gemini.google.com handled in Google ecosystem block (see top of list)
  { pattern: 'copilot.microsoft.com', source: 'copilot', medium: 'ai' },
];

// ── Cookie helpers ──

function setCookie(name: string, value: string, days: number): void {
  // Secure attribute requires HTTPS — emitting it on http://localhost makes the
  // browser silently drop the cookie, breaking UTM persistence during local dev.
  const isSecure =
    typeof window !== 'undefined' && window.location.protocol === 'https:';
  const secureFlag = isSecure ? ';Secure' : '';
  document.cookie = `${name}=${encodeURIComponent(value)};path=/;max-age=${days * 86400};SameSite=Lax${secureFlag}`;
}

function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return match ? decodeURIComponent(match[1]) : null;
}

function readCookieJson<T>(name: string): Partial<T> | null {
  try {
    const raw = getCookie(name);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

function writeCookieJson(name: string, data: Record<string, unknown>, days: number): void {
  try {
    setCookie(name, JSON.stringify(data), days);
  } catch { /* cookie write failed — silently ignore */ }
}

// ── Internal helpers ──

function detectReferrer(): Pick<AttributionData, 'utm_source' | 'utm_medium' | 'utm_campaign'> | null {
  const referrer = document.referrer?.toLowerCase();
  if (!referrer) return null;

  for (const { pattern, source, medium } of REFERRER_PATTERNS) {
    if (referrer.includes(pattern)) {
      return { utm_source: source, utm_medium: medium, utm_campaign: 'organic' };
    }
  }

  try {
    const url = new URL(referrer);
    const hostname = url.hostname.replace('www.', '');
    return { utm_source: hostname, utm_medium: 'referral' };
  } catch {
    return { utm_source: 'unknown', utm_medium: 'referral' };
  }
}

function getURLParams(): Partial<AttributionData> {
  const params = new URLSearchParams(window.location.search);
  const data: Partial<AttributionData> = {};

  // UTM params
  for (const key of UTM_KEYS) {
    const value = params.get(key);
    if (value) (data as Record<string, string>)[key] = value;
  }

  // Accept all spellings the partner program may emit: `ref_code` (canonical),
  // `refCode` (camelCase variant some campaigns use), and `ref` (short form
  // generated by the partner portal's RefCodeWidget). Keep precedence in that
  // order so the canonical wins when multiple are present.
  if (!data.ref_code) {
    const refCode = params.get('refCode') || params.get('ref');
    if (refCode) data.ref_code = refCode;
  }

  // Click IDs
  for (const key of CLICK_ID_KEYS) {
    const value = params.get(key);
    if (value) (data as Record<string, string>)[key] = value;
  }

  return data;
}

function autoDetectFromClickIds(data: Partial<AttributionData>): void {
  if (data.utm_source && data.utm_medium) return;

  for (const clickId of CLICK_ID_KEYS) {
    if ((data as Record<string, string>)[clickId] && CLICK_ID_DEFAULTS[clickId]) {
      const defaults = CLICK_ID_DEFAULTS[clickId];
      if (!data.utm_source) data.utm_source = defaults.source;
      if (!data.utm_medium) data.utm_medium = defaults.medium;
      return;
    }
  }
}

function stripEmpty(obj: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null && v !== '') cleaned[k] = v;
  }
  return cleaned;
}

// ── Public API ──

/**
 * Resolves UTM + click ID data with cookie-based persistence (90 days).
 * Maintains backward compatibility with the previous sessionStorage approach.
 *
 * Priority: URL params > last-touch cookie > referrer auto-detect
 * Side effects: updates first-touch and last-touch attribution cookies.
 */
export function resolveUTMData(): UTMData {
  // 1. Read URL params (UTMs + click IDs)
  const urlParams = getURLParams();

  // 2. Auto-detect source/medium from click IDs if not provided
  autoDetectFromClickIds(urlParams);

  // 3. Read last-touch cookie (fallback persistence)
  const lastTouch = readCookieJson<AttributionData>(COOKIE_LT) || {};

  // 4. Auto-detect from referrer if no source anywhere
  const referrer = (!urlParams.utm_source && !lastTouch.utm_source)
    ? detectReferrer()
    : null;

  // 5. Merge: URL params > last-touch > referrer
  const merged: AttributionData = {
    ...referrer,
    ...lastTouch,
    ...urlParams,
    source_url: window.location.href,
    landing_page: lastTouch.landing_page || window.location.pathname,
    referrer: lastTouch.referrer || document.referrer || undefined,
    timestamp: lastTouch.timestamp || new Date().toISOString(),
  };

  // 6. Determine if this visit has new attribution params
  // `ref_code` is included so a returning visitor landing with only `?ref=...`
  // still refreshes last-touch with the new partner attribution. Without it,
  // the partner code parses into `urlParams` but the cookie isn't rewritten,
  // letting the previous campaign's last-touch shadow the partner referral.
  const hasNewParams = !!(
    urlParams.utm_source || urlParams.utm_medium || urlParams.utm_campaign ||
    urlParams.ref_code ||
    CLICK_ID_KEYS.some(k => (urlParams as Record<string, string>)[k])
  );

  // 7. Update cookies
  const cleanMerged = stripEmpty(merged as unknown as Record<string, unknown>);

  if (hasNewParams || !getCookie(COOKIE_LT)) {
    writeCookieJson(COOKIE_LT, cleanMerged, COOKIE_DAYS);
  }

  if (!getCookie(COOKIE_FT)) {
    writeCookieJson(COOKIE_FT, cleanMerged, COOKIE_DAYS);
  }

  return merged;
}

/**
 * Returns the first-touch attribution data (set on first visit, never overwritten).
 */
export function getFirstTouch(): AttributionData {
  return readCookieJson<AttributionData>(COOKIE_FT) || {};
}

/**
 * Returns the last-touch attribution data (updated on every visit with new params).
 */
export function getLastTouch(): AttributionData {
  return readCookieJson<AttributionData>(COOKIE_LT) || {};
}

/**
 * Returns all click IDs found in the current attribution data.
 * Checks URL first, then last-touch cookie.
 */
export function getAllClickIds(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const lastTouch = readCookieJson<AttributionData>(COOKIE_LT) || {};
  const ids: Record<string, string> = {};

  for (const key of CLICK_ID_KEYS) {
    const urlValue = params.get(key);
    const cookieValue = (lastTouch as Record<string, string>)[key];
    const value = urlValue || cookieValue;
    if (value) ids[key] = value;
  }

  return ids;
}

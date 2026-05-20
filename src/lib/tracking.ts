// Source of truth: PUBLIC_META_PIXEL_ID (env). Hardcoded fallback keeps the
// production pixel firing even if the env var is missing in a misconfigured
// deploy — losing tracking is worse than shipping the public ID.
export const META_PIXEL_ID =
  import.meta.env.PUBLIC_META_PIXEL_ID || '655611214261586';

interface TrackingData {
  lead_name?: string;
  lead_email?: string;
  lead_phone?: string;
}

/**
 * Reads a cookie value by name.
 */
function getCookie(name: string): string {
  return ('; ' + document.cookie).split('; ' + name + '=')[1]?.split(';')[0] || '';
}

/**
 * Reads a Cloudflare geo meta tag value.
 */
function getMeta(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute('content') || '';
}

/**
 * Resolves UTM parameters from the current URL.
 */
function getUTMParams(): Record<string, string> {
  const params = new URLSearchParams(window.location.search);
  const utmKeys = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term'];
  const result: Record<string, string> = {};
  for (const key of utmKeys) {
    const value = params.get(key);
    if (value) result[key] = value;
  }
  return result;
}

/**
 * Splits a full name into first name and last name.
 */
function splitName(fullName: string): { fn: string; ln: string } {
  const parts = fullName.trim().split(/\s+/);
  return {
    fn: parts[0] || '',
    ln: parts.slice(1).join(' ') || '',
  };
}

/**
 * Normalizes a Brazilian phone number to E.164-like format (digits only with country code).
 * E.g. "(11) 99999-9999" → "5511999999999"
 * Returns empty string if input has no significant digits.
 */
function normalizePhone(phone: string): string {
  const digits = (phone || '').replace(/\D/g, '');
  if (digits.length === 0) return '';
  if (digits.length <= 11) return '55' + digits;
  return digits;
}

/** Generate a unique event ID for deduplication between browser pixel and CAPI */
function generateEventId(): string {
  try {
    return crypto.randomUUID();
  } catch {
    return `evt.${Date.now()}.${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Builds advanced matching data from Cloudflare geo headers and PII.
 * Used by both fbq('init') in BaseLayout and re-init on form submission.
 */
function buildAdvancedMatching(data?: TrackingData): Record<string, string> {
  const matching: Record<string, string> = {};

  const country = getMeta('cf-ipcountry');
  if (country) matching.country = country.toLowerCase();
  // Geo details injected as JS variable by BaseLayout (not meta tags for privacy)
  const geo = window.__cfGeo;
  if (geo?.ct) matching.ct = geo.ct;
  if (geo?.st) matching.st = geo.st;
  if (geo?.zp) matching.zp = geo.zp;

  const externalId = getCookie('_konclui_uid');
  if (externalId) matching.external_id = externalId;

  if (data?.lead_email) {
    matching.em = String(data.lead_email).toLowerCase().trim();
  }
  if (data?.lead_phone) {
    const ph = normalizePhone(String(data.lead_phone));
    if (ph.length > 2) matching.ph = ph;
  }
  if (data?.lead_name) {
    const { fn, ln } = splitName(String(data.lead_name));
    if (fn) matching.fn = fn.toLowerCase();
    if (ln) matching.ln = ln.toLowerCase();
  }

  return matching;
}

/**
 * Fires a tracking event to:
 * 1. Cloudflare Zaraz (server-side CAPI bridge) — with eventID for deduplication
 * 2. Meta Pixel (browser-side fbq) — same eventID so Meta dedupes browser vs server
 * 3. dataLayer (GTM-based integrations) — PII stripped
 *
 * Server-side CAPI: PageView handled by CF Pages middleware,
 * Lead/Lead_MQL routed through Zaraz + Supabase Edge Functions.
 */
export function trackEvent(eventName: 'Lead' | 'Lead_MQL', data: TrackingData, sharedEventID?: string): void {
  if (typeof window === 'undefined') return;

  const eventID = sharedEventID || generateEventId();

  // Build Zaraz properties with ALL available data for maximum CAPI match quality
  const zarazProps: Record<string, unknown> = { eventID };

  const safeData = data ?? {};
  if (safeData.lead_email) {
    zarazProps.em = String(safeData.lead_email).toLowerCase().trim();
  }
  if (safeData.lead_phone) {
    const ph = normalizePhone(String(safeData.lead_phone));
    if (ph.length > 2) zarazProps.ph = ph;
  }
  if (safeData.lead_name) {
    const { fn, ln } = splitName(String(safeData.lead_name));
    if (fn) zarazProps.fn = fn.toLowerCase();
    if (ln) zarazProps.ln = ln.toLowerCase();
  }

  const fbc = getCookie('_fbc');
  const fbp = getCookie('_fbp');
  const externalId = getCookie('_konclui_uid');
  if (fbc) zarazProps.fbc = fbc;
  if (fbp) zarazProps.fbp = fbp;
  if (externalId) zarazProps.external_id = externalId;

  // Forward every captured ad-platform click ID to Zaraz so it can route into
  // Google Ads (Enhanced Conversions), Bing UET, TikTok Events, LinkedIn, etc.
  // These cookies are set first-party server-side in functions/_middleware.ts
  // (resistant to adblockers) and mirrored client-side as fallback.
  // Names mirror the URL params (gclid, msclkid, ttclid, ...) so any GTM /
  // Zaraz tag can read them off zarazProps without a translation layer.
  const CLICK_ID_COOKIES: Array<[string, string]> = [
    ['_gclid',      'gclid'],
    ['_gbraid',     'gbraid'],
    ['_wbraid',     'wbraid'],
    ['_gclsrc',     'gclsrc'],
    ['_dclid',      'dclid'],
    ['_gad_source', 'gad_source'],
    ['_msclkid',    'msclkid'],
    ['_ttclid',     'ttclid'],
    ['_twclid',     'twclid'],
    ['_li_fat_id',  'li_fat_id'],
    ['_sccid',      'ScCid'],
    ['_epik',       'epik'],
    ['_rdt_cid',    'rdt_cid'],
    ['_tblci',      'tblci'],
    ['_ob_orig_url', 'obOrigUrl'],
    ['_qclid',      'qclid'],
    ['_ymclk',      'ymclk'],
  ];
  for (const [cookieName, propName] of CLICK_ID_COOKIES) {
    const v = getCookie(cookieName);
    if (!v) continue;
    try {
      zarazProps[propName] = decodeURIComponent(v);
    } catch {
      // Malformed percent-encoding (rare — would mean another script wrote
      // the cookie). Fall back to the raw value rather than dropping the
      // identifier entirely; downstream tags still benefit from the click ID.
      zarazProps[propName] = v;
    }
  }

  try {
    zarazProps.content_name = document.title;
    zarazProps.traffic_source = document.referrer || '';
  } catch {
    zarazProps.content_name = '';
    zarazProps.traffic_source = '';
  }

  const utms = getUTMParams();
  Object.assign(zarazProps, utms);

  // ── 1. Cloudflare Zaraz (server-side CAPI bridge) ──
  // Zaraz forwards the event to Meta CAPI with the shared eventID, so the
  // browser-side Pixel hit below is deduplicated against this server hit.
  try {
    if (window.zaraz?.track) {
      window.zaraz.track(eventName, zarazProps);
    }
  } catch { /* zaraz script missing or errored — tracking is best-effort */ }

  // ── 2. Meta Pixel (browser-side) ──
  try {
    if (window.fbq) {
      // Re-init pixel with PII for advanced matching on subsequent events
      if (safeData.lead_email || safeData.lead_phone) {
        window.fbq('init', META_PIXEL_ID, buildAdvancedMatching(safeData));
      }

      const fbqPayload = { content_name: zarazProps.content_name };
      // Both standard and custom events use the 4th param for eventID deduplication
      if (eventName === 'Lead_MQL') {
        window.fbq('trackCustom', eventName, fbqPayload, { eventID });
      } else {
        window.fbq('track', eventName, fbqPayload, { eventID });
      }
    }
  } catch { /* ad blocker or script error — tracking is best-effort */ }

  // ── 3. dataLayer — GTM picks up events for GA4 + Google Ads conversions ──
  // PII excluded to avoid forwarding to third parties via GTM
  try {
    window.dataLayer = window.dataLayer || [];
    const { lead_email, lead_phone, lead_name, ...nonPiiData } = safeData;
    window.dataLayer.push({ event: eventName, eventID, ...nonPiiData });
  } catch { /* ignore */ }
}

// Plain module so next.config.mjs and the middleware share one list (SECURITY-DESIGN §11.2).

/** Headers that do not depend on the request: carried by every response, static files included. */
export const STATIC_SECURITY_HEADERS = Object.freeze({
  'Referrer-Policy': 'same-origin',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy':
    'accelerometer=(), autoplay=(self), camera=(), display-capture=(), fullscreen=(self), geolocation=(), gyroscope=(), magnetometer=(), microphone=(), payment=(), usb=()',
  'X-Robots-Tag': 'noindex, nofollow',
});

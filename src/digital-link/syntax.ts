function table(chars: string): Uint8Array {
  const t = new Uint8Array(128);
  for (let i = 0; i < chars.length; i++) t[chars.charCodeAt(i)] = 1;
  return t;
}

const ALNUM = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
/** Characters allowed anywhere in a Digital Link URI (dl.c): unreserved, reserved and "%". */
const URI_CHARS: Uint8Array = /* @__PURE__ */ table(`${ALNUM}-._~:/?#[]@!$&'()*+,;=%`);
/** Characters dl.c rejects in the host. */
const BAD_DOMAIN_CHARS: Uint8Array = /* @__PURE__ */ table("_~?#@!$&'()*+,;=%");
/** Unreserved characters, which percentEncode leaves as they are (RFC 3986 section 2.3). */
export const UNRESERVED: Uint8Array = /* @__PURE__ */ table(`${ALNUM}-._~`);

/** Schemes in the exact case forms DL URI Syntax 4.11 allows (mixed case is not allowed). */
export const SCHEMES: readonly string[] = ['https://', 'http://', 'HTTPS://', 'HTTP://'];

/** Length of the scheme prefix of `s` ("https://" is 8), or 0 when it has none of SCHEMES. */
export function schemeLength(s: string): number {
  for (const p of SCHEMES) if (s.startsWith(p)) return p.length;
  return 0;
}

function firstNotIn(s: string, t: Uint8Array, wanted: number): number {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if ((c < 128 ? t[c] : 0) !== wanted) return i;
  }
  return -1;
}

/** Index of the first character not allowed in a Digital Link URI, or -1. */
export function firstNonUriChar(s: string): number {
  return firstNotIn(s, URI_CHARS, 1);
}

/**
 * Whether a path segment is "." or "..", in any spelling WHATWG URL resolves away ("%2e" in
 * either case). A browser drops it (and for "..", the segment before), so the URI it opens is
 * not the one this library reads or wrote.
 */
export function isDotSegment(segment: string): boolean {
  const s = segment.toLowerCase().replaceAll('%2e', '.');
  return s === '.' || s === '..';
}

const HOST_NAME_CHARS: Uint8Array = /* @__PURE__ */ table(`${ALNUM}-.`);
const DIGITS: Uint8Array = /* @__PURE__ */ table('0123456789');

/**
 * Index of the first problem in an authority (host and optional port) that passed
 * firstBadDomainChar, or -1. The host is a name of letters, digits, '-' and '.', or an IPv6
 * literal in brackets; a port is 1 to 5 digits up to 65535. dl.c checks no further, but a stem
 * such as "good.com:evil.com" would mislead a caller and fails in browsers.
 */
export function badAuthority(authority: string): number {
  let portAt: number;
  if (authority.startsWith('[')) {
    const close = authority.indexOf(']');
    if (close < 0 || !isIpv6(authority.slice(0, close + 1))) return 0;
    portAt = close + 1;
  } else {
    const colon = authority.indexOf(':');
    portAt = colon < 0 ? authority.length : colon;
    if (portAt === 0) return 0;
    const bad = firstNotIn(authority.slice(0, portAt), HOST_NAME_CHARS, 1);
    if (bad >= 0) return bad;
  }
  if (portAt === authority.length) return -1;
  if (authority.charCodeAt(portAt) !== 0x3a) return portAt;
  const port = authority.slice(portAt + 1);
  const bad = firstNotIn(port, DIGITS, 1);
  if (bad >= 0) return portAt + 1 + bad;
  return port.length === 0 || port.length > 5 || Number(port) > 65535 ? portAt + 1 : -1;
}

const HEX: Uint8Array = /* @__PURE__ */ table('0123456789abcdefABCDEF');

/** Whether `group` is 1 to 4 hex digits. */
const isHexGroup = (group: string): boolean =>
  group.length >= 1 && group.length <= 4 && firstNotIn(group, HEX, 1) < 0;

/** Whether `s` is a dotted IPv4 address (each part 0 to 255, no leading zeros). */
function isIpv4(s: string): boolean {
  const parts = s.split('.');
  return (
    parts.length === 4 &&
    parts.every(
      (p) =>
        p.length >= 1 &&
        p.length <= 3 &&
        firstNotIn(p, DIGITS, 1) < 0 &&
        (p.length === 1 || p[0] !== '0') &&
        Number(p) <= 255,
    )
  );
}

/** Whether `literal` ("[...]") is an IPv6 address (RFC 4291 2.2), without a zone. */
function isIpv6(literal: string): boolean {
  if (!literal.endsWith(']')) return false;
  const inner = literal.slice(1, -1);
  const halves = inner.split('::');
  if (halves.length > 2) return false;
  let count = 0;
  for (const [h, half] of halves.entries()) {
    if (half === '') continue;
    const groups = half.split(':');
    for (const [i, g] of groups.entries()) {
      // An embedded IPv4 address may end the address, in place of two groups.
      const last = h === halves.length - 1 && i === groups.length - 1;
      if (last && g.includes('.')) {
        if (!isIpv4(g)) return false;
        count += 2;
      } else if (isHexGroup(g)) count++;
      else return false;
    }
  }
  return halves.length === 2 ? count < 8 : count === 8;
}

/** Index of the first character dl.c rejects in a host, or -1. The host is not otherwise checked. */
export function firstBadDomainChar(host: string): number {
  for (let i = 0; i < host.length; i++) {
    const c = host.charCodeAt(i);
    if (c < 128 && BAD_DOMAIN_CHARS[c] === 1) return i;
  }
  return -1;
}

/**
 * Who the request is from, for the purpose of counting it.
 *
 * This is the file where rate limiters are usually broken, and the two ways it
 * happens are both here as named decisions rather than as a `.split(",")[0]`.
 *
 * ## 1. `X-Forwarded-For` is written by the client
 *
 * Any HTTP client can send `X-Forwarded-For: 1.2.3.4`. Each proxy in front of
 * the application **appends** the address it saw to whatever was already there,
 * so the header that arrives is
 *
 *     <whatever the client made up>, <client as proxy 1 saw it>, <proxy 1 as proxy 2 saw it>, …
 *
 * The leftmost entry is therefore the *least* trustworthy value in the request,
 * and `xff.split(",")[0].trim()` — which is what almost every example on the
 * internet does — hands the attacker the key the limiter counts on. They send a
 * different value each time and the limit is not a limit.
 *
 * The trustworthy entries are the ones appended by infrastructure we control,
 * counting from the right. With `n` trusted proxies between the client and this
 * process, the client's real address is at index `length − n`: the rightmost
 * entry was written by the nearest proxy, the one before it by the proxy before
 * that, and so on until the last trusted hop, whose entry is the address it
 * observed the client at. `n` is a deployment fact, not something derivable
 * from the request, so it is configuration — `RATE_LIMIT_TRUSTED_PROXIES`.
 *
 * When the chain is *shorter* than `n` claims, something is wrong: the request
 * did not traverse the proxies it was supposed to. The fallback is the
 * rightmost entry rather than the leftmost, because the rightmost is the only
 * one an attacker cannot have written — whoever spoke to our nearest hop is at
 * worst an open proxy, and at best the attacker themselves. Falling back to the
 * leftmost would restore exactly the hole this file exists to close, and would
 * do it on a misconfiguration, silently.
 *
 * ## 2. One IPv6 host is not one IPv6 address
 *
 * A residential or datacentre IPv6 customer is routinely allocated a /64 or
 * larger — 18 quintillion addresses, all of which are theirs and all of which
 * are free to use. Keying by the full /128 means a single machine can spend
 * every budget in this file as many times as it likes by binding a new source
 * address per request; the counters would be perfect and the limit would be
 * decorative. So IPv6 addresses are truncated to their /64 prefix, which is the
 * smallest unit that generally corresponds to one subscriber. IPv4 is used
 * whole: /32 allocations are not handed out per household.
 */

/** How the client key was arrived at. Used for tests and for the log line. */
export interface ClientIdentity {
  /** The store key fragment: a normalised address, or `UNIDENTIFIED_CLIENT`. */
  key: string;
  /**
   * True when no address could be established and the request was put in the
   * shared bucket. Callers do not branch on it; it exists so the reason a
   * request was refused is legible.
   */
  unidentified: boolean;
}

/**
 * The bucket every request without a usable address shares.
 *
 * One bucket rather than one per request, which would be no limit at all. It
 * means unidentified traffic competes with itself for a single budget, which is
 * the conservative direction and is what a request arriving with no forwarding
 * header on a deployment that has proxies should be treated as. In local
 * development there is no proxy and every request lands here; that is fine,
 * because the budgets in `@/lib/rate-limit/policy` are set for a human at a
 * keyboard and one developer is one human.
 */
export const UNIDENTIFIED_CLIENT = "unidentified";

/** Default number of proxies appending to `X-Forwarded-For` in front of this app. */
export const DEFAULT_TRUSTED_PROXIES = 1;

/**
 * Reads `RATE_LIMIT_TRUSTED_PROXIES`.
 *
 * Deliberately not routed through `@/lib/env`. That module validates the whole
 * server schema — database URL, auth secret, S3 credentials — and the proxy
 * needs none of them; importing it here would make a limiter fail to boot over
 * a variable it never reads, and would drag the schema into a module graph this
 * feature otherwise keeps free of everything but the Fetch API.
 *
 * A value that is not a positive integer is ignored rather than fatal, and the
 * default applies. The alternative is a deployment that refuses to start over a
 * typo in a tuning knob, which is a worse failure than counting one hop wrong.
 */
export function trustedProxyCount(
  raw: string | undefined = process.env["RATE_LIMIT_TRUSTED_PROXIES"],
): number {
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 1) return DEFAULT_TRUSTED_PROXIES;
  return parsed;
}

/** `1.2.3.4:5678` → `1.2.3.4`, `[::1]:443` → `::1`, anything else unchanged. */
function stripPort(value: string): string {
  const bracketed = /^\[(?<address>.+)\](?::\d+)?$/u.exec(value);
  if (bracketed?.groups?.["address"]) return bracketed.groups["address"];

  // A bare IPv6 address contains colons of its own, so only strip a trailing
  // `:port` when there is exactly one colon — which makes it IPv4 or a hostname.
  const colons = value.split(":").length - 1;
  if (colons === 1) return value.slice(0, value.lastIndexOf(":"));

  return value;
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function isIpv4(value: string): boolean {
  return (
    IPV4.test(value) && value.split(".").every((octet) => Number(octet) <= 255)
  );
}

const HEXTET = /^[0-9a-f]{1,4}$/u;

/**
 * The eight 16-bit groups of an IPv6 address, or `undefined` if it is not one.
 *
 * Handles `::` expansion and the IPv4-mapped form (`::ffff:203.0.113.9`), which
 * is what a dual-stack listener reports for an IPv4 peer. Treating that as an
 * IPv6 address and truncating it to a /64 would collapse every IPv4 client on
 * the internet into a single bucket — `::ffff:0:0/64` — which is a limiter that
 * refuses the whole internet once any one address is noisy.
 */
function ipv6Groups(value: string): number[] | undefined {
  if (!value.includes(":")) return undefined;

  // Fold a trailing IPv4 literal into the two hextets it occupies, so the rest
  // of this function deals with hex groups only.
  let text = value;
  const trailing = text.slice(text.lastIndexOf(":") + 1);
  if (trailing.includes(".")) {
    if (!isIpv4(trailing)) return undefined;
    const [a = 0, b = 0, c = 0, d = 0] = trailing.split(".").map(Number);
    const head = text.slice(0, text.lastIndexOf(":") + 1);
    text = `${head}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }

  const halves = text.split("::");
  if (halves.length > 2) return undefined;

  const split = (half: string | undefined): string[] =>
    half ? half.split(":").filter((part) => part !== "") : [];

  const head = split(halves[0]);
  const tail = halves.length === 2 ? split(halves[1]) : [];

  const zeros = halves.length === 2 ? 8 - head.length - tail.length : 0;
  if (zeros < 0) return undefined;

  const hextets = [...head, ...Array<string>(zeros).fill("0"), ...tail];
  if (hextets.length !== 8) return undefined;
  if (!hextets.every((hextet) => HEXTET.test(hextet))) return undefined;

  return hextets.map((hextet) => Number.parseInt(hextet, 16));
}

/**
 * An address as it should be counted, or `undefined` if it is not an address.
 *
 * Unparseable input is rejected rather than used verbatim. Using it would let a
 * caller mint unlimited distinct keys out of arbitrary strings — the same bypass
 * as spoofing, reached by sending nonsense instead of a plausible address.
 */
export function normaliseAddress(raw: string): string | undefined {
  const value = stripPort(raw.trim().toLowerCase());
  if (value === "") return undefined;

  if (isIpv4(value)) return value;

  const groups = ipv6Groups(value);
  if (!groups) return undefined;

  // An IPv4-mapped address is an IPv4 client; report it as one so it shares a
  // bucket with the same client arriving over a v4-only path.
  const [g0, g1, g2, g3, g4, g5, g6 = 0, g7 = 0] = groups;
  if ([g0, g1, g2, g3, g4].every((group) => group === 0) && g5 === 0xffff) {
    return `${g6 >> 8}.${g6 & 0xff}.${g7 >> 8}.${g7 & 0xff}`;
  }

  // /64: the first four groups, which identify the subscriber, not the host.
  return `${groups
    .slice(0, 4)
    .map((group) => group.toString(16))
    .join(":")}::/64`;
}

/**
 * The entry of `X-Forwarded-For` written by the last trusted hop.
 *
 * Exported separately from `clientIdentity` because the index arithmetic is the
 * whole security property of this module and deserves to be tested on its own,
 * without a `Headers` object in the way.
 */
export function selectForwardedEntry(
  forwarded: string,
  trustedProxies: number,
): string | undefined {
  const entries = forwarded
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "");

  if (entries.length === 0) return undefined;

  const index =
    entries.length >= trustedProxies
      ? entries.length - trustedProxies
      : entries.length - 1;

  return entries[index];
}

/**
 * The key this request counts against.
 *
 * `x-real-ip` is consulted only when `x-forwarded-for` is absent entirely. It
 * is a single value with no chain, so there is no way to tell a proxy that set
 * it from a client that sent it; a deployment whose proxy sets `x-real-ip` and
 * not `x-forwarded-for` is trusting that proxy to overwrite it, which is the
 * same trust `RATE_LIMIT_TRUSTED_PROXIES` already expresses. Preferring the
 * chain means the header an attacker can add never displaces the one our
 * infrastructure writes.
 */
export function clientIdentity(
  headers: Headers,
  trustedProxies: number = trustedProxyCount(),
): ClientIdentity {
  const forwarded = headers.get("x-forwarded-for");
  const candidate = forwarded
    ? selectForwardedEntry(forwarded, trustedProxies)
    : (headers.get("x-real-ip") ?? undefined);

  const address = candidate ? normaliseAddress(candidate) : undefined;

  return address
    ? { key: address, unidentified: false }
    : { key: UNIDENTIFIED_CLIENT, unidentified: true };
}

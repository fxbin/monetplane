import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isLocalWebhookDeliveryAllowed } from "../../config/env";

export type WebhookDnsLookupResult = Array<{ address: string; family: number }>;

export type WebhookDnsLookup = (
  hostname: string,
  options: { all: true },
) => Promise<WebhookDnsLookupResult>;

function stripIpBracketsAndZone(raw: string): {
  ip: string;
  hasZone: boolean;
} {
  let value = raw.trim();
  if (value.startsWith("[") && value.endsWith("]")) {
    value = value.slice(1, -1);
  }
  const zoneIndex = value.indexOf("%");
  if (zoneIndex !== -1) {
    return { ip: value.slice(0, zoneIndex), hasZone: true };
  }
  return { ip: value, hasZone: false };
}

function parseIpv4Octets(ip: string): [number, number, number, number] | null {
  if (isIP(ip) !== 4) return null;
  const parts = ip.split(".").map((part) => Number(part));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return null;
  }
  return [parts[0], parts[1], parts[2], parts[3]];
}

function parseIpv6Groups(ip: string): number[] | null {
  if (isIP(ip) !== 6) return null;
  let normalized = ip.toLowerCase();

  // Expand trailing embedded IPv4 (e.g. ::ffff:127.0.0.1) into two hex groups.
  const lastColon = normalized.lastIndexOf(":");
  if (lastColon !== -1 && normalized.includes(".")) {
    const ipv4Tail = normalized.slice(lastColon + 1);
    const octets = parseIpv4Octets(ipv4Tail);
    if (!octets) return null;
    const hi = ((octets[0] << 8) | octets[1]).toString(16);
    const lo = ((octets[2] << 8) | octets[3]).toString(16);
    normalized = `${normalized.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const doubleColonParts = normalized.split("::");
  if (doubleColonParts.length > 2) return null;

  let groupsRaw: string[];
  if (doubleColonParts.length === 2) {
    const left = doubleColonParts[0] ? doubleColonParts[0].split(":") : [];
    const right = doubleColonParts[1] ? doubleColonParts[1].split(":") : [];
    const missing = 8 - (left.length + right.length);
    if (missing < 0) return null;
    groupsRaw = [...left, ...Array<string>(missing).fill("0"), ...right];
  } else {
    groupsRaw = normalized.split(":");
  }

  if (groupsRaw.length !== 8) return null;
  const groups: number[] = [];
  for (const part of groupsRaw) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(Number.parseInt(part, 16));
  }
  return groups;
}

function isLoopbackIpv4(octets: [number, number, number, number]): boolean {
  return octets[0] === 127;
}

function isPrivateOrReservedIpv4(
  octets: [number, number, number, number],
): boolean {
  const [a, b, c] = octets;
  if (a === 0) return true; // 0.0.0.0/8 ("this" network)
  if (a === 10) return true; // 10.0.0.0/8 (RFC1918)
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 (CGNAT)
  if (a === 127) return true; // 127.0.0.0/8 (loopback)
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local & cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 (RFC1918)
  if (a === 192 && b === 0 && c === 0) return true; // 192.0.0.0/24 (IETF)
  if (a === 192 && b === 0 && c === 2) return true; // 192.0.2.0/24 (TEST-NET-1)
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 (RFC1918)
  if (a === 198 && (b === 18 || b === 19)) return true; // 198.18.0.0/15 (benchmark)
  if (a === 198 && b === 51 && c === 100) return true; // 198.51.100.0/24 (TEST-NET-2)
  if (a === 203 && b === 0 && c === 113) return true; // 203.0.113.0/24 (TEST-NET-3)
  if (a >= 224) return true; // 224.0.0.0/4 (multicast) & 240.0.0.0/4 (reserved/broadcast)
  return false;
}

function embeddedIpv4FromGroups(
  hi: number,
  lo: number,
): [number, number, number, number] {
  return [(hi >> 8) & 0xff, hi & 0xff, (lo >> 8) & 0xff, lo & 0xff];
}

function isLoopbackIpv6Groups(groups: number[]): boolean {
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) {
    return true;
  }
  // IPv4-mapped ::ffff:127.0.0.0/8 or IPv4-compatible ::127.0.0.0/8
  if (
    groups.slice(0, 5).every((g) => g === 0) &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    return isLoopbackIpv4(embeddedIpv4FromGroups(groups[6], groups[7]));
  }
  return false;
}

function isPrivateOrReservedIpv6Groups(groups: number[]): boolean {
  // Unspecified ::
  if (groups.every((g) => g === 0)) return true;
  // Loopback ::1
  if (groups.slice(0, 7).every((g) => g === 0) && groups[7] === 1) return true;

  // IPv4-mapped ::ffff:0:0/96 or IPv4-compatible ::/96
  if (
    groups.slice(0, 5).every((g) => g === 0) &&
    (groups[5] === 0xffff || groups[5] === 0)
  ) {
    return isPrivateOrReservedIpv4(
      embeddedIpv4FromGroups(groups[6], groups[7]),
    );
  }

  // IPv4-translated ::ffff:0:0:0/96
  if (
    groups.slice(0, 4).every((g) => g === 0) &&
    groups[4] === 0xffff &&
    groups[5] === 0
  ) {
    return isPrivateOrReservedIpv4(
      embeddedIpv4FromGroups(groups[6], groups[7]),
    );
  }

  // NAT64 64:ff9b::/96 and 64:ff9b:1::/48
  if (groups[0] === 0x0064 && groups[1] === 0xff9b) {
    if (groups[2] === 0x0001) return true;
    if (groups.slice(2, 6).every((g) => g === 0)) {
      return isPrivateOrReservedIpv4(
        embeddedIpv4FromGroups(groups[6], groups[7]),
      );
    }
  }

  // 6to4 2002::/16 (embedded IPv4 in groups[1..2])
  if (groups[0] === 0x2002) {
    return isPrivateOrReservedIpv4(
      embeddedIpv4FromGroups(groups[1], groups[2]),
    );
  }

  // Teredo 2001:0000::/32 (client IPv4 XOR'd in groups[6..7])
  if (groups[0] === 0x2001 && groups[1] === 0) {
    return true;
  }

  // Discard prefix 0100::/64
  if (groups[0] === 0x0100 && groups.slice(1, 4).every((g) => g === 0)) {
    return true;
  }

  // Documentation 2001:db8::/32
  if (groups[0] === 0x2001 && groups[1] === 0x0db8) return true;

  // Unique local addresses fc00::/7
  if ((groups[0] & 0xfe00) === 0xfc00) return true;

  // Link-local fe80::/10 and deprecated site-local fec0::/10
  if ((groups[0] & 0xffc0) === 0xfe80) return true;
  if ((groups[0] & 0xffc0) === 0xfec0) return true;

  // Multicast ff00::/8
  if ((groups[0] & 0xff00) === 0xff00) return true;

  return false;
}

/** True when `rawIp` is a private, loopback, link-local, metadata, or reserved IP. */
export function isPrivateOrReservedIp(rawIp: string): boolean {
  const { ip, hasZone } = stripIpBracketsAndZone(rawIp);
  if (hasZone) return true;

  const v4 = parseIpv4Octets(ip);
  if (v4) return isPrivateOrReservedIpv4(v4);

  const v6 = parseIpv6Groups(ip);
  if (v6) return isPrivateOrReservedIpv6Groups(v6);

  return true; // Fail closed on unparseable IP inputs
}

/** True when `rawIp` is specifically a loopback IPv4/IPv6 address. */
export function isLoopbackIp(rawIp: string): boolean {
  const { ip, hasZone } = stripIpBracketsAndZone(rawIp);
  if (hasZone) return false;

  const v4 = parseIpv4Octets(ip);
  if (v4) return isLoopbackIpv4(v4);

  const v6 = parseIpv6Groups(ip);
  if (v6) return isLoopbackIpv6Groups(v6);

  return false;
}

function isExplicitLoopbackHostname(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/\.$/, "");
  if (clean === "localhost" || clean.endsWith(".localhost")) {
    return true;
  }
  const { ip, hasZone } = stripIpBracketsAndZone(clean);
  if (hasZone) return false;
  const v4 = parseIpv4Octets(ip);
  if (v4) return isLoopbackIpv4(v4);
  const v6 = parseIpv6Groups(ip);
  if (v6) return v6.slice(0, 7).every((g) => g === 0) && v6[7] === 1;
  return false;
}

function isForbiddenInternalHostname(hostname: string): boolean {
  const clean = hostname.toLowerCase().replace(/\.$/, "");
  return (
    clean.endsWith(".local") ||
    clean.endsWith(".internal") ||
    clean.endsWith(".arpa")
  );
}

function assertIpAllowedForHost(
  ip: string,
  hostname: string,
  mode: "test" | "live",
): void {
  if (!isPrivateOrReservedIp(ip)) return;

  const allowLoopbackInTest =
    mode === "test" &&
    isLocalWebhookDeliveryAllowed() &&
    isExplicitLoopbackHostname(hostname) &&
    isLoopbackIp(ip);

  if (allowLoopbackInTest) return;

  throw new Error(
    "Webhook endpoint cannot target private, loopback, or internal network addresses",
  );
}

/**
 * Static URL validation applied on webhook creation and before delivery.
 * Preserves clear protocol/length/credential messages while rejecting SSRF
 * targets (metadata IPs, RFC1918, .internal/.local, and loopback unless
 * explicitly enabled for `test` mode).
 */
export function assertSafeWebhookUrl(url: URL, mode: "test" | "live"): void {
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Webhook endpoint must use http or https");
  }
  if (mode === "live" && url.protocol !== "https:") {
    throw new Error("Production webhook endpoints must use https");
  }
  if (url.username || url.password) {
    throw new Error("Webhook endpoint URL must not contain credentials");
  }
  if (url.hash) {
    throw new Error("Webhook endpoint URL must not contain a fragment");
  }
  if (url.toString().length > 2048) {
    throw new Error("Webhook endpoint URL is too long");
  }

  const hostname = url.hostname;
  if (!hostname) {
    throw new Error("Webhook endpoint must be a valid URL");
  }
  if (isForbiddenInternalHostname(hostname)) {
    throw new Error(
      "Webhook endpoint cannot target private, loopback, or internal network addresses",
    );
  }

  const { ip, hasZone } = stripIpBracketsAndZone(hostname);
  if (hasZone) {
    throw new Error(
      "Webhook endpoint cannot target private, loopback, or internal network addresses",
    );
  }

  if (isIP(ip) !== 0) {
    assertIpAllowedForHost(ip, hostname, mode);
    return;
  }

  if (isExplicitLoopbackHostname(hostname)) {
    if (mode !== "test" || !isLocalWebhookDeliveryAllowed()) {
      throw new Error(
        "Webhook endpoint cannot target private, loopback, or internal network addresses",
      );
    }
  }
}

/**
 * Full destination validation executed right before outbound fetch():
 * runs static URL checks and resolves DNS A/AAAA records to block DNS
 * rebinding into private, loopback, link-local, or cloud metadata networks.
 */
export async function assertSafeWebhookDestination(
  rawUrl: string,
  mode: "test" | "live",
  options: { lookupImpl?: WebhookDnsLookup; skipDnsLookup?: boolean } = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl.trim());
  } catch {
    throw new Error("Webhook endpoint must be a valid URL");
  }

  assertSafeWebhookUrl(url, mode);

  const { ip } = stripIpBracketsAndZone(url.hostname);
  if (options.skipDnsLookup || isIP(ip) !== 0) {
    return;
  }

  const resolved = options.lookupImpl
    ? await options.lookupImpl(url.hostname, { all: true })
    : await lookup(url.hostname, { all: true });
  const addresses = Array.isArray(resolved) ? resolved : [resolved];
  if (addresses.length === 0) {
    throw new Error("Webhook endpoint host did not resolve to any address");
  }

  for (const record of addresses) {
    assertIpAllowedForHost(record.address, url.hostname, mode);
  }
}

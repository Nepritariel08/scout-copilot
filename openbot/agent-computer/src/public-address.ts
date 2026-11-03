import { BlockList, isIP } from "node:net";

/**
 * Deliberately narrow addresses for the owned example.org sample, not a general public-IP oracle.
 * Reviewed IANA special-purpose registry snapshots last updated 2025-10-09:
 * https://www.iana.org/assignments/iana-ipv4-special-registry/
 * https://www.iana.org/assignments/iana-ipv6-special-registry/
 *
 * Even globally reachable special-purpose services are unnecessary for this sample and refused.
 * Multicast/reserved IPv4, historical 6bone, and IPv6 outside global-unicast 2000::/3 are refused too.
 * This also refuses mapped/compatible IPv4, both IANA NAT64 prefixes, ULA, link-local and multicast;
 * 2001::/23 and 2002::/16 refuse Teredo/6to4 rather than trying to unwrap their embedded addresses.
 * Site-specific translation/routes and a process bypassing this proxy still need runtime isolation.
 */
const specialV4 = new BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  specialV4.addSubnet(address, prefix, "ipv4");

const globalV6 = new BlockList();
globalV6.addSubnet("2000::", 3, "ipv6");
const specialV6 = new BlockList();
for (const [address, prefix] of [
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["2620:4f:8000::", 48],
  ["3ffe::", 16],
  ["3fff::", 20],
] as const)
  specialV6.addSubnet(address, prefix, "ipv6");

export function isPublicSampleAddress(address: string): boolean {
  // DNS answers must be bare IP literals, with no URL brackets, scope ID or whitespace.
  if (address.includes("%") || address.trim() !== address) return false;
  const family = isIP(address);
  if (family === 4) return !specialV4.check(address, "ipv4");
  return (
    family === 6 &&
    globalV6.check(address, "ipv6") &&
    !specialV6.check(address, "ipv6")
  );
}

export const PUBLIC_SAMPLE_DNS_TIMEOUT_MS = 3_000;
export const PUBLIC_SAMPLE_MAX_ADDRESSES = 32;
export type PublicSampleDns = {
  resolve4(host: string): Promise<string[]>;
  resolve6(host: string): Promise<string[]>;
  cancel(): void;
};

/** Both families must complete; only ENODATA is an acceptable missing family. No partial success. */
export async function resolvePublicSampleAddresses(
  host: string,
  dns: PublicSampleDns,
  timeoutMs = PUBLIC_SAMPLE_DNS_TIMEOUT_MS,
): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const results = await Promise.race([
      Promise.allSettled([
        Promise.resolve().then(() => dns.resolve4(host)),
        Promise.resolve().then(() => dns.resolve6(host)),
      ]),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error("Sample DNS timed out.")),
          timeoutMs,
        );
      }),
    ]);
    const addresses: string[] = [];
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        if (
          !result.reason ||
          typeof result.reason !== "object" ||
          result.reason.code !== "ENODATA"
        )
          throw new Error("Sample DNS did not complete.");
      } else {
        if (
          !result.value.every(
            (address) => isIP(address) === (index === 0 ? 4 : 6),
          )
        )
          throw new Error("Sample DNS returned an invalid address family.");
        addresses.push(...result.value);
      }
    }
    if (
      addresses.length < 1 ||
      addresses.length > PUBLIC_SAMPLE_MAX_ADDRESSES ||
      !addresses.every(isPublicSampleAddress)
    )
      throw new Error("Sample DNS contains an unavailable destination.");
    return [...new Set(addresses)];
  } finally {
    clearTimeout(timer);
    dns.cancel();
  }
}

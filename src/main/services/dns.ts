import { promises as dns } from "node:dns";
import { getCachedDns, setCachedDns } from "./persistence";
import { getLogger } from "./logger";

const log = getLogger();

export interface ReverseDnsOptions {
  forceRefresh?: boolean;
}

export async function resolveReverseDns(
  ipAddress: string,
  options?: ReverseDnsOptions
): Promise<string | undefined> {
  if (!ipAddress) {
    return undefined;
  }

  if (!options?.forceRefresh) {
    const cached = getCachedDns(ipAddress);
    if (cached) {
      return cached;
    }
  }

  try {
    const [host] = await dns.reverse(ipAddress);
    if (host) {
      if (!options?.forceRefresh) {
        setCachedDns(ipAddress, host);
      }
      return host;
    }
  } catch (error) {
    log.debug("Reverse DNS lookup failed", ipAddress, error);
  }

  return undefined;
}

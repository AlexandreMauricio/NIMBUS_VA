import { promises as dns } from "dns";
import { isPrivateIPv4 } from "./subnet";
import { HostnameResolver } from "./types";

/**
 * Names for local addresses through the system's own resolver — on a home
 * network, usually the router answering for the devices it gave addresses
 * to. Private addresses only; each lookup is bounded by `timeoutMs`.
 */
export function dnsHostnameResolver(timeoutMs = 1500): HostnameResolver {
  return {
    async reverse(ip: string): Promise<string | null> {
      if (!isPrivateIPv4(ip)) return null;
      let timer: ReturnType<typeof setTimeout> | null = null;
      try {
        const names = await Promise.race([
          dns.reverse(ip),
          new Promise<string[]>((_, reject) => {
            timer = setTimeout(() => reject(new Error("timeout")), timeoutMs);
            (timer as { unref?: () => void }).unref?.();
          }),
        ]);
        const name = names.find((n) => typeof n === "string" && n.trim());
        return name ? name.trim().replace(/\.$/, "") : null;
      } catch {
        return null;
      } finally {
        if (timer) clearTimeout(timer);
      }
    },
  };
}

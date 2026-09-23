import * as dns from "dns";
import * as http from "http";
import * as https from "https";
import type { LookupFunction } from "net";
import { DEFAULT_HTTP_TIMEOUT_MS } from "../common/timeout";
import { isPublicAddress, parseIPv4, parseIPv6 } from "../network/subnet";

/**
 * Fetches a web page at an address the renderer named — so it must only
 * ever reach the public Internet, never this PC or the local network.
 *
 * Checking the address before calling `fetch` isn't enough: a public page
 * can redirect to 192.168.1.1, and a public-looking name can resolve to
 * 127.0.0.1 (or resolve differently the second time it is asked). So the
 * check sits inside the connection itself — Node's `http`/`https` take a
 * `lookup` function, and this one refuses a name that resolves anywhere
 * but the public Internet before a socket is opened. Redirects are
 * followed by hand, each hop checked the same way.
 *
 * The body is read up to `maxBytes` and the connection dropped there, so
 * an endless page costs a megabyte, not the machine's memory.
 */

export type PublicFetchErrorKind = "address" | "protocol" | "status" | "redirects" | "network";

export class PublicFetchError extends Error {
  constructor(
    message: string,
    readonly kind: PublicFetchErrorKind,
    readonly status?: number
  ) {
    super(message);
    this.name = "PublicFetchError";
  }
}

/** What `dns.lookup(host, { all: true })` answers. */
export type Resolver = (hostname: string) => Promise<dns.LookupAddress[]>;

export type Requester = (
  url: URL,
  options: http.RequestOptions,
  onResponse: (response: http.IncomingMessage) => void
) => http.ClientRequest;

export interface PublicFetchOptions {
  /** Bytes of body kept; the rest is never downloaded. Default 1 MB. */
  maxBytes?: number;
  /** Redirects followed before giving up. Default 5. */
  maxRedirects?: number;
  /** One deadline for the whole fetch, redirects included. */
  timeoutMs?: number;
  headers?: Record<string, string>;
  /** For tests: DNS. */
  resolve?: Resolver;
  /** For tests: the request itself. */
  request?: Requester;
}

export interface PublicPage {
  /** Where the page finally came from, after redirects. */
  url: string;
  status: number;
  contentType: string;
  body: string;
  /** Whether the body was cut at `maxBytes`. */
  truncated: boolean;
}

const systemResolve: Resolver = (hostname) => dns.promises.lookup(hostname, { all: true });

const systemRequest: Requester = (url, options, onResponse) =>
  (url.protocol === "https:" ? https : http).request(url, options, onResponse);

/** A host that names this machine or the local network by name alone. */
function isLocalName(host: string): boolean {
  return host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host === "";
}

/** A lookup for http.request that only ever hands back public addresses. */
function checkedLookup(resolve: Resolver): LookupFunction {
  return (hostname, options, callback) => {
    resolve(hostname).then(
      (addresses) => {
        if (!addresses.length) {
          callback(new PublicFetchError(`${hostname} has no address.`, "network"), "", 4);
          return;
        }
        if (addresses.some((a) => !isPublicAddress(a.address))) {
          callback(
            new PublicFetchError(`${hostname} points into this machine or network.`, "address"),
            "",
            4
          );
          return;
        }
        if (options.all) (callback as unknown as (e: null, a: dns.LookupAddress[]) => void)(null, addresses);
        else callback(null, addresses[0].address, addresses[0].family);
      },
      (err: Error) => callback(err, "", 4)
    );
  };
}

/** Throws unless `url` may be fetched: http(s), and not a local name or a non-public literal address. */
function checkUrl(url: URL): void {
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new PublicFetchError("Only http and https addresses can be fetched.", "protocol");
  const host = url.hostname.toLowerCase();
  if (isLocalName(host)) throw new PublicFetchError("That address is on this machine or network.", "address");
  const literal = parseIPv4(host) !== null || parseIPv6(host) !== null;
  if (literal && !isPublicAddress(host))
    throw new PublicFetchError("That address is on this machine or network.", "address");
}

function charsetOf(contentType: string): string {
  const match = contentType.match(/charset\s*=\s*"?([\w.:-]+)"?/i);
  return match ? match[1].toLowerCase() : "utf-8";
}

function decode(bytes: Buffer, contentType: string): string {
  try {
    return new TextDecoder(charsetOf(contentType)).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}

export async function fetchPublicPage(
  address: string,
  options: PublicFetchOptions = {}
): Promise<PublicPage> {
  const maxBytes = options.maxBytes ?? 1_000_000;
  const maxRedirects = options.maxRedirects ?? 5;
  const lookup = checkedLookup(options.resolve ?? systemResolve);
  const request = options.request ?? systemRequest;

  let url: URL;
  try {
    url = new URL(address);
  } catch {
    throw new PublicFetchError("That doesn't look like a web address.", "protocol");
  }

  const controller = new AbortController();
  const timeoutMs = options.timeoutMs ?? DEFAULT_HTTP_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    for (let hop = 0; ; hop++) {
      checkUrl(url);
      const response = await new Promise<http.IncomingMessage>((resolve, reject) => {
        const req = request(
          url,
          { method: "GET", headers: options.headers, lookup, signal: controller.signal },
          resolve
        );
        req.on("error", (err) =>
          reject(
            err instanceof PublicFetchError
              ? err
              : controller.signal.aborted
                ? new PublicFetchError(`The site took longer than ${timeoutMs / 1000} s.`, "network")
                : new PublicFetchError(`Couldn't reach the site (${err.message}).`, "network")
          )
        );
        req.end();
      });

      const status = response.statusCode ?? 0;
      const location = response.headers.location;
      if (status >= 300 && status < 400 && location) {
        response.resume();
        if (hop >= maxRedirects)
          throw new PublicFetchError("The site redirected too many times.", "redirects");
        try {
          url = new URL(location, url);
        } catch {
          throw new PublicFetchError("The site redirected to an address that doesn't work.", "network");
        }
        continue;
      }
      if (status < 200 || status >= 300) {
        response.resume();
        throw new PublicFetchError(`The site answered ${status}.`, "status", status);
      }

      const contentType = String(response.headers["content-type"] ?? "");
      const { bytes, truncated } = await readCapped(response, maxBytes);
      return { url: url.toString(), status, contentType, body: decode(bytes, contentType), truncated };
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Reads a response up to `maxBytes`, then drops the connection. */
function readCapped(
  response: http.IncomingMessage,
  maxBytes: number
): Promise<{ bytes: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const finish = (truncated: boolean) => {
      if (done) return;
      done = true;
      resolve({ bytes: Buffer.concat(chunks).subarray(0, maxBytes), truncated });
    };
    response.on("data", (chunk: Buffer) => {
      if (done) return;
      chunks.push(chunk);
      total += chunk.length;
      if (total >= maxBytes) {
        finish(total > maxBytes);
        response.destroy();
      }
    });
    response.on("end", () => finish(false));
    response.on("error", (err) => {
      if (!done) reject(new PublicFetchError(`The download failed (${err.message}).`, "network"));
    });
  });
}

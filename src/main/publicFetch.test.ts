import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type * as http from "node:http";
import type * as dns from "node:dns";
import { fetchPublicPage, PublicFetchError, Requester, Resolver } from "./publicFetch";

interface FakeReply {
  status: number;
  headers?: Record<string, string>;
  body?: string | Buffer;
}

/**
 * A stand-in network. DNS answers from `names`; a request first runs the
 * lookup it was given — exactly as a real socket would before connecting —
 * and only then answers from `pages`, keyed by URL.
 */
function fakeNet(names: Record<string, string>, pages: Record<string, FakeReply>) {
  const requested: string[] = [];
  const resolve: Resolver = async (hostname) => {
    const address = names[hostname];
    if (!address) throw new Error(`ENOTFOUND ${hostname}`);
    return [{ address, family: address.includes(":") ? 6 : 4 } as dns.LookupAddress];
  };
  const request: Requester = (url, options, onResponse) => {
    const req = new EventEmitter() as EventEmitter & { end: () => void };
    req.end = () => {
      const connect = () => {
        requested.push(url.toString());
        const reply = pages[url.toString()];
        if (!reply) {
          req.emit("error", new Error("ECONNREFUSED"));
          return;
        }
        const res = new PassThrough() as unknown as http.IncomingMessage & PassThrough;
        res.statusCode = reply.status;
        res.headers = reply.headers ?? {};
        onResponse(res);
        res.end(reply.body ?? "");
      };
      const host = url.hostname;
      if (/^[\d.]+$/.test(host) || host.startsWith("[")) connect();
      else
        options.lookup!(host, { all: true }, (err) => {
          if (err) req.emit("error", err);
          else connect();
        });
    };
    return req as unknown as http.ClientRequest;
  };
  return { resolve, request, requested };
}

test("a public page is fetched and decoded", async () => {
  const net = fakeNet(
    { "recipes.example": "93.184.216.34" },
    {
      "https://recipes.example/soup": {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
        body: "<h1>Sopa de pedra</h1>",
      },
    }
  );
  const page = await fetchPublicPage("https://recipes.example/soup", net);
  assert.equal(page.body, "<h1>Sopa de pedra</h1>");
  assert.equal(page.truncated, false);
});

test("addresses on this machine or network are refused before any request", async () => {
  const net = fakeNet({}, {});
  for (const address of [
    "http://localhost/",
    "http://127.0.0.1/",
    "http://192.168.1.1/",
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/",
    "http://printer.local/",
  ]) {
    await assert.rejects(
      fetchPublicPage(address, net),
      (err: PublicFetchError) => err.kind === "address",
      address
    );
  }
  await assert.rejects(
    fetchPublicPage("file:///C:/Windows/win.ini", net),
    (err: PublicFetchError) => err.kind === "protocol"
  );
  assert.deepEqual(net.requested, []);
});

test("a name that resolves to a private address is refused at connection time", async () => {
  const net = fakeNet(
    { "sneaky.example": "127.0.0.1" },
    { "http://sneaky.example/": { status: 200, body: "x" } }
  );
  await assert.rejects(
    fetchPublicPage("http://sneaky.example/", net),
    (err: PublicFetchError) => err.kind === "address"
  );
  assert.deepEqual(net.requested, []);
});

test("a redirect into the local network is refused", async () => {
  const net = fakeNet(
    { "recipes.example": "93.184.216.34" },
    {
      "https://recipes.example/go": { status: 302, headers: { location: "http://192.168.1.1/admin" } },
      "http://192.168.1.1/admin": { status: 200, body: "router" },
    }
  );
  await assert.rejects(
    fetchPublicPage("https://recipes.example/go", net),
    (err: PublicFetchError) => err.kind === "address"
  );
  assert.deepEqual(net.requested, ["https://recipes.example/go"]);
});

test("public redirects are followed, but not forever", async () => {
  const pages: Record<string, FakeReply> = {
    "https://a.example/": { status: 301, headers: { location: "/next" } },
    "https://a.example/next": { status: 200, body: "here" },
    "https://loop.example/": { status: 302, headers: { location: "https://loop.example/" } },
  };
  const net = fakeNet({ "a.example": "93.184.216.34", "loop.example": "93.184.216.35" }, pages);
  const page = await fetchPublicPage("https://a.example/", net);
  assert.equal(page.url, "https://a.example/next");
  assert.equal(page.body, "here");
  await assert.rejects(
    fetchPublicPage("https://loop.example/", net),
    (err: PublicFetchError) => err.kind === "redirects"
  );
});

test("the body is cut at the cap", async () => {
  const net = fakeNet(
    { "big.example": "93.184.216.34" },
    { "https://big.example/": { status: 200, body: Buffer.alloc(5000, 97) } }
  );
  const page = await fetchPublicPage("https://big.example/", { ...net, maxBytes: 1000 });
  assert.equal(page.body.length, 1000);
  assert.equal(page.truncated, true);
});

test("an error status is reported with its code", async () => {
  const net = fakeNet({ "gone.example": "93.184.216.34" }, { "https://gone.example/": { status: 404 } });
  await assert.rejects(
    fetchPublicPage("https://gone.example/", net),
    (err: PublicFetchError) => err.kind === "status" && err.status === 404
  );
});

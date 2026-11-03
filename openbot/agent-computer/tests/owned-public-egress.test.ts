import { afterEach, describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import {
  connect,
  createServer as createTcpServer,
  type Server,
  type Socket,
} from "node:net";
import {
  connectInTurn,
  type EgressPolicy,
  egressDecision,
  egressFor,
  handleEgressPolicyRequest,
  parseEgressPolicy,
  setEgressPolicy,
  setPublicSampleResolver,
  startEgressFilter,
  stopEgressFilter,
} from "../src/egress";
import {
  isPublicSampleAddress,
  type PublicSampleDns,
  resolvePublicSampleAddresses,
} from "../src/public-address";

const policy: EgressPolicy = { mode: "owned_public_sample", rules: [] };
const public4 = "93.184.216.34";
const public6 = "2606:4700::1111";
const servers: Server[] = [];
afterEach(async () => {
  await stopEgressFilter();
  setPublicSampleResolver(null);
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});

describe("owned sample address and DNS admission", () => {
  test("ordinary public IPv4 and IPv6 can be used, without treating this as a general IP grant", () => {
    for (const address of [
      public4,
      public6,
      "8.8.8.8",
      "2a00:1450:4009:821::200e",
    ])
      expect(isPublicSampleAddress(address)).toBe(true);
    for (const address of [
      "0.0.0.0",
      "0.255.255.255",
      "10.0.0.1",
      "100.64.0.0",
      "100.127.255.255",
      "127.0.0.1",
      "127.255.255.255",
      "169.254.169.254",
      "172.16.0.0",
      "172.31.255.255",
      "192.0.0.9",
      "192.0.2.1",
      "192.31.196.1",
      "192.52.193.1",
      "192.88.99.2",
      "192.168.1.1",
      "192.175.48.1",
      "198.18.0.0",
      "198.19.255.255",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "239.255.255.255",
      "240.0.0.1",
      "255.255.255.255",
      "::",
      "::1",
      "::192.168.1.1",
      "::ffff:8.8.8.8",
      "::ffff:0808:0808",
      "::ffff:a9fe:a9fe",
      "64:ff9b::808:808",
      "64:ff9b:1::1",
      "100::1",
      "100:0:0:1::1",
      "2001::1",
      "2001:1::1",
      "2001:2::1",
      "2001:3::1",
      "2001:20::1",
      "2001:db8::1",
      "2002:0808:0808::1",
      "2620:4f:8000::1",
      "3ffe::1",
      "3fff::1",
      "5f00::1",
      "fc00::1",
      "fd00:ec2::254",
      "fd20:ce::254",
      "fe80::1",
      "ff02::1",
      "fe80::1%eth0",
      "[2606:4700::1111]",
      " 8.8.8.8",
      "example.org",
      "127.1",
      "0x7f000001",
    ])
      expect(isPublicSampleAddress(address)).toBe(false);
  });

  function dns(a: Promise<string[]>, aaaa: Promise<string[]>) {
    const queries: string[] = [];
    let cancellations = 0;
    const resolver: PublicSampleDns = {
      resolve4: async (host) => {
        queries.push(`A:${host}`);
        return a;
      },
      resolve6: async (host) => {
        queries.push(`AAAA:${host}`);
        return aaaa;
      },
      cancel: () => {
        cancellations += 1;
      },
    };
    return { resolver, queries, cancellations: () => cancellations };
  }
  const noData = () =>
    Promise.reject(Object.assign(new Error("no records"), { code: "ENODATA" }));

  test("both families finish and only the complete validated list is returned", async () => {
    const fixture = dns(
      Promise.resolve([public4, public4]),
      Promise.resolve([public6]),
    );
    expect(
      await resolvePublicSampleAddresses("example.org", fixture.resolver),
    ).toEqual([public4, public6]);
    expect(fixture.queries).toEqual(["A:example.org", "AAAA:example.org"]);
    expect(fixture.cancellations()).toBe(1);
  });

  test("a genuinely missing family is allowed, but missing all addresses refuses", async () => {
    const one = dns(Promise.resolve([public4]), noData());
    expect(
      await resolvePublicSampleAddresses("example.org", one.resolver),
    ).toEqual([public4]);
    const empty = dns(noData(), noData());
    await expect(
      resolvePublicSampleAddresses("example.org", empty.resolver),
    ).rejects.toThrow();
    const only6 = dns(noData(), Promise.resolve([public6]));
    expect(
      await resolvePublicSampleAddresses("example.org", only6.resolver),
    ).toEqual([public6]);
  });

  test.each(["ETIMEOUT", "ESERVFAIL", "ENOTFOUND", "ECANCELLED"])(
    "a failing family (%s) cannot be hidden by a successful family",
    async (code) => {
      const fixture = dns(
        Promise.resolve([public4]),
        Promise.reject(Object.assign(new Error("unavailable"), { code })),
      );
      await expect(
        resolvePublicSampleAddresses("example.org", fixture.resolver),
      ).rejects.toThrow();
      expect(fixture.cancellations()).toBe(1);
    },
  );

  test("any private/reserved/invalid answer poisons the entire response and record count is bounded", async () => {
    for (const values of [
      [public6, "fd00::1"],
      [public6, "::ffff:8.8.8.8"],
      [public6, "64:ff9b::808:808"],
      ["invalid"],
      Array(33).fill(public6),
    ]) {
      const fixture = dns(Promise.resolve([public4]), Promise.resolve(values));
      await expect(
        resolvePublicSampleAddresses("example.org", fixture.resolver),
      ).rejects.toThrow();
    }
  });

  test("a stalled family is cancelled at the strict deadline without using partial A data", async () => {
    const fixture = dns(Promise.resolve([public4]), new Promise(() => {}));
    await expect(
      resolvePublicSampleAddresses("example.org", fixture.resolver, 10),
    ).rejects.toThrow("timed out");
    expect(fixture.cancellations()).toBe(1);
  });

  test("strict rules and complete answers are required, with exact normalized host and port", async () => {
    expect(parseEgressPolicy(policy)).toEqual({ ok: true, policy });
    for (const invalid of [
      { mode: "owned_public_sample" },
      { ...policy, rules: [{ type: "domain", value: "example.org" }] },
      { ...policy, upstream: "http://proxy" },
    ])
      expect(parseEgressPolicy(invalid).ok).toBe(false);
    for (const host of ["example.org", "EXAMPLE.ORG."])
      expect(
        egressDecision(policy, host, 443, [public4, public6]).allowed,
      ).toBe(true);
    for (const host of [
      "sub.example.org",
      "example.org.attacker.test",
      public4,
      "localhost",
      "example.org..",
    ])
      expect(egressDecision(policy, host, 443, [public4]).allowed).toBe(false);
    for (const port of [80, 444, 8443])
      expect(
        egressDecision(policy, "example.org", port, [public4]).allowed,
      ).toBe(false);
    for (const addresses of [
      [],
      [public4, "127.0.0.1"],
      [public4, "fd00::1"],
      [public4, "invalid"],
    ])
      expect(
        egressDecision(policy, "example.org", 443, addresses).allowed,
      ).toBe(false);
    expect(
      (
        await handleEgressPolicyRequest(
          "sample",
          new Request("http://computer/egress-policy", {
            method: "PUT",
            body: JSON.stringify({ policy }),
          }),
        )
      ).status,
    ).toBe(200);
  });

  test("the connector tries only the validated literals with no hostname lookup or fallback", async () => {
    const fixture = dns(Promise.resolve([public4]), Promise.resolve([public6]));
    const addresses = await resolvePublicSampleAddresses(
      "example.org",
      fixture.resolver,
    );
    const dialled: { host: string; port: number }[] = [];
    const result = await new Promise<Socket>((resolve, reject) =>
      connectInTurn(
        { host: "example.org", port: 443, addresses },
        resolve,
        reject,
        100,
        (target) => {
          dialled.push(target);
          const socket = new EventEmitter() as Socket;
          socket.destroy = () => socket;
          queueMicrotask(() =>
            socket.emit(
              target.host === public4 ? "error" : "connect",
              new Error("synthetic first address refused"),
            ),
          );
          return socket;
        },
      ),
    );
    result.destroy();
    expect(dialled).toEqual([
      { host: public4, port: 443 },
      { host: public6, port: 443 },
    ]);
    expect(fixture.queries).toHaveLength(2);
  });
});

describe("strict filter refusal over real loopback sockets, without external DNS or connections", () => {
  async function through(port: number, authority: string, plain = false) {
    const secret = egressFor("sample", {})?.password;
    return new Promise<string>((resolve, reject) => {
      const socket = connect(port, "127.0.0.1", () =>
        socket.write(
          `${plain ? "GET" : "CONNECT"} ${authority} HTTP/1.1\r\nHost: ${authority}\r\nProxy-Authorization: Basic ${Buffer.from(`sample:${secret}`).toString("base64")}\r\nConnection: close\r\n\r\n`,
        ),
      );
      let answer = "";
      socket.setTimeout(1_000, () =>
        socket.destroy(new Error("fixture timed out")),
      );
      socket.on("data", (chunk) => {
        answer += chunk.toString();
      });
      socket.on("end", () => resolve(answer));
      socket.on("error", reject);
    });
  }

  test("the actual strict handler dials only the one validated DNS snapshot, never a rebound hostname", async () => {
    const origin = createTcpServer((socket) => socket.end("reached"));
    servers.push(origin);
    await new Promise<void>((resolve) =>
      origin.listen(0, "127.0.0.1", resolve),
    );
    const originPort = (origin.address() as { port: number }).port;
    let lookups = 0;
    setPublicSampleResolver(async () => {
      lookups += 1;
      return lookups === 1 ? [public4, public6] : ["127.0.0.1"];
    });
    const dialled: { host: string; port: number }[] = [];
    const filter = await startEgressFilter({
      env: {},
      publicSampleConnect: (target) => {
        dialled.push(target);
        // Only the offline fixture maps the captured PUBLIC literal to its own loopback listener.
        return connect({ host: "127.0.0.1", port: originPort });
      },
    });
    setEgressPolicy("sample", policy);
    expect(await through(filter.port, "EXAMPLE.ORG.:443")).toContain("reached");
    expect(dialled).toEqual([{ host: public4, port: 443 }]);
    expect(lookups).toBe(1);
    expect(await through(filter.port, "example.org:443")).toContain("403");
    expect(dialled).toHaveLength(1);
    expect(lookups).toBe(2);
  });

  test("non-sample names, nonexplicit ports and plain HTTP/HTTPS refuse before DNS", async () => {
    let resolutions = 0;
    setPublicSampleResolver(async () => {
      resolutions += 1;
      return ["127.0.0.1"];
    });
    const filter = await startEgressFilter({ env: {} });
    setEgressPolicy("sample", policy);
    for (const authority of [
      "sub.example.org:443",
      "example.org:80",
      "example.org:8443",
      "example.org",
      "example.org:0443",
      "127.0.0.1:443",
    ])
      expect(await through(filter.port, authority)).toContain("403");
    for (const url of ["http://example.org/", "https://example.org:443/"])
      expect(await through(filter.port, url, true)).toContain("403");
    expect(resolutions).toBe(0);
  });

  test("mixed public/private answers refuse the whole CONNECT, including AAAA and hexadecimal wrappers", async () => {
    const filter = await startEgressFilter({ env: {} });
    setEgressPolicy("sample", policy);
    for (const answer of [
      "127.0.0.1",
      "10.0.0.1",
      "100.100.100.200",
      "fd00::1",
      "::ffff:7f00:1",
      "64:ff9b::7f00:1",
    ]) {
      setPublicSampleResolver(async () => [public4, answer]);
      expect(await through(filter.port, "EXAMPLE.ORG.:443")).toContain("403");
    }
  });

  test.each(["EGRESS_PROXY_DEFAULT", "EGRESS_PROXY_SAMPLE"])(
    "a configured %s is refused before any DNS or upstream connection",
    async (variable) => {
      let upstreamRequests = 0;
      const upstream = createServer((_request, response) => {
        upstreamRequests += 1;
        response.end();
      });
      upstream.on("connect", (_request, socket) => {
        upstreamRequests += 1;
        socket.end();
      });
      servers.push(upstream);
      await new Promise<void>((resolve) =>
        upstream.listen(0, "127.0.0.1", resolve),
      );
      const port = (upstream.address() as { port: number }).port;
      let resolutions = 0;
      setPublicSampleResolver(async () => {
        resolutions += 1;
        return [public4];
      });
      const filter = await startEgressFilter({
        env: { [variable]: `http://127.0.0.1:${port}` },
      });
      setEgressPolicy("sample", policy);
      expect(await through(filter.port, "example.org:443")).toContain("403");
      expect(upstreamRequests).toBe(0);
      expect(resolutions).toBe(0);
    },
  );

  test("revocation while DNS is outstanding refuses instead of dialing the earlier public answer", async () => {
    let finish!: (addresses: string[]) => void;
    let asked!: () => void;
    const started = new Promise<void>((resolve) => {
      asked = resolve;
    });
    setPublicSampleResolver(() => {
      asked();
      return new Promise((resolve) => {
        finish = resolve;
      });
    });
    const filter = await startEgressFilter({ env: {} });
    setEgressPolicy("sample", policy);
    const pending = through(filter.port, "example.org:443");
    await started;
    setEgressPolicy("sample", { mode: "deny_all", rules: [] });
    finish([public4, public6]);
    expect(await pending).toContain("403");
  });
});

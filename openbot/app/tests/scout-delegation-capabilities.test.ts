import { expect, spyOn, test } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { deploymentCapabilitiesQueryOptions } from "../src/lib/deployment/queries";

test("owned delegation requires a true server capability while older licensed servers retain their existing behavior", async () => {
  let body: Record<string, unknown> = {};
  const transport = spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => Response.json(body), {
      preconnect: () => undefined,
    }),
  );
  try {
    for (const [response, enabled] of [
      [{ mode: "owned" }, false],
      [{ mode: "owned", delegatedDrafts: false }, false],
      [{ mode: "owned", delegatedDrafts: "true" }, false],
      [{ mode: "owned", delegatedDrafts: true }, true],
      [{ mode: "intelligence" }, true],
      [{}, true],
      [{ mode: "intelligence", delegatedDrafts: false }, false],
    ] as const) {
      body = response;
      const cache = new QueryClient();
      try {
        expect(
          (await cache.fetchQuery(deploymentCapabilitiesQueryOptions()))
            .delegatedDrafts,
        ).toBe(enabled);
      } finally {
        cache.clear();
      }
    }
  } finally {
    transport.mockRestore();
  }
});

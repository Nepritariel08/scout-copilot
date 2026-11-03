import { describe, expect, test } from "bun:test";
import { ownedApiAllowed } from "../src/scout/owned/capabilities";
import { ownedCatalog, ownedCatalogSchema } from "../src/scout/owned/catalog";

describe("owned capability catalog", () => {
  test("reports adapter availability without claiming any work-app connection or data grant", () => {
    const catalog = ownedCatalog({
      odooSelectedTask: true,
      delegatedDraft: true,
    });
    expect(ownedCatalogSchema.parse(catalog)).toEqual(catalog);
    expect(catalog.skills).toEqual({
      conversation: "available",
      odooSelectedTask: "requires_authorization",
      delegatedDraft: "requires_authorization",
    });
    expect(new Set(Object.values(catalog.integrations))).toEqual(
      new Set(["not_connected"]),
    );
    expect(catalog.voice).toBe("unavailable");
    expect(
      ownedCatalog({ odooSelectedTask: false, delegatedDraft: false }).skills,
    ).toEqual({
      conversation: "available",
      odooSelectedTask: "unavailable",
      delegatedDraft: "unavailable",
    });
    expect(
      ownedCatalogSchema.safeParse({ ...catalog, credential: "synthetic" })
        .success,
    ).toBe(false);
  });
  test("admits only the exact read route, without installing plugin administration", () => {
    expect(ownedApiAllowed("/api/scout/capabilities", "GET")).toBe(true);
    for (const path of [
      "/api/scout/capabilities/",
      "/api/scout/capabilities/other",
      "/api/plugins",
      "/api/agent-tools/call",
    ])
      expect(ownedApiAllowed(path, "GET")).toBe(false);
    for (const method of ["POST", "PUT", "PATCH", "DELETE"])
      expect(ownedApiAllowed("/api/scout/capabilities", method)).toBe(false);
  });
});

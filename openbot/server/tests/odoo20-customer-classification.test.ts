import { describe, expect, test } from "bun:test";
import {
  customerClassificationMatches,
  customerClassificationReport,
} from "./fixtures/odoo20-customer-classification";

const expected = {
  "base.group_portal": true,
  "base.group_user": false,
  "base.group_system": false,
  "base.group_erp_manager": false,
};

describe("bounded synthetic Odoo customer classification diagnostics", () => {
  test("distinguishes exact portal from internal/admin classification without relaxing any expectation", () => {
    expect(
      customerClassificationMatches(
        customerClassificationReport("portalA", "seed", expected),
      ),
    ).toBe(true);
    for (const group of Object.keys(expected) as (keyof typeof expected)[]) {
      const changed = {
        ...expected,
        [group]: !expected[group],
      };
      const report = customerClassificationReport("portalA", "json2", changed);
      expect(customerClassificationMatches(report)).toBe(false);
      expect(
        report.checks
          .filter((check) => check.actual !== check.expected)
          .map((check) => check.group),
      ).toEqual([group]);
    }
  });
  test("logs only four fixed boolean or null results, excluding raw keys, records and malformed values", () => {
    const secret = "synthetic-key-or-record-must-never-be-logged";
    for (const input of [
      null,
      [expected],
      secret,
      { ...expected, token: secret, record: { name: secret } },
      { ...expected, "base.group_portal": secret },
      { ...expected, "base.group_system": { token: secret } },
    ]) {
      const report = customerClassificationReport("portalB", "json2", input);
      expect(report.checks).toHaveLength(4);
      expect(
        report.checks.every(
          (check) => typeof check.actual === "boolean" || check.actual === null,
        ),
      ).toBe(true);
      expect(JSON.stringify(report)).not.toContain(secret);
    }
  });
});

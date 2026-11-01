/** Fixed synthetic qualification fields only. Never forward an Odoo response or fixture row to logs. */
export const customerGroupExpectations = [
  ["base.group_portal", true],
  ["base.group_user", false],
  ["base.group_system", false],
  ["base.group_erp_manager", false],
] as const;

export function customerClassificationReport(
  customer: "portalA" | "portalB",
  phase: "seed" | "json2" | "attestation",
  input: unknown,
) {
  const values =
    input && typeof input === "object" && !Array.isArray(input)
      ? (input as Record<string, unknown>)
      : {};
  return {
    fixture: "synthetic-odoo20-customer-classification",
    customer,
    phase,
    checks: customerGroupExpectations.map(([group, expected]) => ({
      group,
      expected,
      actual: typeof values[group] === "boolean" ? values[group] : null,
    })),
  };
}

export function customerClassificationMatches(
  report: ReturnType<typeof customerClassificationReport>,
) {
  return report.checks.every((check) => check.actual === check.expected);
}

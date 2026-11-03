import { createHash } from "node:crypto";
import { z } from "zod";
import { historyDigest } from "../history/protocol";
import type { MembershipReader } from "../membership";
import { ModelPolicyError, readProtectedModelFile } from "./policy";
import {
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  type ProjectTaskContextPrincipal,
  validateProjectTaskContextGrant,
} from "./record-context";

const name = z.string().regex(/^[A-Za-z0-9_-]{1,100}$/);
const positiveId = z.number().int().positive().max(2_147_483_647);
const bindingSchema = z.strictObject({
  userId: z
    .string()
    .min(1)
    .max(200)
    .refine((value) =>
      Array.from(value).every(
        (character) =>
          character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
      ),
    ),
  tenantId: name,
  revision: z.number().int().positive(),
  active: z.boolean(),
  expiresAt: z.iso.datetime(),
  sourceUid: positiveId.refine((uid) => uid > 1),
  // Missing retains the existing employee-only path. Only protected operator policy opts in.
  identityClass: z.literal("customer").optional(),
  companyIds: z
    .array(positiveId)
    .min(1)
    .max(100)
    .refine((ids) => new Set(ids).size === ids.length),
});
const configuration = z.strictObject({
  version: z.literal(1),
  deploymentId: name,
  sourceInstanceId: name,
  bindings: z.array(bindingSchema).max(100),
});
export type OdooIdentityBinding = z.infer<typeof bindingSchema> & {
  deploymentId: string;
  sourceInstanceId: string;
  fingerprint: string;
};
export type OdooBindingReader = (
  principal: ProjectTaskContextPrincipal,
) => Promise<OdooIdentityBinding>;
const denied = () => new ModelPolicyError("MODEL_ACCESS_DENIED");

/** Provisioned source identity, independent of DSH requester authority and native admission. */
export function parseOwnedOdooBinding(
  input: unknown,
  principal: ProjectTaskContextPrincipal,
  sourceInstanceId: string,
  now = Date.now(),
): OdooIdentityBinding {
  const parsed = configuration.safeParse(input);
  if (!parsed.success) throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  const config = parsed.data;
  if (
    new Set(config.bindings.map((row) => row.userId)).size !==
      config.bindings.length ||
    new Set(config.bindings.map((row) => row.sourceUid)).size !==
      config.bindings.length
  )
    throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
  const selected = config.bindings.find(
    (row) => row.userId === principal.userId,
  );
  if (
    config.deploymentId !== principal.deploymentId ||
    config.sourceInstanceId !== sourceInstanceId ||
    !selected ||
    !selected.active ||
    selected.tenantId !== principal.tenantId ||
    Date.parse(selected.expiresAt) <= now
  )
    throw denied();
  const binding = {
    ...selected,
    companyIds: [...selected.companyIds].sort((a, b) => a - b),
  };
  return {
    ...binding,
    deploymentId: config.deploymentId,
    sourceInstanceId: config.sourceInstanceId,
    fingerprint: createHash("sha256")
      .update(
        JSON.stringify({
          purpose: "scout-odoo-identity-v1",
          deploymentId: config.deploymentId,
          sourceInstanceId: config.sourceInstanceId,
          binding,
        }),
      )
      .digest("hex"),
  };
}

export function createOwnedOdooBindingReader(
  path: string,
  sourceInstanceId: string,
): OdooBindingReader {
  return async (principal) => {
    let value: unknown;
    try {
      value = JSON.parse(await readProtectedModelFile(path));
    } catch {
      throw new ModelPolicyError("MODEL_NOT_CONFIGURED");
    }
    return parseOwnedOdooBinding(value, principal, sourceInstanceId);
  };
}

export type OdooAdmission = {
  principal: ProjectTaskContextPrincipal;
  binding: OdooIdentityBinding;
  expiresAt: string;
  assertCurrent(): Promise<void>;
};
export type OdooAdmissionReader = (
  principal: ProjectTaskContextPrincipal,
) => Promise<OdooAdmission>;

/** Translate native membership into a separately scoped source grant/credential principal. */
export function createOwnedOdooAdmission(deps: {
  membership: MembershipReader;
  binding: OdooBindingReader;
  sourceInstanceId: string;
}): OdooAdmissionReader {
  return async (principal) => {
    const assertMembership = async () => {
      const value = await deps.membership({ id: principal.userId });
      if (
        value.userId !== principal.userId ||
        value.tenantId !== principal.tenantId ||
        value.deploymentId !== principal.deploymentId ||
        value.fingerprint !== principal.bindingFingerprint ||
        !(Date.parse(value.expiresAt) > Date.now())
      )
        throw denied();
      return value;
    };
    const member = await assertMembership();
    const binding = await deps.binding(principal);
    const assertCurrent = async () => {
      await assertMembership();
      const current = await deps.binding(principal);
      if (
        current.userId !== principal.userId ||
        current.tenantId !== principal.tenantId ||
        current.deploymentId !== principal.deploymentId ||
        current.sourceInstanceId !== deps.sourceInstanceId ||
        current.fingerprint !== binding.fingerprint ||
        !(Date.parse(current.expiresAt) > Date.now())
      )
        throw denied();
      await assertMembership();
    };
    await assertCurrent();
    return {
      principal: {
        ...principal,
        bindingFingerprint: createHash("sha256")
          .update(
            JSON.stringify({
              purpose: "scout-odoo-admission-v1",
              membership: principal.bindingFingerprint,
              odoo: binding.fingerprint,
            }),
          )
          .digest("hex"),
      },
      binding,
      expiresAt: new Date(
        Math.min(Date.parse(member.expiresAt), Date.parse(binding.expiresAt)),
      ).toISOString(),
      assertCurrent,
    };
  };
}

/** Existing saved grants cannot bypass a changed/revoked source mapping or native membership. */
export function bindOwnedOdooContext(
  port: ProjectTaskContextPort,
  admit: OdooAdmissionReader,
): ProjectTaskContextPort {
  const qualifyGrant = port.qualifyGrant;
  const admitForSource = async (principal: ProjectTaskContextPrincipal) => {
    const admission = await admit(principal);
    if (admission.binding.sourceInstanceId !== port.sourceInstanceId)
      throw denied();
    return admission;
  };
  const normalize = (value: unknown, principal: ProjectTaskContextPrincipal) =>
    value && typeof value === "object"
      ? { ...value, principal: { ...principal } }
      : value;
  return {
    sourceInstanceId: port.sourceInstanceId,
    async getGrant(principal) {
      const admission = await admitForSource(principal);
      const value = await port.getGrant(admission.principal);
      await admission.assertCurrent();
      return normalize(value, principal);
    },
    ...(qualifyGrant
      ? {
          async qualifyGrant(
            principal: ProjectTaskContextPrincipal,
            value: ProjectTaskContextGrant,
          ) {
            const grant = validateProjectTaskContextGrant(
              value,
              principal,
              Date.now(),
              false,
            );
            const admission = await admitForSource(principal);
            if (
              grant.sourceIdentity.instanceId !==
                admission.binding.sourceInstanceId ||
              grant.sourceIdentity.uid !== admission.binding.sourceUid ||
              JSON.stringify(
                [...grant.sourceIdentity.companyIds].sort((a, b) => a - b),
              ) !== JSON.stringify(admission.binding.companyIds)
            )
              throw denied();
            const inner = { ...grant, principal: admission.principal };
            const proof = await qualifyGrant(
              admission.principal,
              inner,
              admission.binding.identityClass,
            );
            await admission.assertCurrent();
            if (
              proof.grantDigest !== historyDigest(inner) ||
              !(Date.parse(proof.expiresAt) > Date.now()) ||
              Date.parse(proof.expiresAt) > Date.parse(grant.expiresAt)
            )
              throw denied();
            return {
              grantDigest: historyDigest(grant),
              expiresAt: new Date(
                Math.min(
                  Date.parse(proof.expiresAt),
                  Date.parse(admission.expiresAt),
                ),
              ).toISOString(),
            };
          },
        }
      : {}),
    async getReleaseGrant(principal, provider, modelPolicyFingerprint) {
      const admission = await admitForSource(principal);
      const value = await port.getReleaseGrant(
        admission.principal,
        provider,
        modelPolicyFingerprint,
      );
      await admission.assertCurrent();
      return normalize(value, principal);
    },
    async readProjectTask(request) {
      const admission = await admitForSource(request.principal);
      if (
        request.sourceIdentity.instanceId !==
          admission.binding.sourceInstanceId ||
        request.sourceIdentity.uid !== admission.binding.sourceUid ||
        JSON.stringify(
          [...request.sourceIdentity.companyIds].sort((a, b) => a - b),
        ) !== JSON.stringify(admission.binding.companyIds)
      )
        throw denied();
      const read =
        admission.binding.identityClass === "customer"
          ? port.readCustomerProjectTask
          : port.readProjectTask;
      if (!read) throw denied();
      const value = await read({
        ...request,
        principal: admission.principal,
      });
      await admission.assertCurrent();
      return value;
    },
  };
}

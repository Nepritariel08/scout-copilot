import { createHash, randomUUID } from "node:crypto";
import { historyDigest } from "../history/protocol";
import { credentialKey, type OdooUserApiKeyResolver } from "./odoo-json2";
import { ModelPolicyError } from "./policy";
import {
  type ProjectTaskContextGrant,
  type ProjectTaskContextPort,
  type ProjectTaskContextPrincipal,
  type ProjectTaskQualificationProof,
  validateProjectTaskContextGrant,
} from "./record-context";

const lifetimeMs = 15 * 60 * 1000;
const maxCached = 128;
const maxInFlight = 16;
type Qualifier = (
  key: string,
  uid: number,
  companies: number[],
) => Promise<number[]>;
const deny = (): never => {
  throw new ModelPolicyError("MODEL_ACCESS_DENIED");
};

/** Renewable identity evidence only: never writes a grant, vault row or history dependency. */
export function createOdooQualificationProofs(options: {
  sourceInstanceId: string;
  store: Pick<ProjectTaskContextPort, "getGrant">;
  credentials: OdooUserApiKeyResolver;
  verifyUserProjectScope: Qualifier;
  verifyCustomerProjectScope?: Qualifier;
  now?: () => number;
}) {
  const now = options.now ?? Date.now;
  const cache = new Map<string, ProjectTaskQualificationProof>();
  const inFlight = new Map<string, Promise<ProjectTaskQualificationProof>>();

  async function snapshot(
    principal: ProjectTaskContextPrincipal,
    expectedDigest: string,
  ) {
    const grant = validateProjectTaskContextGrant(
      await options.store.getGrant(principal),
      principal,
      now(),
      false,
    );
    if (
      grant.sourceIdentity.instanceId !== options.sourceInstanceId ||
      historyDigest(grant) !== expectedDigest
    )
      return deny();
    let apiKey: string;
    try {
      apiKey = credentialKey(
        await options.credentials.resolveForUid(
          grant.sourceIdentity.uid,
          grant.sourceIdentity.credentialRef,
          principal,
        ),
        grant.sourceIdentity.uid,
      );
    } catch {
      return deny();
    }
    // Only this one-way identity enters the cache key. The decrypted key is
    // local to qualification I/O and is never retained in cache/proof/status.
    const credentialIdentity = historyDigest({
      reference: grant.sourceIdentity.credentialRef,
      key: createHash("sha256").update(apiKey).digest("hex"),
    });
    return { grant, apiKey, credentialIdentity };
  }

  async function checked(
    principal: ProjectTaskContextPrincipal,
    expectedDigest: string,
    identity: string,
  ) {
    const latest = await snapshot(principal, expectedDigest);
    if (latest.credentialIdentity !== identity) return deny();
    return latest.grant;
  }

  function keyFor(
    grant: ProjectTaskContextGrant,
    identity: string,
    identityClass?: "customer",
  ) {
    return historyDigest({
      purpose: "scout-odoo-qualification-v1",
      grantDigest: historyDigest(grant),
      credentialIdentity: identity,
      identityClass: identityClass ?? "employee",
    });
  }
  function prune() {
    for (const [key, proof] of cache)
      if (Date.parse(proof.expiresAt) <= now()) cache.delete(key);
  }

  return {
    async qualifyGrant(
      principal: ProjectTaskContextPrincipal,
      expected: ProjectTaskContextGrant,
      identityClass?: "customer",
    ): Promise<ProjectTaskQualificationProof> {
      if (identityClass !== undefined && identityClass !== "customer")
        return deny();
      const expectedDigest = historyDigest(expected);
      const initial = await snapshot(principal, expectedDigest);
      const key = keyFor(
        initial.grant,
        initial.credentialIdentity,
        identityClass,
      );
      prune();
      let proof = cache.get(key);
      if (!proof) {
        let pending = inFlight.get(key);
        if (!pending) {
          if (inFlight.size >= maxInFlight)
            throw new ModelPolicyError("MODEL_UNAVAILABLE");
          const qualify =
            identityClass === "customer"
              ? options.verifyCustomerProjectScope
              : options.verifyUserProjectScope;
          if (!qualify) return deny();
          pending = (async () => {
            const projects = await qualify(
              initial.apiKey,
              initial.grant.sourceIdentity.uid,
              [...initial.grant.sourceIdentity.companyIds],
            );
            if (
              !Array.isArray(projects) ||
              projects.length > 100 ||
              projects.some(
                (id) => !Number.isSafeInteger(id) || id < 1 || id > 2147483647,
              ) ||
              new Set(projects).size !== projects.length ||
              !initial.grant.allowedProjectIds.every((id) =>
                projects.includes(id),
              )
            )
              return deny();
            const current = await checked(
              principal,
              expectedDigest,
              initial.credentialIdentity,
            );
            const result = {
              grantDigest: historyDigest(current),
              proofId: randomUUID(),
              expiresAt: new Date(
                Math.min(Date.parse(current.expiresAt), now() + lifetimeMs),
              ).toISOString(),
            };
            if (!(Date.parse(result.expiresAt) > now())) return deny();
            prune();
            if (cache.size >= maxCached) {
              const oldest = cache.keys().next().value;
              if (oldest !== undefined) cache.delete(oldest);
            }
            cache.set(key, result);
            return result;
          })();
          inFlight.set(key, pending);
          void pending.finally(() => inFlight.delete(key)).catch(() => {});
        }
        try {
          proof = await pending;
        } catch {
          cache.delete(key);
          return deny();
        }
      }
      // Every waiter/cache hit independently rechecks current DB/vault authority.
      try {
        await checked(principal, expectedDigest, initial.credentialIdentity);
        if (!(Date.parse(proof.expiresAt) > now())) return deny();
        return { ...proof };
      } catch {
        cache.delete(key);
        return deny();
      }
    },
    async assertQualification(
      principal: ProjectTaskContextPrincipal,
      expected: ProjectTaskContextGrant,
      proof: ProjectTaskQualificationProof,
      identityClass?: "customer",
    ): Promise<void> {
      if (identityClass !== undefined && identityClass !== "customer")
        return deny();
      const receipt = { ...proof };
      const expectedDigest = historyDigest(expected);
      if (receipt.grantDigest !== expectedDigest) return deny();
      const initial = await snapshot(principal, expectedDigest);
      const key = keyFor(
        initial.grant,
        initial.credentialIdentity,
        identityClass,
      );
      const current = cache.get(key);
      const same = () =>
        current &&
        cache.get(key) === current &&
        current.proofId === receipt.proofId &&
        current.grantDigest === receipt.grantDigest &&
        // The native wrapper may narrow expiry, never extend the source receipt.
        Date.parse(receipt.expiresAt) <= Date.parse(current.expiresAt) &&
        Date.parse(receipt.expiresAt) > now();
      if (!same()) return deny();
      await checked(principal, expectedDigest, initial.credentialIdentity);
      // A parallel replacement must not turn an old read into a new proof.
      if (!same()) return deny();
    },
    async status(
      principal: ProjectTaskContextPrincipal,
      expected: ProjectTaskContextGrant,
      identityClass?: "customer",
    ) {
      try {
        const expectedDigest = historyDigest(expected);
        const current = await snapshot(principal, expectedDigest);
        const proof = cache.get(
          keyFor(current.grant, current.credentialIdentity, identityClass),
        );
        await checked(principal, expectedDigest, current.credentialIdentity);
        const live = proof && Date.parse(proof.expiresAt) > now();
        return {
          renewable: true,
          current: !!live,
          expiresAt: live ? proof.expiresAt : null,
        };
      } catch {
        return { renewable: false, current: false, expiresAt: null };
      }
    },
  };
}

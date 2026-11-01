import { eq, or, sql } from "drizzle-orm";
import { redactAuditPayload } from "../audit";
import type { Database } from "../db/client";
import {
  accounts,
  auditEvents,
  revokedAccess,
  sessions,
  users,
} from "../db/schema";
import {
  type EntraIdentityRequest,
  type EntraIdentitySnapshot,
  type EntraIdentityStore,
  type EntraIdentityTransaction,
  EntraOperatorError,
} from "./entra-operator";

type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
export const ENTRA_OPERATOR_TARGET = "scout_entra_identity_operation";
function transactionPort(transaction: Transaction): EntraIdentityTransaction {
  return {
    async snapshot(
      request: EntraIdentityRequest,
    ): Promise<EntraIdentitySnapshot> {
      const targets = await transaction.execute(
        sql`select current_database() as database, current_user as role, inet_server_addr()::text as "serverAddress", inet_server_port() as "serverPort"`,
      );
      const target = targets[0] as EntraIdentitySnapshot["target"] | undefined;
      if (!target) throw new EntraOperatorError("ENTRA_TARGET_REFUSED");
      const [user] = await transaction
        .select({
          id: users.id,
          email: users.email,
          name: users.name,
          emailVerified: users.emailVerified,
          createdAt: users.createdAt,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(eq(users.id, request.nativeUser.id))
        .limit(1);
      const identities = await transaction
        .select({
          id: accounts.id,
          userId: accounts.userId,
          providerId: accounts.providerId,
          issuer: accounts.issuer,
          accountId: accounts.accountId,
          createdAt: accounts.createdAt,
          updatedAt: accounts.updatedAt,
        })
        .from(accounts)
        .where(
          or(
            eq(accounts.userId, request.nativeUser.id),
            sql`lower(${accounts.accountId}) = ${request.objectId}`,
          ),
        )
        .orderBy(accounts.id)
        .limit(101);
      const activeSessions = await transaction
        .select({
          id: sessions.id,
          createdAt: sessions.createdAt,
          expiresAt: sessions.expiresAt,
        })
        .from(sessions)
        .where(eq(sessions.userId, request.nativeUser.id))
        .orderBy(sessions.id)
        .limit(1001);
      const withdrawn = user
        ? await transaction
            .select({ email: revokedAccess.email })
            .from(revokedAccess)
            .where(eq(revokedAccess.email, user.email.toLowerCase()))
            .limit(1)
        : [];
      return {
        target,
        user: user
          ? {
              ...user,
              createdAt: user.createdAt.toISOString(),
              updatedAt: user.updatedAt.toISOString(),
            }
          : null,
        revoked: withdrawn.length > 0,
        accounts: identities.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        })),
        sessions: activeSessions.map((row) => ({
          ...row,
          createdAt: row.createdAt.toISOString(),
          expiresAt: row.expiresAt.toISOString(),
        })),
      };
    },
    async receipt(operationId) {
      const matches = await transaction
        .select({ payload: auditEvents.payload })
        .from(auditEvents)
        .where(
          sql`${auditEvents.eventType} = 'configuration.changed' and ${auditEvents.targetType} = ${ENTRA_OPERATOR_TARGET} and ${auditEvents.targetId} = ${operationId}`,
        )
        .limit(2);
      if (matches.length > 1)
        throw new EntraOperatorError("ENTRA_OPERATION_CONFLICT");
      return matches[0]?.payload ?? null;
    },
    async insertBinding(request) {
      await transaction.insert(accounts).values({
        id: `scout-entra-${request.operationId}`,
        providerId: "microsoft",
        issuer: request.issuer,
        accountId: request.objectId,
        userId: request.nativeUser.id,
      });
    },
    async removeBinding(accountId) {
      const rows = await transaction
        .delete(accounts)
        .where(eq(accounts.id, accountId))
        .returning({ id: accounts.id });
      if (rows.length !== 1)
        throw new EntraOperatorError("ENTRA_MAPPING_CONFLICT");
    },
    async removeSessions(userId) {
      return (
        await transaction
          .delete(sessions)
          .where(eq(sessions.userId, userId))
          .returning({ id: sessions.id })
      ).length;
    },
    async record(receipt) {
      // The operator label in a reviewed request is attribution, not a native authenticated session.
      // Do not falsely file this local database operation as that person's verified API action.
      await transaction.insert(auditEvents).values({
        eventType: "configuration.changed",
        targetType: ENTRA_OPERATOR_TARGET,
        targetId: receipt.operationId,
        initiatorKind: "deployment",
        payload: redactAuditPayload(receipt) as Record<string, unknown>,
      });
    },
  };
}

/** Bounded maintenance transaction; no mutations run during read-only preview. */
export function createEntraIdentityStore(
  database: Database,
): EntraIdentityStore {
  return {
    read: (use) =>
      database.transaction(
        async (transaction) => {
          await transaction.execute(sql`set local statement_timeout = '5s'`);
          await transaction.execute(
            sql`set local search_path = pg_catalog, public`,
          );
          return use(transactionPort(transaction));
        },
        { isolationLevel: "repeatable read", accessMode: "read only" },
      ),
    write: (use) =>
      database.transaction(async (transaction) => {
        await transaction.execute(sql`set local lock_timeout = '3s'`);
        await transaction.execute(sql`set local statement_timeout = '5s'`);
        await transaction.execute(
          sql`set local search_path = pg_catalog, public`,
        );
        // Advisory locks would not fence native/older auth writers. These short table locks also
        // cover absent account/session rows and revoke/contact races without a new schema index.
        await transaction.execute(
          sql`lock table users, accounts, sessions, revoked_access in share row exclusive mode`,
        );
        return use(transactionPort(transaction));
      }),
  };
}

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "accounts"
    WHERE "issuer" IS NOT NULL
    GROUP BY "issuer", "account_id"
    HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'Cannot enforce account issuer identity uniqueness: duplicate non-null issuer/account_id pairs exist; reconcile only from trusted provider identity evidence before migrating';
  END IF;
END;
$$;
--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_issuer_account_idx" ON "accounts" USING btree ("issuer","account_id");

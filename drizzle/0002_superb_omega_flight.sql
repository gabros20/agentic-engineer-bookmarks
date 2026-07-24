-- T6 fix (I2): collapse any pre-existing duplicate (userId, query) digest rows to one
-- (keep the newest by createdAt, tie-break on id) BEFORE adding the UNIQUE constraint, so the
-- ADD CONSTRAINT below can't fail on legacy append-per-generation rows.
DELETE FROM "saved_digests" a
USING "saved_digests" b
WHERE a."userId" = b."userId"
  AND a."query" = b."query"
  AND (a."createdAt" < b."createdAt"
       OR (a."createdAt" = b."createdAt" AND a."id" < b."id"));
--> statement-breakpoint
ALTER TABLE "saved_digests" ADD CONSTRAINT "saved_digests_userId_query_uq" UNIQUE("userId","query");
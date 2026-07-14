CREATE UNIQUE INDEX IF NOT EXISTS "issues_paperclip_intake_identity_uq"
ON "issues" ("company_id", "origin_kind", "origin_id")
WHERE "origin_kind" = 'paperclip' AND "origin_id" IS NOT NULL;

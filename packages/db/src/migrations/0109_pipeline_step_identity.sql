CREATE UNIQUE INDEX "issues_pipeline_step_identity_uq"
ON "issues" ("company_id", "origin_kind", "origin_id", "origin_fingerprint")
WHERE "origin_kind" = 'pipeline_step' AND "origin_id" IS NOT NULL;

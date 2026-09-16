ALTER TABLE "billing_operations" ADD COLUMN "failure_kind" text;
ALTER TABLE "billing_operations" ADD COLUMN "retry_of_operation_id" text;
ALTER TABLE "billing_operations" ADD COLUMN "attempt_number" integer DEFAULT 1 NOT NULL;
ALTER TABLE "billing_operations" ADD CONSTRAINT "billing_operations_failure_kind_check" CHECK ("billing_operations"."failure_kind" IS NULL OR "billing_operations"."failure_kind" IN ('rejected', 'outcome_uncertain'));
CREATE INDEX "billing_operations_retry_idx" ON "billing_operations" USING btree ("application_id", "retry_of_operation_id");

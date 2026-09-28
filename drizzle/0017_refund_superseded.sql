ALTER TABLE "refunds" DROP CONSTRAINT "refunds_status_check";--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_status_check" CHECK ("status" IN ('pending', 'succeeded', 'failed', 'superseded'));

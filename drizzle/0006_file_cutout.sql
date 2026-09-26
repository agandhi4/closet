ALTER TABLE "file" ADD COLUMN "cutout_status" text DEFAULT 'none' NOT NULL;--> statement-breakpoint
ALTER TABLE "file" ADD COLUMN "cutout_attempts" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "file" ADD COLUMN "cutout_job_version" integer;--> statement-breakpoint
ALTER TABLE "file" ADD COLUMN "cutout_requested_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "file" ADD CONSTRAINT "file_cutout_status_check" CHECK ("file"."cutout_status" in ('none', 'pending', 'ready', 'failed', 'edited'));
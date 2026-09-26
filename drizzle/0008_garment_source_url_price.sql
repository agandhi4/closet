ALTER TABLE "garment" ADD COLUMN "source_url" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "price" numeric(10, 2);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_source_url_check" CHECK ("garment"."source_url" ~* '^https?://');--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_price_check" CHECK ("garment"."price" >= 0);
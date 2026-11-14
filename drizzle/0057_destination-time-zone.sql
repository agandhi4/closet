SET LOCAL lock_timeout = '5s';
--> statement-breakpoint
-- #678: a trip destination's own zone, and the weather caches keyed by the zone
-- their days and hours are in. Every kept forecast names its zone in its JSON
-- (always APP_TIMEZONE until now), so those rows keep it; a row with no answer
-- (only failed attempts) has none and goes. The normals' JSON names no zone, so
-- every normals row goes: a cache, refetched on a trip's next far day. Located
-- trips keep a null zone (APP_TIMEZONE) until their destination is re-saved.
ALTER TABLE "trip" ADD COLUMN "time_zone" text;--> statement-breakpoint
ALTER TABLE "weather_forecast" ADD COLUMN "time_zone" text;--> statement-breakpoint
UPDATE "weather_forecast" SET "time_zone" = "forecast"->>'timeZone' WHERE "forecast" IS NOT NULL;--> statement-breakpoint
DELETE FROM "weather_forecast" WHERE "time_zone" IS NULL;--> statement-breakpoint
ALTER TABLE "weather_forecast" ALTER COLUMN "time_zone" SET NOT NULL;--> statement-breakpoint
DELETE FROM "weather_normals";--> statement-breakpoint
ALTER TABLE "weather_normals" ADD COLUMN "time_zone" text NOT NULL;--> statement-breakpoint
ALTER TABLE "weather_forecast" DROP CONSTRAINT "weather_forecast_pkey";--> statement-breakpoint
ALTER TABLE "weather_forecast" ADD CONSTRAINT "weather_forecast_pkey" PRIMARY KEY("latitude","longitude","time_zone");--> statement-breakpoint
ALTER TABLE "weather_normals" DROP CONSTRAINT "weather_normals_pkey";--> statement-breakpoint
ALTER TABLE "weather_normals" ADD CONSTRAINT "weather_normals_pkey" PRIMARY KEY("latitude","longitude","time_zone");--> statement-breakpoint
ALTER TABLE "trip" ADD CONSTRAINT "trip_time_zone_check" CHECK ("trip"."time_zone" is null or "trip"."latitude" is not null);

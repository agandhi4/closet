CREATE TABLE "user_weather" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"home_name" text,
	"home_latitude" numeric(4, 2),
	"home_longitude" numeric(5, 2),
	"here_latitude" numeric(4, 2),
	"here_longitude" numeric(5, 2),
	"here_located_at" timestamp with time zone,
	"temperature_offset" numeric(2, 1) DEFAULT '0' NOT NULL,
	"temperature_unit" text DEFAULT 'fahrenheit' NOT NULL,
	CONSTRAINT "user_weather_home_check" CHECK (("user_weather"."home_name" is null) = ("user_weather"."home_latitude" is null) and ("user_weather"."home_latitude" is null) = ("user_weather"."home_longitude" is null)),
	CONSTRAINT "user_weather_here_check" CHECK (("user_weather"."here_latitude" is null) = ("user_weather"."here_longitude" is null) and ("user_weather"."here_latitude" is null) = ("user_weather"."here_located_at" is null)),
	CONSTRAINT "user_weather_latitude_check" CHECK ("user_weather"."home_latitude" between -90 and 90 and "user_weather"."here_latitude" between -90 and 90),
	CONSTRAINT "user_weather_longitude_check" CHECK ("user_weather"."home_longitude" between -180 and 180 and "user_weather"."here_longitude" between -180 and 180),
	CONSTRAINT "user_weather_temperature_offset_check" CHECK ("user_weather"."temperature_offset" between -5 and 5),
	CONSTRAINT "user_weather_temperature_unit_check" CHECK ("user_weather"."temperature_unit" in ('celsius', 'fahrenheit'))
);
--> statement-breakpoint
CREATE TABLE "weather_forecast" (
	"latitude" numeric(4, 2) NOT NULL,
	"longitude" numeric(5, 2) NOT NULL,
	"forecast" jsonb,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "weather_forecast_pkey" PRIMARY KEY("latitude","longitude"),
	CONSTRAINT "weather_forecast_fetched_check" CHECK (("weather_forecast"."forecast" is null) = ("weather_forecast"."fetched_at" is null))
);
--> statement-breakpoint
ALTER TABLE "user_weather" ADD CONSTRAINT "user_weather_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;
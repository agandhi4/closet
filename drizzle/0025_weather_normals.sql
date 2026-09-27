CREATE TABLE "weather_normals" (
	"latitude" numeric(4, 2) NOT NULL,
	"longitude" numeric(5, 2) NOT NULL,
	"normals" jsonb,
	"fetched_at" timestamp with time zone,
	"attempted_at" timestamp with time zone NOT NULL,
	CONSTRAINT "weather_normals_pkey" PRIMARY KEY("latitude","longitude"),
	CONSTRAINT "weather_normals_fetched_check" CHECK (("weather_normals"."normals" is null) = ("weather_normals"."fetched_at" is null))
);

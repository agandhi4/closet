CREATE TABLE "plan_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"plan_id" integer NOT NULL,
	"name" text,
	"category" text NOT NULL,
	"type" text,
	"colors" text[],
	"materials" text[],
	"warmth_min" smallint,
	"warmth_max" smallint,
	"formality_min" smallint,
	"formality_max" smallint,
	"quantity" smallint DEFAULT 1 NOT NULL,
	"priority" text DEFAULT 'medium' NOT NULL,
	"budget" numeric(10, 2),
	"note" text,
	"proposed" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "plan_item_type_check" CHECK ("plan_item"."type" in ('t-shirt', 'long-sleeve-tee', 'shirt', 'polo', 'blouse', 'tank', 'sweater', 'cardigan', 'hoodie', 'sweatshirt', 'turtleneck', 'jeans', 'chinos', 'trousers', 'joggers', 'sweatpants', 'shorts', 'skirt', 'leggings', 'day-dress', 'evening-dress', 'jumpsuit', 'jacket', 'denim-jacket', 'leather-jacket', 'blazer', 'coat', 'parka', 'puffer', 'trench', 'rain-jacket', 'vest', 'fleece', 'sneakers', 'running-shoes', 'boots', 'loafers', 'dress-shoes', 'sandals', 'slides', 'heels', 'hat', 'cap', 'beanie', 'scarf', 'gloves', 'belt', 'sunglasses', 'tie', 'jewelry', 'watch', 'backpack', 'tote', 'crossbody', 'handbag', 'duffel')),
	CONSTRAINT "plan_item_colors_check" CHECK ("plan_item"."colors" <@ array['red', 'pink', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white', 'grey', 'beige', 'brown', 'gold', 'silver', 'pattern', 'other']::text[] and cardinality("plan_item"."colors") > 0),
	CONSTRAINT "plan_item_materials_check" CHECK ("plan_item"."materials" <@ array['cotton', 'linen', 'wool', 'merino', 'cashmere', 'silk', 'denim', 'leather', 'suede', 'polyester', 'nylon', 'fleece', 'down', 'knit', 'synthetic', 'other']::text[] and cardinality("plan_item"."materials") > 0),
	CONSTRAINT "plan_item_warmth_check" CHECK (("plan_item"."warmth_min" is null and "plan_item"."warmth_max" is null) or ("plan_item"."warmth_min" in (1, 2, 3, 4, 5) and "plan_item"."warmth_max" in (1, 2, 3, 4, 5) and "plan_item"."warmth_min" <= "plan_item"."warmth_max")),
	CONSTRAINT "plan_item_formality_check" CHECK (("plan_item"."formality_min" is null and "plan_item"."formality_max" is null) or ("plan_item"."formality_min" in (1, 2, 3, 4) and "plan_item"."formality_max" in (1, 2, 3, 4) and "plan_item"."formality_min" <= "plan_item"."formality_max")),
	CONSTRAINT "plan_item_quantity_check" CHECK ("plan_item"."quantity" between 1 and 30),
	CONSTRAINT "plan_item_priority_check" CHECK ("plan_item"."priority" in ('high', 'medium', 'low')),
	CONSTRAINT "plan_item_budget_check" CHECK ("plan_item"."budget" >= 0)
);
--> statement-breakpoint
CREATE TABLE "style_profile" (
	"user_id" integer PRIMARY KEY NOT NULL,
	"styles" text[],
	"budget" text,
	"palette" text[],
	"notes" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "style_profile_styles_check" CHECK ("style_profile"."styles" <@ array['elevated-basics', 'smart-casual', 'minimal', 'classic', 'workwear', 'outdoor-technical', 'streetwear', 'athleisure']::text[] and cardinality("style_profile"."styles") > 0),
	CONSTRAINT "style_profile_budget_check" CHECK ("style_profile"."budget" in ('budget', 'mid', 'premium', 'luxury')),
	CONSTRAINT "style_profile_palette_check" CHECK ("style_profile"."palette" <@ array['red', 'pink', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white', 'grey', 'beige', 'brown', 'gold', 'silver', 'pattern', 'other']::text[] and cardinality("style_profile"."palette") > 0)
);
--> statement-breakpoint
CREATE TABLE "style_rhythm" (
	"user_id" integer NOT NULL,
	"occasion" text NOT NULL,
	"times" smallint NOT NULL,
	"per" text NOT NULL,
	CONSTRAINT "style_rhythm_pkey" PRIMARY KEY("user_id","occasion"),
	CONSTRAINT "style_rhythm_occasion_check" CHECK ("style_rhythm"."occasion" in ('all-day', 'workout', 'work', 'daytime', 'evening', 'night-out')),
	CONSTRAINT "style_rhythm_times_check" CHECK ("style_rhythm"."times" between 1 and 31),
	CONSTRAINT "style_rhythm_per_check" CHECK ("style_rhythm"."per" in ('week', 'month'))
);
--> statement-breakpoint
CREATE TABLE "wardrobe_plan" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"name" text NOT NULL,
	"notes" text,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "plan_item" ADD CONSTRAINT "plan_item_plan_id_foreign" FOREIGN KEY ("plan_id") REFERENCES "public"."wardrobe_plan"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "style_profile" ADD CONSTRAINT "style_profile_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "style_rhythm" ADD CONSTRAINT "style_rhythm_user_id_foreign" FOREIGN KEY ("user_id") REFERENCES "public"."style_profile"("user_id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "wardrobe_plan" ADD CONSTRAINT "wardrobe_plan_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "plan_item_plan_id_index" ON "plan_item" USING btree ("plan_id");--> statement-breakpoint
CREATE UNIQUE INDEX "wardrobe_plan_owner_id_lower_name_unique" ON "wardrobe_plan" USING btree ("owner_id",lower("name"));--> statement-breakpoint
CREATE UNIQUE INDEX "wardrobe_plan_owner_id_active_unique" ON "wardrobe_plan" USING btree ("owner_id") WHERE "wardrobe_plan"."active";
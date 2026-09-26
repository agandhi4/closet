ALTER TABLE "garment" ADD COLUMN "type" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "warmth" smallint;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "formality" smallint;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "materials" text[];--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "pattern" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "fit" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "sleeve" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "length" text;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "fabric_weight" smallint;--> statement-breakpoint
ALTER TABLE "garment" ADD COLUMN "water_resistant" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_type_check" CHECK ("garment"."type" in ('t-shirt', 'long-sleeve-tee', 'shirt', 'polo', 'blouse', 'tank', 'sweater', 'cardigan', 'hoodie', 'sweatshirt', 'turtleneck', 'jeans', 'chinos', 'trousers', 'joggers', 'sweatpants', 'shorts', 'skirt', 'leggings', 'day-dress', 'evening-dress', 'jumpsuit', 'jacket', 'denim-jacket', 'leather-jacket', 'blazer', 'coat', 'parka', 'puffer', 'trench', 'rain-jacket', 'vest', 'fleece', 'sneakers', 'running-shoes', 'boots', 'loafers', 'dress-shoes', 'sandals', 'slides', 'heels', 'hat', 'cap', 'beanie', 'scarf', 'gloves', 'belt', 'sunglasses', 'tie', 'jewelry', 'watch', 'backpack', 'tote', 'crossbody', 'handbag', 'duffel'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_warmth_check" CHECK ("garment"."warmth" in (1, 2, 3, 4, 5));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_formality_check" CHECK ("garment"."formality" in (1, 2, 3, 4));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_materials_check" CHECK ("garment"."materials" <@ array['cotton', 'linen', 'wool', 'merino', 'cashmere', 'silk', 'denim', 'leather', 'suede', 'polyester', 'nylon', 'fleece', 'down', 'knit', 'synthetic', 'other']::text[] and cardinality("garment"."materials") > 0);--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_pattern_check" CHECK ("garment"."pattern" in ('solid', 'stripes', 'check', 'print', 'graphic', 'floral', 'other'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_fit_check" CHECK ("garment"."fit" in ('slim', 'regular', 'relaxed', 'oversized'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_sleeve_check" CHECK ("garment"."sleeve" in ('sleeveless', 'short', 'three-quarter', 'long'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_length_check" CHECK ("garment"."length" in ('short', 'knee', 'midi', 'full'));--> statement-breakpoint
ALTER TABLE "garment" ADD CONSTRAINT "garment_fabric_weight_check" CHECK ("garment"."fabric_weight" between 20 and 1200);
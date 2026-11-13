CREATE TABLE "outfit_rule" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"kind" text NOT NULL,
	"a_garment_id" integer,
	"a_category" text,
	"a_type" text,
	"a_color" text,
	"a_pattern" text,
	"b_garment_id" integer,
	"b_category" text,
	"b_type" text,
	"b_color" text,
	"b_pattern" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "outfit_rule_kind_check" CHECK ("outfit_rule"."kind" in ('never', 'always')),
	CONSTRAINT "outfit_rule_a_check" CHECK (num_nonnulls("outfit_rule"."a_garment_id", "outfit_rule"."a_category", "outfit_rule"."a_color", "outfit_rule"."a_pattern") = 1 and ("outfit_rule"."a_type" is null or "outfit_rule"."a_category" is not null)),
	CONSTRAINT "outfit_rule_a_category_check" CHECK ("outfit_rule"."a_category" in ('accessories', 'bags', 'outerwear', 'dresses', 'tops', 'bottoms', 'footwear', 'other')),
	CONSTRAINT "outfit_rule_a_type_check" CHECK ("outfit_rule"."a_type" in ('t-shirt', 'long-sleeve-tee', 'shirt', 'polo', 'blouse', 'tank', 'sweater', 'cardigan', 'hoodie', 'sweatshirt', 'turtleneck', 'jeans', 'chinos', 'trousers', 'joggers', 'sweatpants', 'shorts', 'skirt', 'leggings', 'day-dress', 'evening-dress', 'jumpsuit', 'jacket', 'denim-jacket', 'leather-jacket', 'blazer', 'coat', 'parka', 'puffer', 'trench', 'rain-jacket', 'vest', 'fleece', 'sneakers', 'running-shoes', 'boots', 'loafers', 'dress-shoes', 'sandals', 'slides', 'heels', 'hat', 'cap', 'beanie', 'scarf', 'gloves', 'belt', 'sunglasses', 'tie', 'jewelry', 'watch', 'backpack', 'tote', 'crossbody', 'handbag', 'duffel')),
	CONSTRAINT "outfit_rule_a_color_check" CHECK ("outfit_rule"."a_color" in ('red', 'pink', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white', 'grey', 'beige', 'brown', 'gold', 'silver', 'pattern', 'other')),
	CONSTRAINT "outfit_rule_a_pattern_check" CHECK ("outfit_rule"."a_pattern" in ('solid', 'stripes', 'check', 'print', 'graphic', 'floral', 'other')),
	CONSTRAINT "outfit_rule_b_check" CHECK (num_nonnulls("outfit_rule"."b_garment_id", "outfit_rule"."b_category", "outfit_rule"."b_color", "outfit_rule"."b_pattern") = 1 and ("outfit_rule"."b_type" is null or "outfit_rule"."b_category" is not null)),
	CONSTRAINT "outfit_rule_b_category_check" CHECK ("outfit_rule"."b_category" in ('accessories', 'bags', 'outerwear', 'dresses', 'tops', 'bottoms', 'footwear', 'other')),
	CONSTRAINT "outfit_rule_b_type_check" CHECK ("outfit_rule"."b_type" in ('t-shirt', 'long-sleeve-tee', 'shirt', 'polo', 'blouse', 'tank', 'sweater', 'cardigan', 'hoodie', 'sweatshirt', 'turtleneck', 'jeans', 'chinos', 'trousers', 'joggers', 'sweatpants', 'shorts', 'skirt', 'leggings', 'day-dress', 'evening-dress', 'jumpsuit', 'jacket', 'denim-jacket', 'leather-jacket', 'blazer', 'coat', 'parka', 'puffer', 'trench', 'rain-jacket', 'vest', 'fleece', 'sneakers', 'running-shoes', 'boots', 'loafers', 'dress-shoes', 'sandals', 'slides', 'heels', 'hat', 'cap', 'beanie', 'scarf', 'gloves', 'belt', 'sunglasses', 'tie', 'jewelry', 'watch', 'backpack', 'tote', 'crossbody', 'handbag', 'duffel')),
	CONSTRAINT "outfit_rule_b_color_check" CHECK ("outfit_rule"."b_color" in ('red', 'pink', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white', 'grey', 'beige', 'brown', 'gold', 'silver', 'pattern', 'other')),
	CONSTRAINT "outfit_rule_b_pattern_check" CHECK ("outfit_rule"."b_pattern" in ('solid', 'stripes', 'check', 'print', 'graphic', 'floral', 'other')),
	CONSTRAINT "outfit_rule_garments_check" CHECK ("outfit_rule"."a_garment_id" <> "outfit_rule"."b_garment_id")
);
--> statement-breakpoint
ALTER TABLE "outfit_rule" ADD CONSTRAINT "outfit_rule_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit_rule" ADD CONSTRAINT "outfit_rule_a_garment_id_foreign" FOREIGN KEY ("a_garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "outfit_rule" ADD CONSTRAINT "outfit_rule_b_garment_id_foreign" FOREIGN KEY ("b_garment_id") REFERENCES "public"."garment"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
CREATE UNIQUE INDEX "outfit_rule_owner_id_kind_a_b_unique" ON "outfit_rule" USING btree ("owner_id","kind",coalesce("a_garment_id", 0),coalesce("a_category", ''),coalesce("a_type", ''),coalesce("a_color", ''),coalesce("a_pattern", ''),coalesce("b_garment_id", 0),coalesce("b_category", ''),coalesce("b_type", ''),coalesce("b_color", ''),coalesce("b_pattern", ''));--> statement-breakpoint
CREATE INDEX "outfit_rule_a_garment_id_index" ON "outfit_rule" USING btree ("a_garment_id");--> statement-breakpoint
CREATE INDEX "outfit_rule_b_garment_id_index" ON "outfit_rule" USING btree ("b_garment_id");
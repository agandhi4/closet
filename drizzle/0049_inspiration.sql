CREATE TABLE "inspiration" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"title" varchar(255),
	"note" text,
	"source_url" text,
	"photo_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "inspiration_photo_id_unique" UNIQUE("photo_id"),
	CONSTRAINT "inspiration_photo_or_link_check" CHECK (num_nonnulls("inspiration"."photo_id", "inspiration"."source_url") > 0),
	CONSTRAINT "inspiration_source_url_check" CHECK ("inspiration"."source_url" ~* '^https?://')
);
--> statement-breakpoint
CREATE TABLE "inspiration_piece" (
	"inspiration_id" integer NOT NULL,
	"position" smallint NOT NULL,
	"role" text NOT NULL,
	"type" text,
	"colors" text[] NOT NULL,
	"pattern" text,
	"matched_garment_id" integer,
	CONSTRAINT "inspiration_piece_pkey" PRIMARY KEY("inspiration_id","position"),
	CONSTRAINT "inspiration_piece_role_check" CHECK ("inspiration_piece"."role" in ('top', 'bottom', 'one-piece', 'layer', 'footwear', 'accessory', 'bag')),
	CONSTRAINT "inspiration_piece_type_check" CHECK ("inspiration_piece"."type" in ('t-shirt', 'long-sleeve-tee', 'shirt', 'polo', 'blouse', 'tank', 'sweater', 'cardigan', 'hoodie', 'sweatshirt', 'turtleneck', 'jeans', 'chinos', 'trousers', 'joggers', 'sweatpants', 'shorts', 'skirt', 'leggings', 'day-dress', 'evening-dress', 'jumpsuit', 'jacket', 'denim-jacket', 'leather-jacket', 'blazer', 'coat', 'parka', 'puffer', 'trench', 'rain-jacket', 'vest', 'fleece', 'sneakers', 'running-shoes', 'boots', 'loafers', 'dress-shoes', 'sandals', 'slides', 'heels', 'hat', 'cap', 'beanie', 'scarf', 'gloves', 'belt', 'sunglasses', 'tie', 'jewelry', 'watch', 'backpack', 'tote', 'crossbody', 'handbag', 'duffel')),
	CONSTRAINT "inspiration_piece_colors_check" CHECK ("inspiration_piece"."colors" <@ array['red', 'pink', 'orange', 'yellow', 'green', 'blue', 'purple', 'black', 'white', 'grey', 'beige', 'brown', 'gold', 'silver', 'pattern', 'other']::text[] and cardinality("inspiration_piece"."colors") <= 2),
	CONSTRAINT "inspiration_piece_pattern_check" CHECK ("inspiration_piece"."pattern" in ('solid', 'stripes', 'check', 'print', 'graphic', 'floral', 'other'))
);
--> statement-breakpoint
ALTER TABLE "inspiration" ADD CONSTRAINT "inspiration_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inspiration" ADD CONSTRAINT "inspiration_photo_id_foreign" FOREIGN KEY ("photo_id") REFERENCES "public"."file"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inspiration_piece" ADD CONSTRAINT "inspiration_piece_inspiration_id_foreign" FOREIGN KEY ("inspiration_id") REFERENCES "public"."inspiration"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "inspiration_piece" ADD CONSTRAINT "inspiration_piece_matched_garment_id_foreign" FOREIGN KEY ("matched_garment_id") REFERENCES "public"."garment"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "inspiration_owner_id_id_index" ON "inspiration" USING btree ("owner_id","id");--> statement-breakpoint
CREATE INDEX "inspiration_piece_matched_garment_id_index" ON "inspiration_piece" USING btree ("matched_garment_id");
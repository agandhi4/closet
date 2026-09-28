CREATE TABLE "order_email" (
	"id" serial PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"email_id" text NOT NULL,
	"received_at" timestamp with time zone NOT NULL,
	"processed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"outcome" text NOT NULL,
	"items" smallint DEFAULT 0 NOT NULL,
	CONSTRAINT "order_email_account_id_email_id_unique" UNIQUE("account_id","email_id"),
	CONSTRAINT "order_email_outcome_check" CHECK ("order_email"."outcome" in ('imported', 'no-products', 'untrusted', 'too-large'))
);
--> statement-breakpoint
CREATE TABLE "order_item" (
	"id" serial PRIMARY KEY NOT NULL,
	"owner_id" integer NOT NULL,
	"order_email_id" integer NOT NULL,
	"product_url" text NOT NULL,
	"name" text,
	"brand" text,
	"price" numeric(10, 2),
	"currency" varchar(3),
	"ordered_on" date NOT NULL,
	"state" text DEFAULT 'pending' NOT NULL,
	"garment_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"decided_at" timestamp with time zone,
	CONSTRAINT "order_item_owner_id_product_url_unique" UNIQUE("owner_id","product_url"),
	CONSTRAINT "order_item_state_check" CHECK ("order_item"."state" in ('pending', 'added', 'dismissed')),
	CONSTRAINT "order_item_decided_check" CHECK (("order_item"."state" = 'pending') = ("order_item"."decided_at" is null)),
	CONSTRAINT "order_item_product_url_check" CHECK ("order_item"."product_url" ~* '^https?://'),
	CONSTRAINT "order_item_price_check" CHECK ("order_item"."price" >= 0)
);
--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_owner_id_foreign" FOREIGN KEY ("owner_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_order_email_id_foreign" FOREIGN KEY ("order_email_id") REFERENCES "public"."order_email"("id") ON DELETE cascade ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "order_item" ADD CONSTRAINT "order_item_garment_id_foreign" FOREIGN KEY ("garment_id") REFERENCES "public"."garment"("id") ON DELETE set null ON UPDATE cascade;--> statement-breakpoint
CREATE INDEX "order_email_received_at_index" ON "order_email" USING btree ("received_at");--> statement-breakpoint
CREATE INDEX "order_item_order_email_id_index" ON "order_item" USING btree ("order_email_id");--> statement-breakpoint
CREATE INDEX "order_item_garment_id_index" ON "order_item" USING btree ("garment_id");
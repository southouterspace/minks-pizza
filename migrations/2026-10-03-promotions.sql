ALTER TYPE "public"."order_event_type" ADD VALUE IF NOT EXISTS 'discount';

CREATE TYPE "public"."discount_source" AS ENUM('promotion', 'comp', 'loyalty');

CREATE TYPE "public"."discount_target" AS ENUM('items', 'delivery');

CREATE TYPE "public"."promotion_trigger" AS ENUM('automatic', 'code');

CREATE TABLE "promotions" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "promotions_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"name" text NOT NULL,
	"description" text,
	"trigger" "promotion_trigger" NOT NULL,
	"reward" jsonb NOT NULL,
	"min_subtotal_cents" integer DEFAULT 0 NOT NULL,
	"order_types" "order_type"[] NOT NULL,
	"starts_at" timestamp with time zone,
	"ends_at" timestamp with time zone,
	"schedule" jsonb,
	"new_customers_only" boolean DEFAULT false NOT NULL,
	"per_customer_limit" integer,
	"total_limit" integer,
	"stackable" boolean DEFAULT false NOT NULL,
	"advertised" boolean DEFAULT true NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotions_order_types_check" CHECK (cardinality("promotions"."order_types") > 0)
);

CREATE TABLE "promotion_codes" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "promotion_codes_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"promotion_id" integer NOT NULL,
	"code" text NOT NULL,
	"display" text NOT NULL,
	"max_uses" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "promotion_codes_code_unique" UNIQUE("code")
);

CREATE TABLE "order_discounts" (
	"id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "order_discounts_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
	"order_id" uuid NOT NULL,
	"promotion_id" integer,
	"code_id" integer,
	"label" text NOT NULL,
	"amount_cents" integer NOT NULL,
	"target" "discount_target" NOT NULL,
	"source" "discount_source" NOT NULL,
	"operator_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "order_discounts_amount_check" CHECK ("order_discounts"."amount_cents" > 0)
);

ALTER TABLE "orders" ADD COLUMN "customer_key" text GENERATED ALWAYS AS (right(regexp_replace(customer_phone, '\D', '', 'g'), 10)) STORED;

ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_code_id_promotion_codes_id_fk" FOREIGN KEY ("code_id") REFERENCES "public"."promotion_codes"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "order_discounts" ADD CONSTRAINT "order_discounts_operator_id_operators_id_fk" FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE set null ON UPDATE no action;

ALTER TABLE "promotion_codes" ADD CONSTRAINT "promotion_codes_promotion_id_promotions_id_fk" FOREIGN KEY ("promotion_id") REFERENCES "public"."promotions"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "order_discounts_order_id_idx" ON "order_discounts" USING btree ("order_id");

CREATE INDEX "order_discounts_promotion_id_idx" ON "order_discounts" USING btree ("promotion_id");

CREATE INDEX "order_discounts_code_id_idx" ON "order_discounts" USING btree ("code_id");

CREATE INDEX "orders_customer_key_idx" ON "orders" USING btree ("customer_key");

CREATE INDEX "promotion_codes_promotion_id_idx" ON "promotion_codes" USING btree ("promotion_id");

-- Until now orders.discount_cents held only a loyalty reward. Give each such
-- order its ledger row, so discount_cents is again the sum of its rows.
INSERT INTO "order_discounts" ("order_id", "label", "amount_cents", "target", "source", "created_at")
SELECT o."id", coalesce(o."loyalty_reward_name", 'Reward'), o."discount_cents", 'items', 'loyalty', o."placed_at"
FROM "orders" o
WHERE o."discount_cents" > 0
  AND NOT EXISTS (SELECT 1 FROM "order_discounts" d WHERE d."order_id" = o."id");

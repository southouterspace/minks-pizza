-- Per-size modifier prices (modifier_size_prices). Run BEFORE deploying the
-- code that reads them:
--
--   npm run db:migrate -- migrations/2026-10-04-modifier-size-prices.sql
--
-- Guarded, so re-running is a no-op.
DO $migrate$
BEGIN
  CREATE TABLE IF NOT EXISTS "modifier_size_prices" (
    "id" integer PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "modifier_size_prices_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 2147483647 START WITH 1 CACHE 1),
    "modifier_id" integer NOT NULL,
    "size_modifier_id" integer NOT NULL,
    "price_delta_cents" integer NOT NULL,
    "extra_price_delta_cents" integer,
    CONSTRAINT "modifier_size_prices_modifier_id_modifiers_id_fk" FOREIGN KEY ("modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE cascade ON UPDATE no action,
    CONSTRAINT "modifier_size_prices_size_modifier_id_modifiers_id_fk" FOREIGN KEY ("size_modifier_id") REFERENCES "public"."modifiers"("id") ON DELETE cascade ON UPDATE no action
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "modifier_size_prices_modifier_size" ON "modifier_size_prices" USING btree ("modifier_id", "size_modifier_id");
END
$migrate$;

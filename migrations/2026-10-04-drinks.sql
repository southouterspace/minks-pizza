DO $$
BEGIN
  ALTER TABLE "item_modifier_groups" ADD COLUMN IF NOT EXISTS "hidden_modifier_ids" integer[] DEFAULT '{}' NOT NULL;
  ALTER TABLE "item_modifier_groups" ADD COLUMN IF NOT EXISTS "sold_out_modifier_ids" integer[] DEFAULT '{}' NOT NULL;
  ALTER TABLE "menu_items" ADD COLUMN IF NOT EXISTS "is_alcoholic" boolean DEFAULT false NOT NULL;
  ALTER TABLE "order_items" ADD COLUMN IF NOT EXISTS "is_alcoholic" boolean DEFAULT false NOT NULL;
END $$;

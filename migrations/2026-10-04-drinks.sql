DO $$
BEGIN
  ALTER TABLE "item_modifier_groups" ADD COLUMN IF NOT EXISTS "hidden_modifier_ids" integer[] DEFAULT '{}' NOT NULL;
  ALTER TABLE "item_modifier_groups" ADD COLUMN IF NOT EXISTS "sold_out_modifier_ids" integer[] DEFAULT '{}' NOT NULL;
END $$;

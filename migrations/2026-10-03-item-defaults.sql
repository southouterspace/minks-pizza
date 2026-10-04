ALTER TABLE "item_modifier_groups" ADD COLUMN IF NOT EXISTS "default_modifier_ids" integer[] DEFAULT '{}' NOT NULL;

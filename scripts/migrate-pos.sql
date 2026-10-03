-- Front-of-house POS migration. Run BEFORE `npm run db:push`:
--
--   npm run db:migrate-pos      (or: psql "$URL" -f scripts/migrate-pos.sql)
--
-- It does only what `db:push` cannot do safely on its own: edit enums that
-- existing rows use, drop payment_status, reshape stored line modifiers, and
-- backfill new columns from old data. Each step is guarded by "has this run
-- already?", so re-running is a no-op. One DO block = one atomic statement.
DO $migrate$
DECLARE
  non_pending integer;
BEGIN
  -- A fresh database has nothing to migrate; db:push creates it whole.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'orders') THEN
    RETURN;
  END IF;

  -- payment_status → tenders ledger. No code path ever wrote anything but
  -- 'pending', so there is nothing to carry over; refuse rather than drop a
  -- real payment if one exists.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'orders' AND column_name = 'payment_status') THEN
    EXECUTE 'SELECT count(*) FROM orders WHERE payment_status::text <> ''pending'''
      INTO non_pending;
    IF non_pending > 0 THEN
      RAISE EXCEPTION '% orders have payment_status paid/refunded; record them as tenders before migrating', non_pending;
    END IF;
    ALTER TABLE orders DROP COLUMN payment_status;
  END IF;
  DROP TYPE IF EXISTS payment_status;

  -- order_status: the admin "confirm" step is gone (confirmed → new) and
  -- `held` is new. Postgres cannot drop an enum value, so swap the type.
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'order_status' AND e.enumlabel = 'confirmed') THEN
    ALTER TABLE orders ALTER COLUMN status DROP DEFAULT;
    ALTER TYPE order_status RENAME TO order_status_old;
    CREATE TYPE order_status AS ENUM ('held', 'new', 'preparing', 'ready', 'completed', 'canceled');
    ALTER TABLE orders ALTER COLUMN status TYPE order_status
      USING (CASE status::text WHEN 'confirmed' THEN 'new' ELSE status::text END)::order_status;
    ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'held';
    DROP TYPE order_status_old;
  END IF;

  ALTER TYPE order_type ADD VALUE IF NOT EXISTS 'dine_in';

  -- Group roles replace the KDS's name regexes; existing groups get theirs
  -- from the same names, once.
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'modifier_role') THEN
    CREATE TYPE modifier_role AS ENUM ('size', 'crust', 'sauce', 'cheese', 'topping', 'option');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'modifier_groups' AND column_name = 'role') THEN
    ALTER TABLE modifier_groups ADD COLUMN role modifier_role DEFAULT 'option' NOT NULL;
    UPDATE modifier_groups SET role = (CASE
      WHEN name ~* '\msize\M' THEN 'size'
      WHEN name ~* '\m(crust|dough)\M' THEN 'crust'
      WHEN name ~* 'topping' THEN 'topping'
      ELSE 'option' END)::modifier_role;
  END IF;

  -- Lines placed before the POS were sent to the kitchen when placed.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'order_items' AND column_name = 'fired_at') THEN
    ALTER TABLE order_items ADD COLUMN fired_at timestamp with time zone;
    UPDATE order_items i SET fired_at = o.placed_at FROM orders o WHERE o.id = i.order_id;
  END IF;

  -- Added here, not by db:push, because push stops to ask before adding a
  -- unique constraint to a table that has rows.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'order_items' AND column_name = 'line_uid') THEN
    ALTER TABLE order_items ADD COLUMN line_uid uuid DEFAULT gen_random_uuid() NOT NULL;
    ALTER TABLE order_items ADD CONSTRAINT order_items_line_uid_unique UNIQUE (line_uid);
  END IF;

  -- Old modifier snapshots carried names only. Give each a kind, role, id
  -- (matched by name within the item's groups; null when unmatched) and, for
  -- placeable roles, whole/regular.
  UPDATE order_items i SET modifiers = (
    SELECT coalesce(jsonb_agg(
      CASE WHEN r.role IN ('sauce', 'cheese', 'topping') THEN
        jsonb_build_object('kind', 'placed', 'modifierId', r.mid, 'role', r.role,
          'groupName', r.m->>'groupName', 'modifierName', r.m->>'modifierName',
          'priceDeltaCents', (r.m->>'priceDeltaCents')::int,
          'placement', 'whole', 'amount', 'regular')
      ELSE
        jsonb_build_object('kind', 'option', 'modifierId', r.mid, 'role', r.role,
          'groupName', r.m->>'groupName', 'modifierName', r.m->>'modifierName',
          'priceDeltaCents', (r.m->>'priceDeltaCents')::int)
      END ORDER BY r.ord), '[]'::jsonb)
    FROM (
      SELECT e.m, e.ord,
        CASE
          WHEN e.m->>'groupName' ~* '\msize\M' THEN 'size'
          WHEN e.m->>'groupName' ~* '\m(crust|dough)\M' THEN 'crust'
          WHEN e.m->>'groupName' ~* 'topping' THEN 'topping'
          ELSE 'option' END AS role,
        (SELECT md.id FROM modifiers md
           JOIN modifier_groups g ON g.id = md.group_id
           JOIN item_modifier_groups img ON img.group_id = g.id
          WHERE img.item_id = i.menu_item_id
            AND g.name = e.m->>'groupName' AND md.name = e.m->>'modifierName'
          LIMIT 1) AS mid
      FROM jsonb_array_elements(i.modifiers) WITH ORDINALITY AS e(m, ord)
    ) r)
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(i.modifiers) x WHERE NOT x ? 'kind');

  -- Customers, backfilled from every phone number already on an order. The
  -- table is created here (matching schema.ts) so the backfill can run
  -- before push; push then sees it as already in place.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'customers') THEN
    CREATE TABLE customers (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
      "phone" text NOT NULL,
      "name" text NOT NULL,
      "email" text,
      "notes" text,
      "last_order_at" timestamp with time zone,
      "created_at" timestamp with time zone DEFAULT now() NOT NULL,
      CONSTRAINT "customers_phone_unique" UNIQUE("phone")
    );
    INSERT INTO customers (phone, name, email, last_order_at)
    SELECT DISTINCT ON (p.phone) p.phone, p.customer_name, p.customer_email, p.placed_at
    FROM (
      SELECT regexp_replace(regexp_replace(customer_phone, '\D', '', 'g'), '^1(\d{10})$', '\1') AS phone,
             customer_name, customer_email, placed_at
      FROM orders
    ) p
    WHERE p.phone <> ''
    ORDER BY p.phone, p.placed_at DESC;

    ALTER TABLE orders ADD COLUMN customer_id uuid;
    ALTER TABLE orders ADD CONSTRAINT "orders_customer_id_customers_id_fk"
      FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
    UPDATE orders o SET customer_id = c.id FROM customers c
    WHERE c.phone = regexp_replace(regexp_replace(o.customer_phone, '\D', '', 'g'), '^1(\d{10})$', '\1');
  END IF;
END
$migrate$;

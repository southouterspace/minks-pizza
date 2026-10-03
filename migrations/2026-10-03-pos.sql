-- Front-of-house POS: tenders, drawer sessions, customers, held orders, POS
-- access and the kitchen status fold. Takes a database at the promotions
-- migration (2026-10-03-promotions.sql, plus the delivery-integrations
-- columns db:push added), with or without the topping-inventory schema
-- (PR #17: modifier_groups.kind, placement/portion on line modifiers), to
-- the merged schema without losing a row.
--
-- Run BEFORE `npm run db:push`:
--
--   npm run db:migrate -- migrations/2026-10-03-pos.sql
--
-- Every step is guarded by "has this run already?", so re-running is a
-- no-op. One DO block = one atomic statement: it all lands or none of it.
DO $migrate$
DECLARE
  refunded integer;
BEGIN
  -- A fresh database has nothing to migrate; db:push creates it whole.
  IF NOT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'orders') THEN
    RETURN;
  END IF;

  -- Two backfills below each need these rules. pg_temp keeps one copy of
  -- each without adding anything to the schema; both are dropped at the end.
  CREATE OR REPLACE FUNCTION pg_temp.modifier_role_of(group_name text) RETURNS text
    LANGUAGE sql IMMUTABLE AS $f$
      SELECT CASE
        WHEN group_name ~* '\msize\M' THEN 'size'
        WHEN group_name ~* '\m(crust|dough)\M' THEN 'crust'
        WHEN group_name ~* 'topping' THEN 'topping'
        ELSE 'option' END
    $f$;
  -- The same rule as normalizePhone in src/lib/orders.ts.
  CREATE OR REPLACE FUNCTION pg_temp.normalize_phone(raw text) RETURNS text
    LANGUAGE sql IMMUTABLE AS $f$
      SELECT regexp_replace(regexp_replace(raw, '\D', '', 'g'), '^1(\d{10})$', '\1')
    $f$;

  -- ---------------------------------------------------------------------
  -- Enums
  -- ---------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'modifier_role') THEN
    CREATE TYPE modifier_role AS ENUM ('size', 'crust', 'sauce', 'cheese', 'topping', 'option');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'half_topping_rule') THEN
    CREATE TYPE half_topping_rule AS ENUM ('average', 'highest');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'pos_access') THEN
    CREATE TYPE pos_access AS ENUM ('none', 'cashier', 'manager');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tender_direction') THEN
    CREATE TYPE tender_direction AS ENUM ('payment', 'refund');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'tender_method') THEN
    CREATE TYPE tender_method AS ENUM ('cash', 'card_external', 'other', 'marketplace');
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'drawer_event_kind') THEN
    CREATE TYPE drawer_event_kind AS ENUM ('no_sale', 'paid_in', 'paid_out');
  END IF;
  ALTER TYPE order_type ADD VALUE IF NOT EXISTS 'dine_in';
  -- Placed where schema.ts lists them, so db:push sees the same enum.
  ALTER TYPE order_source ADD VALUE IF NOT EXISTS 'walk_in' BEFORE 'doordash';
  ALTER TYPE order_source ADD VALUE IF NOT EXISTS 'phone' BEFORE 'doordash';

  -- order_status: the admin "confirm" step is gone (confirmed → new) and
  -- `held` is new. Postgres cannot drop an enum value, so swap the type on
  -- every column that uses it.
  IF EXISTS (SELECT 1 FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
             WHERE t.typname = 'order_status' AND e.enumlabel = 'confirmed') THEN
    ALTER TABLE orders ALTER COLUMN status DROP DEFAULT;
    ALTER TYPE order_status RENAME TO order_status_old;
    CREATE TYPE order_status AS ENUM ('held', 'new', 'preparing', 'ready', 'completed', 'canceled');
    ALTER TABLE orders ALTER COLUMN status TYPE order_status
      USING (CASE status::text WHEN 'confirmed' THEN 'new' ELSE status::text END)::order_status;
    ALTER TABLE order_events ALTER COLUMN from_status TYPE order_status
      USING (CASE from_status::text WHEN 'confirmed' THEN 'new' ELSE from_status::text END)::order_status;
    ALTER TABLE order_events ALTER COLUMN to_status TYPE order_status
      USING (CASE to_status::text WHEN 'confirmed' THEN 'new' ELSE to_status::text END)::order_status;
    DROP TYPE order_status_old;
  END IF;
  ALTER TABLE orders ALTER COLUMN status SET DEFAULT 'held';

  -- ---------------------------------------------------------------------
  -- Settings, menu, staff
  -- ---------------------------------------------------------------------
  ALTER TABLE store_settings
    ADD COLUMN IF NOT EXISTS half_topping_rule half_topping_rule DEFAULT 'average' NOT NULL,
    ADD COLUMN IF NOT EXISTS extra_topping_bps integer DEFAULT 20000 NOT NULL,
    ADD COLUMN IF NOT EXISTS discount_approval_cents integer DEFAULT 500 NOT NULL,
    ADD COLUMN IF NOT EXISTS oven_capacity_pies integer DEFAULT 6 NOT NULL,
    ADD COLUMN IF NOT EXISTS make_minutes integer DEFAULT 3 NOT NULL,
    ADD COLUMN IF NOT EXISTS pos_lock_seconds integer DEFAULT 120 NOT NULL;

  -- Group roles replace the KDS's name regexes; existing groups get theirs
  -- from the same names, once. A database that already carries PR #17's
  -- `kind` (choice | size | toppings) keeps what it says: kind is a
  -- projection of role, so nothing is lost when it goes.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'modifier_groups' AND column_name = 'role') THEN
    ALTER TABLE modifier_groups ADD COLUMN role modifier_role DEFAULT 'option' NOT NULL;
    IF EXISTS (SELECT 1 FROM information_schema.columns
               WHERE table_name = 'modifier_groups' AND column_name = 'kind') THEN
      EXECUTE $kind$
        UPDATE modifier_groups SET role = (CASE kind::text
          WHEN 'size' THEN 'size'
          WHEN 'toppings' THEN 'topping'
          ELSE pg_temp.modifier_role_of(name) END)::modifier_role
      $kind$;
    ELSE
      UPDATE modifier_groups SET role = pg_temp.modifier_role_of(name)::modifier_role;
    END IF;
  END IF;
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'modifier_groups' AND column_name = 'kind') THEN
    ALTER TABLE modifier_groups DROP COLUMN kind;
  END IF;
  DROP TYPE IF EXISTS modifier_group_kind;

  -- POS access is a permission, not a job: managers and shift leads may
  -- approve at the till, cashiers may ring, everyone else keeps the clock only.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'employees' AND column_name = 'pos_access') THEN
    ALTER TABLE employees ADD COLUMN pos_access pos_access DEFAULT 'none' NOT NULL;
    UPDATE employees e SET pos_access = CASE
      WHEN EXISTS (SELECT 1 FROM employee_roles r WHERE r.employee_id = e.id AND r.role IN ('manager', 'shift_lead')) THEN 'manager'
      WHEN EXISTS (SELECT 1 FROM employee_roles r WHERE r.employee_id = e.id AND r.role = 'cashier') THEN 'cashier'
      ELSE 'none' END::pos_access;
  END IF;

  CREATE TABLE IF NOT EXISTS pin_attempts (
    "operator_id" integer PRIMARY KEY NOT NULL,
    "failures" integer DEFAULT 0 NOT NULL,
    "window_start" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "pin_attempts_operator_id_operators_id_fk"
      FOREIGN KEY ("operator_id") REFERENCES "public"."operators"("id") ON DELETE cascade ON UPDATE no action
  );

  -- ---------------------------------------------------------------------
  -- Customers, backfilled from every phone number already on an order
  -- ---------------------------------------------------------------------
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
      SELECT pg_temp.normalize_phone(customer_phone) AS phone,
             customer_name, customer_email, placed_at
      FROM orders
    ) p
    WHERE p.phone <> ''
    ORDER BY p.phone, p.placed_at DESC;
  END IF;
  CREATE TABLE IF NOT EXISTS customer_addresses (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "customer_id" uuid NOT NULL,
    "line1" text NOT NULL,
    "line2" text,
    "city" text,
    "zip" text NOT NULL,
    "last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "customer_addresses_customer_id_customers_id_fk"
      FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "customer_addresses_unique" ON "customer_addresses" USING btree ("customer_id", "line1", "zip");

  -- ---------------------------------------------------------------------
  -- Orders
  -- ---------------------------------------------------------------------
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'orders' AND column_name = 'customer_id') THEN
    ALTER TABLE orders ADD COLUMN customer_id uuid;
    ALTER TABLE orders ADD CONSTRAINT "orders_customer_id_customers_id_fk"
      FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;
    UPDATE orders o SET customer_id = c.id FROM customers c
    WHERE c.phone = pg_temp.normalize_phone(o.customer_phone);
  END IF;
  ALTER TABLE orders
    ADD COLUMN IF NOT EXISTS table_label text,
    ADD COLUMN IF NOT EXISTS created_by integer,
    ADD COLUMN IF NOT EXISTS fire_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS ticket_order_id uuid,
    ADD COLUMN IF NOT EXISTS paid_cents integer DEFAULT 0 NOT NULL,
    ADD COLUMN IF NOT EXISTS refunded_cents integer DEFAULT 0 NOT NULL;
  ALTER TABLE orders
    ALTER COLUMN subtotal_cents SET DEFAULT 0,
    ALTER COLUMN tax_cents SET DEFAULT 0,
    ALTER COLUMN total_cents SET DEFAULT 0;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'orders_created_by_employees_id_fk') THEN
    ALTER TABLE orders ADD CONSTRAINT "orders_created_by_employees_id_fk"
      FOREIGN KEY ("created_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  CREATE INDEX IF NOT EXISTS "orders_customer" ON "orders" USING btree ("customer_id");
  CREATE INDEX IF NOT EXISTS "orders_held_fire_at" ON "orders" USING btree ("fire_at") WHERE status = 'held';

  -- Tax rate snapshot. Each existing order gets the store's current rate when
  -- that rate reproduces its stored tax_cents (every order, unless the rate
  -- changed since it was placed); otherwise the rate its own tax implies,
  -- tax / taxable to the nearest basis point. Dividing alone would be wrong
  -- for most orders: tax was rounded to the cent, so 307 on 3724 reads back as
  -- 824 bps, not the 825 it was taxed at.
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                 WHERE table_name = 'orders' AND column_name = 'tax_rate_bps') THEN
    ALTER TABLE orders ADD COLUMN tax_rate_bps integer;
    UPDATE orders o SET tax_rate_bps = CASE
      WHEN round((o.subtotal_cents - o.discount_cents) * s.tax_rate_bps / 10000.0) = o.tax_cents
        THEN s.tax_rate_bps
      ELSE coalesce(round(o.tax_cents * 10000.0 / nullif(o.subtotal_cents - o.discount_cents, 0))::int, s.tax_rate_bps)
      END
    FROM store_settings s WHERE s.id = 1;
    -- No settings row means no order was ever taxed.
    UPDATE orders SET tax_rate_bps = 0 WHERE tax_rate_bps IS NULL;
    ALTER TABLE orders ALTER COLUMN tax_rate_bps SET NOT NULL;
  END IF;

  -- ---------------------------------------------------------------------
  -- Order lines
  -- ---------------------------------------------------------------------
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
  ALTER TABLE order_items
    ADD COLUMN IF NOT EXISTS voided_at timestamp with time zone,
    ADD COLUMN IF NOT EXISTS voided_by integer,
    ADD COLUMN IF NOT EXISTS void_reason text,
    ADD COLUMN IF NOT EXISTS void_approved_by integer;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_items_voided_by_employees_id_fk') THEN
    ALTER TABLE order_items ADD CONSTRAINT "order_items_voided_by_employees_id_fk"
      FOREIGN KEY ("voided_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
    ALTER TABLE order_items ADD CONSTRAINT "order_items_void_approved_by_employees_id_fk"
      FOREIGN KEY ("void_approved_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action;
  END IF;
  CREATE INDEX IF NOT EXISTS "order_items_order" ON "order_items" USING btree ("order_id");

  -- Snapshots written before `kind` existed come in two shapes: names only
  -- (the first menu), and PR #17's id + placement + portion. Each becomes a
  -- LineModifier: the id it carried, or the one its names match within the
  -- item's groups (null when unmatched); the role of that modifier's group,
  -- or the role its group name implies; and for placeable roles the
  -- placement and amount it carried, else whole/regular. priceDeltaCents
  -- stays: both shapes stored what the line was charged.
  UPDATE order_items i SET modifiers = (
    SELECT coalesce(jsonb_agg(
      CASE WHEN r.role IN ('sauce', 'cheese', 'topping') THEN
        jsonb_build_object('kind', 'placed', 'modifierId', r.mid, 'role', r.role,
          'groupName', r.m->>'groupName', 'modifierName', r.m->>'modifierName',
          'priceDeltaCents', (r.m->>'priceDeltaCents')::int,
          'placement', coalesce(r.m->>'placement', 'whole'),
          'amount', coalesce(r.m->>'portion', r.m->>'amount', 'regular'))
      ELSE
        jsonb_build_object('kind', 'option', 'modifierId', r.mid, 'role', r.role,
          'groupName', r.m->>'groupName', 'modifierName', r.m->>'modifierName',
          'priceDeltaCents', (r.m->>'priceDeltaCents')::int)
      END ORDER BY r.ord), '[]'::jsonb)
    FROM (
      SELECT q.m, q.ord, q.mid,
        coalesce((SELECT g.role::text FROM modifiers md JOIN modifier_groups g ON g.id = md.group_id WHERE md.id = q.mid),
                 pg_temp.modifier_role_of(q.m->>'groupName')) AS role
      FROM (
        SELECT e.m, e.ord,
          coalesce((e.m->>'modifierId')::int,
            (SELECT md.id FROM modifiers md
               JOIN modifier_groups g ON g.id = md.group_id
               JOIN item_modifier_groups img ON img.group_id = g.id
              WHERE img.item_id = i.menu_item_id
                AND g.name = e.m->>'groupName' AND md.name = e.m->>'modifierName'
              LIMIT 1)) AS mid
        FROM jsonb_array_elements(i.modifiers) WITH ORDINALITY AS e(m, ord)
      ) q
    ) r)
  WHERE EXISTS (SELECT 1 FROM jsonb_array_elements(i.modifiers) x WHERE NOT x ? 'kind');

  -- ---------------------------------------------------------------------
  -- Audit and discounts: POS actors
  -- ---------------------------------------------------------------------
  ALTER TABLE order_events
    ADD COLUMN IF NOT EXISTS employee_id integer,
    ADD COLUMN IF NOT EXISTS approved_by integer;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_events_employee_id_employees_id_fk') THEN
    ALTER TABLE order_events ADD CONSTRAINT "order_events_employee_id_employees_id_fk"
      FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE order_events ADD CONSTRAINT "order_events_approved_by_employees_id_fk"
      FOREIGN KEY ("approved_by") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
  END IF;
  ALTER TABLE order_discounts
    ADD COLUMN IF NOT EXISTS uid uuid,
    ADD COLUMN IF NOT EXISTS line_uid uuid,
    ADD COLUMN IF NOT EXISTS employee_id integer,
    ADD COLUMN IF NOT EXISTS approved_by integer;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'order_discounts_uid_unique') THEN
    ALTER TABLE order_discounts ADD CONSTRAINT "order_discounts_uid_unique" UNIQUE ("uid");
    ALTER TABLE order_discounts ADD CONSTRAINT "order_discounts_employee_id_employees_id_fk"
      FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
    ALTER TABLE order_discounts ADD CONSTRAINT "order_discounts_approved_by_employees_id_fk"
      FOREIGN KEY ("approved_by") REFERENCES "public"."employees"("id") ON DELETE set null ON UPDATE no action;
  END IF;

  -- ---------------------------------------------------------------------
  -- The money ledger: drawer sessions, tenders, drawer events
  -- ---------------------------------------------------------------------
  CREATE TABLE IF NOT EXISTS drawer_sessions (
    "id" uuid PRIMARY KEY NOT NULL,
    "opened_by" integer NOT NULL,
    "opened_at" timestamp with time zone DEFAULT now() NOT NULL,
    "starting_bank_cents" integer NOT NULL,
    "closed_by" integer,
    "closed_at" timestamp with time zone,
    "counted_cash_cents" integer,
    "card_batch_cents" integer,
    "declared_cash_tips_cents" integer,
    "notes" text,
    CONSTRAINT "drawer_sessions_opened_by_employees_id_fk"
      FOREIGN KEY ("opened_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action,
    CONSTRAINT "drawer_sessions_closed_by_employees_id_fk"
      FOREIGN KEY ("closed_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action
  );
  CREATE UNIQUE INDEX IF NOT EXISTS "drawer_sessions_one_open" ON "drawer_sessions" USING btree ((closed_at is null)) WHERE "drawer_sessions"."closed_at" is null;

  CREATE TABLE IF NOT EXISTS tenders (
    "id" uuid PRIMARY KEY NOT NULL,
    "order_id" uuid NOT NULL,
    "drawer_session_id" uuid,
    "direction" tender_direction NOT NULL,
    "method" tender_method NOT NULL,
    "amount_cents" integer NOT NULL,
    "tendered_cents" integer,
    "tip_cents" integer DEFAULT 0 NOT NULL,
    "last4" text,
    "employee_id" integer,
    "approved_by" integer,
    "reason" text,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "tenders_order_id_orders_id_fk"
      FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE no action ON UPDATE no action,
    CONSTRAINT "tenders_drawer_session_id_drawer_sessions_id_fk"
      FOREIGN KEY ("drawer_session_id") REFERENCES "public"."drawer_sessions"("id") ON DELETE no action ON UPDATE no action,
    CONSTRAINT "tenders_employee_id_employees_id_fk"
      FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action,
    CONSTRAINT "tenders_approved_by_employees_id_fk"
      FOREIGN KEY ("approved_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action
  );
  CREATE INDEX IF NOT EXISTS "tenders_order" ON "tenders" USING btree ("order_id");
  CREATE INDEX IF NOT EXISTS "tenders_drawer_session" ON "tenders" USING btree ("drawer_session_id");

  CREATE TABLE IF NOT EXISTS drawer_events (
    "id" uuid PRIMARY KEY NOT NULL,
    "drawer_session_id" uuid NOT NULL,
    "kind" drawer_event_kind NOT NULL,
    "cents" integer DEFAULT 0 NOT NULL,
    "reason" text,
    "employee_id" integer NOT NULL,
    "approved_by" integer,
    "created_at" timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT "drawer_events_drawer_session_id_drawer_sessions_id_fk"
      FOREIGN KEY ("drawer_session_id") REFERENCES "public"."drawer_sessions"("id") ON DELETE no action ON UPDATE no action,
    CONSTRAINT "drawer_events_employee_id_employees_id_fk"
      FOREIGN KEY ("employee_id") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action,
    CONSTRAINT "drawer_events_approved_by_employees_id_fk"
      FOREIGN KEY ("approved_by") REFERENCES "public"."employees"("id") ON DELETE no action ON UPDATE no action
  );

  -- payment_status → the ledger. An order recorded as paid becomes one
  -- payment tender for its total, dated by its payment_recorded event (or
  -- its last update), taken outside any drawer. A refunded order has no
  -- amount on record, so refuse rather than guess.
  IF EXISTS (SELECT 1 FROM information_schema.columns
             WHERE table_name = 'orders' AND column_name = 'payment_status') THEN
    EXECUTE 'SELECT count(*) FROM orders WHERE payment_status::text = ''refunded''' INTO refunded;
    IF refunded > 0 THEN
      RAISE EXCEPTION '% orders have payment_status refunded; record their refunds as tenders before migrating', refunded;
    END IF;
    EXECUTE $paid$
      INSERT INTO tenders (id, order_id, drawer_session_id, direction, method, amount_cents, tendered_cents, tip_cents, created_at)
      SELECT gen_random_uuid(), o.id, NULL, 'payment',
        (CASE o.payment_method::text WHEN 'card' THEN 'card_external' WHEN 'cash' THEN 'cash' ELSE 'other' END)::tender_method,
        o.total_cents, NULL, 0,
        coalesce((SELECT max(e.created_at) FROM order_events e WHERE e.order_id = o.id AND e.type = 'payment_recorded'), o.updated_at)
      FROM orders o
      WHERE o.payment_status::text = 'paid' AND o.total_cents > 0
        AND NOT EXISTS (SELECT 1 FROM tenders t WHERE t.order_id = o.id)
    $paid$;
    UPDATE orders o SET paid_cents = coalesce((SELECT sum(t.amount_cents) FROM tenders t WHERE t.order_id = o.id AND t.direction = 'payment'), 0);
    ALTER TABLE orders DROP COLUMN payment_status;
    ALTER TABLE orders DROP COLUMN payment_method;
  END IF;
  DROP TYPE IF EXISTS payment_status;
  DROP TYPE IF EXISTS payment_method;

  DROP FUNCTION pg_temp.modifier_role_of(text);
  DROP FUNCTION pg_temp.normalize_phone(text);
END
$migrate$;

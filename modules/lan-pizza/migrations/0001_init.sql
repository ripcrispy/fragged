CREATE TABLE IF NOT EXISTS mod_lan_pizza_rounds (
  id serial PRIMARY KEY,
  name varchar(120) NOT NULL,
  status varchar(12) NOT NULL DEFAULT 'draft',
  closes_at timestamptz,
  notes text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_pizza_menu (
  id serial PRIMARY KEY,
  name varchar(80) NOT NULL,
  description varchar(200) NOT NULL DEFAULT '',
  category varchar(16) NOT NULL DEFAULT 'pizza',
  price_cents integer NOT NULL CHECK (price_cents >= 0 AND price_cents <= 100000),
  vegetarian boolean NOT NULL DEFAULT false,
  vegan boolean NOT NULL DEFAULT false,
  enabled boolean NOT NULL DEFAULT true,
  display_order integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_pizza_orders (
  id serial PRIMARY KEY,
  round_id integer NOT NULL REFERENCES mod_lan_pizza_rounds(id) ON DELETE CASCADE,
  user_id integer NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  notes varchar(300) NOT NULL DEFAULT '',
  total_cents integer NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  paid_at timestamptz,
  paid_by integer,
  handed_out boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  -- one order per member per pizza run (they edit it instead of placing another)
  CONSTRAINT mod_lan_pizza_order_uq UNIQUE (round_id, user_id)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS mod_lan_pizza_items (
  id serial PRIMARY KEY,
  order_id integer NOT NULL REFERENCES mod_lan_pizza_orders(id) ON DELETE CASCADE,
  menu_id integer REFERENCES mod_lan_pizza_menu(id) ON DELETE SET NULL,
  name varchar(80) NOT NULL,
  price_cents integer NOT NULL,
  qty integer NOT NULL CHECK (qty > 0 AND qty <= 20)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS mod_lan_pizza_items_order_idx ON mod_lan_pizza_items (order_id);

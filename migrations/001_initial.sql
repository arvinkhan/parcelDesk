CREATE TABLE shops (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL
);

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id),
  name text NOT NULL,
  email text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL CHECK (role IN ('dispatcher', 'rider')),
  UNIQUE (shop_id, id)
);

CREATE TABLE shipments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shops(id),
  reference text NOT NULL,
  customer text NOT NULL,
  address text NOT NULL,
  description text NOT NULL,
  payment text NOT NULL CHECK (payment IN ('prepaid', 'cod')),
  cod_paise integer NOT NULL CHECK (cod_paise >= 0),
  status text NOT NULL DEFAULT 'ready' CHECK (status IN (
    'ready', 'assigned', 'out_for_delivery', 'failed', 'return_requested', 'returned', 'delivered'
  )),
  tracking_token uuid NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, reference),
  UNIQUE (shop_id, id),
  CHECK ((payment = 'prepaid' AND cod_paise = 0) OR (payment = 'cod' AND cod_paise > 0))
);
CREATE INDEX shipments_shop_created ON shipments (shop_id, created_at DESC, id DESC);

CREATE TABLE assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  rider_id uuid NOT NULL,
  assigned_at timestamptz NOT NULL DEFAULT now(),
  picked_up_at timestamptz,
  ended_at timestamptz,
  FOREIGN KEY (shop_id, shipment_id) REFERENCES shipments(shop_id, id),
  FOREIGN KEY (shop_id, rider_id) REFERENCES users(shop_id, id),
  UNIQUE (shop_id, shipment_id, id)
);
CREATE UNIQUE INDEX assignments_one_active ON assignments (shipment_id) WHERE ended_at IS NULL;
CREATE INDEX assignments_rider ON assignments (shop_id, rider_id, shipment_id);

CREATE TABLE delivery_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  assignment_id uuid NOT NULL,
  submission_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('delivered', 'failed')),
  reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, shipment_id, assignment_id) REFERENCES assignments(shop_id, shipment_id, id),
  UNIQUE (shipment_id, submission_id),
  CHECK ((outcome = 'failed') = (reason IS NOT NULL))
);

CREATE TABLE shipment_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  shop_id uuid NOT NULL,
  shipment_id uuid NOT NULL,
  actor_id uuid NOT NULL,
  status text NOT NULL,
  detail text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, shipment_id) REFERENCES shipments(shop_id, id),
  FOREIGN KEY (shop_id, actor_id) REFERENCES users(shop_id, id)
);
CREATE INDEX shipment_events_history ON shipment_events (shipment_id, id DESC);

CREATE TABLE settlements (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  rider_id uuid NOT NULL,
  recorded_by uuid NOT NULL,
  submission_id uuid NOT NULL,
  expected_paise integer NOT NULL CHECK (expected_paise > 0),
  received_paise integer NOT NULL CHECK (received_paise >= 0),
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, rider_id) REFERENCES users(shop_id, id),
  FOREIGN KEY (shop_id, recorded_by) REFERENCES users(shop_id, id),
  UNIQUE (shop_id, submission_id),
  UNIQUE (shop_id, rider_id, id),
  CHECK (expected_paise = received_paise OR NULLIF(btrim(note), '') IS NOT NULL)
);

CREATE TABLE cash_entries (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  shipment_id uuid NOT NULL UNIQUE,
  assignment_id uuid NOT NULL,
  rider_id uuid NOT NULL,
  amount_paise integer NOT NULL CHECK (amount_paise > 0),
  settlement_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, shipment_id, assignment_id) REFERENCES assignments(shop_id, shipment_id, id),
  FOREIGN KEY (shop_id, rider_id) REFERENCES users(shop_id, id),
  FOREIGN KEY (shop_id, rider_id, settlement_id) REFERENCES settlements(shop_id, rider_id, id)
);
CREATE INDEX cash_entries_open ON cash_entries (shop_id, rider_id) WHERE settlement_id IS NULL;

CREATE TABLE user_sessions (
  sid varchar PRIMARY KEY,
  sess json NOT NULL,
  expire timestamp(6) NOT NULL
);
CREATE INDEX user_sessions_expire ON user_sessions(expire);

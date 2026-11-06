-- PeopleHub Pricing & Proposal database
-- Run this once against an empty database (for example "peoplehub_pricing") in pgAdmin's Query Tool.

CREATE TABLE IF NOT EXISTS partner_categories (
  id              SERIAL PRIMARY KEY,
  name            VARCHAR(80)  NOT NULL UNIQUE,
  partner_type    VARCHAR(20)  NOT NULL CHECK (partner_type IN ('reseller', 'agent')),
  max_discount_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (max_discount_pct >= 0 AND max_discount_pct <= 100),
  sort_order      INT          NOT NULL DEFAULT 0,
  active          BOOLEAN      NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS partners (
  id            SERIAL PRIMARY KEY,
  company_name  VARCHAR(160) NOT NULL,
  contact_name  VARCHAR(120),
  email         VARCHAR(160),
  phone         VARCHAR(40),
  category_id   INT NOT NULL REFERENCES partner_categories(id),
  active        BOOLEAN NOT NULL DEFAULT TRUE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS app_users (
  id             SERIAL PRIMARY KEY,
  username       VARCHAR(80)  NOT NULL UNIQUE,
  password_hash  TEXT         NOT NULL,
  role           VARCHAR(20)  NOT NULL CHECK (role IN ('admin', 'staff', 'partner')),
  partner_id     INT REFERENCES partners(id),
  active         BOOLEAN      NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ  NOT NULL DEFAULT now(),
  CONSTRAINT partner_user_has_partner CHECK ((role = 'partner') = (partner_id IS NOT NULL))
);

-- The whole base price list is stored as one versioned JSON document, so a proposal can always point at
-- the exact prices it was quoted with, even after the list is edited later.
CREATE TABLE IF NOT EXISTS price_lists (
  id          SERIAL PRIMARY KEY,
  data        JSONB       NOT NULL,
  is_current  BOOLEAN     NOT NULL DEFAULT FALSE,
  created_by  INT REFERENCES app_users(id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS one_current_price_list ON price_lists (is_current) WHERE is_current;

CREATE TABLE IF NOT EXISTS proposals (
  id              SERIAL PRIMARY KEY,
  ref_no          VARCHAR(40) NOT NULL UNIQUE,
  created_by      INT NOT NULL REFERENCES app_users(id),
  partner_id      INT REFERENCES partners(id),
  price_list_id   INT NOT NULL REFERENCES price_lists(id),
  client          JSONB NOT NULL,
  selections      JSONB NOT NULL,
  customisations  JSONB NOT NULL DEFAULT '[]',
  discount_pct    NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (discount_pct >= 0 AND discount_pct <= 100),
  totals          JSONB NOT NULL,
  status          VARCHAR(20) NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'sent', 'accepted', 'lost')),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposals_partner_idx ON proposals (partner_id);
CREATE INDEX IF NOT EXISTS proposals_created_by_idx ON proposals (created_by);

-- Starter categories (placeholders: adjust the max discount in the admin screen later)
INSERT INTO partner_categories (name, partner_type, max_discount_pct, sort_order) VALUES
  ('Platinum Reseller', 'reseller', 25, 1),
  ('Gold Reseller',     'reseller', 20, 2),
  ('Silver Reseller',   'reseller', 15, 3),
  ('Certified Agent',   'agent',    10, 4),
  ('Referral Agent',    'agent',     5, 5)
ON CONFLICT (name) DO NOTHING;

-- ---------------------------------------------------------------------------------------------
-- Customers (added after the first release; safe to run again)
-- ---------------------------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS customers (
  id             SERIAL PRIMARY KEY,
  name           VARCHAR(160) NOT NULL,
  industry       VARCHAR(120),
  address        VARCHAR(300),
  sites          VARCHAR(120),
  current_system VARCHAR(160),
  website        VARCHAR(160),
  notes          TEXT,
  partner_id     INT REFERENCES partners(id),       -- set when the customer belongs to a dealer/agent; NULL = Victory's own customer
  created_by     INT NOT NULL REFERENCES app_users(id),
  active         BOOLEAN NOT NULL DEFAULT TRUE,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_partner_idx ON customers (partner_id);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers (lower(name));

CREATE TABLE IF NOT EXISTS customer_contacts (
  id           SERIAL PRIMARY KEY,
  customer_id  INT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name         VARCHAR(120) NOT NULL,
  title        VARCHAR(120),
  email        VARCHAR(160),
  phone        VARCHAR(40),
  role         VARCHAR(40),                          -- e.g. sponsor, hr, finance, it
  is_primary   BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS contacts_customer_idx ON customer_contacts (customer_id);
CREATE UNIQUE INDEX IF NOT EXISTS one_primary_contact ON customer_contacts (customer_id) WHERE is_primary;

ALTER TABLE proposals ADD COLUMN IF NOT EXISTS customer_id INT REFERENCES customers(id);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS contact_id  INT REFERENCES customer_contacts(id) ON DELETE SET NULL;

-- Proposal reference numbers restart each year: VI-PH-<year>-0001
CREATE TABLE IF NOT EXISTS proposal_counters (
  year  INT PRIMARY KEY,
  last  INT NOT NULL DEFAULT 0
);

-- Every proposal email attempt, successful or not
CREATE TABLE IF NOT EXISTS email_log (
  id           SERIAL PRIMARY KEY,
  proposal_id  INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  sent_by      INT NOT NULL REFERENCES app_users(id),
  to_email     VARCHAR(200) NOT NULL,
  subject      VARCHAR(300) NOT NULL,
  ok           BOOLEAN NOT NULL,
  error        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS email_log_user_idx ON email_log (sent_by, created_at);

-- ---- Phase 1: profiles, password reset, price list versions ----
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS email VARCHAR(160);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS display_name VARCHAR(120);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS phone VARCHAR(40);
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS must_change_password BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS password_changed_at TIMESTAMPTZ;
CREATE UNIQUE INDEX IF NOT EXISTS app_users_email_idx ON app_users (lower(email)) WHERE email IS NOT NULL;

-- Single-use reset links: only a hash of the token is stored
CREATE TABLE IF NOT EXISTS password_resets (
  id          SERIAL PRIMARY KEY,
  user_id     INT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash  CHAR(64) NOT NULL UNIQUE,
  expires_at  TIMESTAMPTZ NOT NULL,
  used_at     TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE price_lists ADD COLUMN IF NOT EXISTS label VARCHAR(120);

-- ---- Phase 1b: partner team users, proposal pipeline, revisions, event history ----
-- Existing partner logins are the owners of their company; users they add are members.
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS partner_role VARCHAR(10) NOT NULL DEFAULT 'owner';
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS created_by_user INT REFERENCES app_users(id);
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'app_users_partner_role_check') THEN
    ALTER TABLE app_users ADD CONSTRAINT app_users_partner_role_check CHECK (partner_role IN ('owner', 'member'));
  END IF;
END $$;
ALTER TABLE partners ADD COLUMN IF NOT EXISTS max_users INT NOT NULL DEFAULT 10;

-- More pipeline stages; "superseded" marks a version replaced by a newer revision
ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_status_check;
ALTER TABLE proposals ADD CONSTRAINT proposals_status_check
  CHECK (status IN ('draft', 'sent', 'viewed', 'negotiating', 'accepted', 'lost', 'superseded'));
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS lost_reason VARCHAR(300);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ NOT NULL DEFAULT now();
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS parent_id INT REFERENCES proposals(id);
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS version INT NOT NULL DEFAULT 1;
CREATE INDEX IF NOT EXISTS proposals_parent_idx ON proposals (parent_id);

-- Everything that happens to a proposal, oldest first: the timeline and the base for analytics
CREATE TABLE IF NOT EXISTS proposal_events (
  id           SERIAL PRIMARY KEY,
  proposal_id  INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  type         VARCHAR(30) NOT NULL,
  from_status  VARCHAR(20),
  to_status    VARCHAR(20),
  note         VARCHAR(300),
  user_id      INT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposal_events_idx ON proposal_events (proposal_id, created_at);

-- ---- Phase 2: client web view, tracking, analytics ----
-- One private link per proposal version. The token is the only secret needed to open the web view.
CREATE TABLE IF NOT EXISTS proposal_links (
  id           SERIAL PRIMARY KEY,
  proposal_id  INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  token        CHAR(64) NOT NULL UNIQUE,
  created_by   INT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at   TIMESTAMPTZ NOT NULL,
  revoked_at   TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS proposal_links_proposal_idx ON proposal_links (proposal_id);

-- What the client did on the web view. IP addresses are stored only as a short one-way hash.
CREATE TABLE IF NOT EXISTS proposal_views (
  id           BIGSERIAL PRIMARY KEY,
  proposal_id  INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  link_id      INT REFERENCES proposal_links(id) ON DELETE CASCADE,
  sid          VARCHAR(40) NOT NULL,
  type         VARCHAR(12) NOT NULL CHECK (type IN ('open', 'engaged', 'heartbeat', 'section', 'pdf', 'cta')),
  section      VARCHAR(20),
  ms           INT,
  note         VARCHAR(500),
  device       VARCHAR(10),
  ua           VARCHAR(300),
  ip_hash      CHAR(16),
  is_bot       BOOLEAN NOT NULL DEFAULT FALSE,
  internal     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS proposal_views_idx ON proposal_views (proposal_id, created_at);

-- ---- Phase 3: CRM - leads, follow-ups, activity timeline ----
-- A lead is a prospect before it becomes a customer. A partner who registers one holds it for 90 days
-- (renewed by activity), so two partners cannot work the same company.
CREATE TABLE IF NOT EXISTS leads (
  id             SERIAL PRIMARY KEY,
  partner_id     INT REFERENCES partners(id),                -- NULL = Victory's own lead
  owner_id       INT NOT NULL REFERENCES app_users(id),
  created_by     INT NOT NULL REFERENCES app_users(id),
  company_name   VARCHAR(160) NOT NULL,
  name_key       VARCHAR(160) NOT NULL,                      -- lower-case letters and digits only, for duplicate matching
  contact_name   VARCHAR(120),
  contact_title  VARCHAR(120),
  email          VARCHAR(160),
  email_domain   VARCHAR(120),
  phone          VARCHAR(40),
  phone_key      VARCHAR(12),                                -- last 9 digits
  industry       VARCHAR(120),
  source         VARCHAR(40),
  employees      INT,
  est_value      NUMERIC(12,2),                              -- expected monthly value, entered by the seller
  stage          VARCHAR(12) NOT NULL DEFAULT 'new' CHECK (stage IN ('new', 'contacted', 'qualified', 'proposal', 'won', 'lost')),
  lost_reason    VARCHAR(300),
  notes          TEXT,
  customer_id    INT REFERENCES customers(id),
  lock_until     TIMESTAMPTZ NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  stage_changed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS leads_partner_idx ON leads (partner_id);
CREATE INDEX IF NOT EXISTS leads_owner_idx ON leads (owner_id);
CREATE INDEX IF NOT EXISTS leads_namekey_idx ON leads (name_key);
CREATE INDEX IF NOT EXISTS leads_domain_idx ON leads (email_domain);
CREATE INDEX IF NOT EXISTS leads_phone_idx ON leads (phone_key);

-- Calls, meetings, emails and notes logged against a lead or customer
CREATE TABLE IF NOT EXISTS crm_activities (
  id           SERIAL PRIMARY KEY,
  lead_id      INT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id  INT REFERENCES customers(id) ON DELETE CASCADE,
  type         VARCHAR(12) NOT NULL CHECK (type IN ('call', 'meeting', 'email', 'whatsapp', 'note', 'stage')),
  note         VARCHAR(1000),
  user_id      INT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS crm_activities_lead_idx ON crm_activities (lead_id, created_at);
CREATE INDEX IF NOT EXISTS crm_activities_customer_idx ON crm_activities (customer_id, created_at);

-- Follow-ups: things somebody must do by a date
CREATE TABLE IF NOT EXISTS tasks (
  id           SERIAL PRIMARY KEY,
  lead_id      INT REFERENCES leads(id) ON DELETE CASCADE,
  customer_id  INT REFERENCES customers(id) ON DELETE CASCADE,
  proposal_id  INT REFERENCES proposals(id) ON DELETE CASCADE,
  partner_id   INT REFERENCES partners(id),
  assigned_to  INT NOT NULL REFERENCES app_users(id),
  created_by   INT NOT NULL REFERENCES app_users(id),
  type         VARCHAR(12) NOT NULL DEFAULT 'follow_up' CHECK (type IN ('call', 'email', 'meeting', 'whatsapp', 'follow_up', 'other')),
  title        VARCHAR(200) NOT NULL,
  due_date     DATE NOT NULL,
  done_at      TIMESTAMPTZ,
  done_by      INT REFERENCES app_users(id) ON DELETE SET NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks (assigned_to, done_at, due_date);
CREATE INDEX IF NOT EXISTS tasks_lead_idx ON tasks (lead_id);

-- One reminder email per person per day
CREATE TABLE IF NOT EXISTS digest_log (
  user_id  INT NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  day      DATE NOT NULL,
  PRIMARY KEY (user_id, day)
);

-- ---- Phase 4: presentations launcher, partner rating, tier suggestions ----
CREATE TABLE IF NOT EXISTS presentation_decks (
  id               VARCHAR(30) PRIMARY KEY,                  -- matches the deck id inside the Presentation project
  name             VARCHAR(120) NOT NULL,
  tagline          VARCHAR(400),
  best_for         VARCHAR(200),
  partner_visible  BOOLEAN NOT NULL DEFAULT FALSE,           -- may partners launch it?
  active           BOOLEAN NOT NULL DEFAULT TRUE,
  sort_order       INT NOT NULL DEFAULT 0
);
INSERT INTO presentation_decks (id, name, tagline, best_for, partner_visible, sort_order) VALUES
  ('workshop', 'Outcome Workshop', 'Co-design session: the client picks the outcomes that matter, then sees their own PeopleHub built live.', 'Owners, HR, finance, payroll and IT together: discovery and first meetings', TRUE, 1),
  ('tour', 'Platform Tour', 'A guided walk through every PeopleHub module, with animated screens, IT deep-dive, packages and value.', 'Follow-up demos and clients who want to see the full product', TRUE, 2),
  ('fresh', 'Fresh Harvest', 'The full Outcome Workshop without the navigation screens, blueprint and a few closing slides.', 'The Fresh Harvest visit', FALSE, 3),
  ('frcs', 'FRCS · Fiji', 'Presented by Newworld Technologies for the Fiji Revenue and Customs Service.', 'The FRCS HRIS presentation', FALSE, 4),
  ('nwfrca', 'Newworld · FRCS pitch', 'The Newworld pitch for FRCS: why Newworld, the partnership, then the PeopleHub overview.', 'The Newworld pitch meeting', FALSE, 5)
ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS presentation_launches (
  id          SERIAL PRIMARY KEY,
  user_id     INT REFERENCES app_users(id) ON DELETE SET NULL,
  partner_id  INT REFERENCES partners(id),
  deck_id     VARCHAR(30) NOT NULL,
  client      VARCHAR(160),
  lead_id     INT REFERENCES leads(id) ON DELETE SET NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS presentation_launches_idx ON presentation_launches (partner_id, created_at);

-- Rating: tuning knobs live in the database so an admin can change them without a deployment
CREATE TABLE IF NOT EXISTS rating_settings (
  id    INT PRIMARY KEY CHECK (id = 1),
  data  JSONB NOT NULL
);
INSERT INTO rating_settings (id, data) VALUES (1, '{"revenueTarget": 3000, "winsTarget": 4, "minDecided": 3, "pipelineTarget": 12, "presentationsTarget": 4, "activitiesTarget": 20}') ON CONFLICT (id) DO NOTHING;

CREATE TABLE IF NOT EXISTS rating_snapshots (
  partner_id  INT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  day         DATE NOT NULL,
  score       NUMERIC(5,1) NOT NULL,
  PRIMARY KEY (partner_id, day)
);

-- The score a partner needs to be suggested for a category, within its own type (reseller / agent)
ALTER TABLE partner_categories ADD COLUMN IF NOT EXISTS min_score INT NOT NULL DEFAULT 0;
UPDATE partner_categories SET min_score = 40 WHERE name = 'Certified Agent' AND min_score = 0;
UPDATE partner_categories SET min_score = 55 WHERE name = 'Gold Reseller' AND min_score = 0;
UPDATE partner_categories SET min_score = 75 WHERE name = 'Platinum Reseller' AND min_score = 0;

CREATE TABLE IF NOT EXISTS tier_suggestions (
  id               SERIAL PRIMARY KEY,
  partner_id       INT NOT NULL REFERENCES partners(id) ON DELETE CASCADE,
  from_category_id INT NOT NULL REFERENCES partner_categories(id),
  to_category_id   INT NOT NULL REFERENCES partner_categories(id),
  kind             VARCHAR(8) NOT NULL CHECK (kind IN ('upgrade', 'review')),
  score            NUMERIC(5,1) NOT NULL,
  status           VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'dismissed')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  decided_by       INT REFERENCES app_users(id) ON DELETE SET NULL,
  decided_at       TIMESTAMPTZ
);
CREATE UNIQUE INDEX IF NOT EXISTS tier_suggestions_pending_idx ON tier_suggestions (partner_id) WHERE status = 'pending';

-- ---- Phase 5: online acceptance, discount approvals, commissions, audit log, co-branding ----

-- The client's acceptance on the web view. proposal_hash fingerprints exactly what was accepted.
CREATE TABLE IF NOT EXISTS proposal_acceptances (
  id             SERIAL PRIMARY KEY,
  proposal_id    INT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
  link_id        INT REFERENCES proposal_links(id) ON DELETE SET NULL,
  signer_name    VARCHAR(120) NOT NULL,
  signer_title   VARCHAR(120),
  proposal_hash  CHAR(64) NOT NULL,
  ip_hash        CHAR(16),
  ua             VARCHAR(300),
  accepted_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- A partner asking for more discount than their category allows, on one proposal
CREATE TABLE IF NOT EXISTS discount_requests (
  id            SERIAL PRIMARY KEY,
  proposal_id   INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  requested_by  INT NOT NULL REFERENCES app_users(id),
  requested_pct NUMERIC(5,2) NOT NULL CHECK (requested_pct > 0 AND requested_pct <= 100),
  reason        VARCHAR(500) NOT NULL,
  status        VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'declined')),
  approved_pct  NUMERIC(5,2),
  decision_note VARCHAR(300),
  decided_by    INT REFERENCES app_users(id) ON DELETE SET NULL,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS discount_requests_proposal_idx ON discount_requests (proposal_id);
CREATE UNIQUE INDEX IF NOT EXISTS discount_requests_one_pending ON discount_requests (proposal_id) WHERE status = 'pending';

-- Commission on won deals, set per partner category. The seeded percentages are placeholders for the admin to review.
ALTER TABLE partner_categories ADD COLUMN IF NOT EXISTS commission_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (commission_pct >= 0 AND commission_pct <= 100);
UPDATE partner_categories SET commission_pct = 8 WHERE name = 'Certified Agent' AND commission_pct = 0;
UPDATE partner_categories SET commission_pct = 5 WHERE name = 'Referral Agent' AND commission_pct = 0;

CREATE TABLE IF NOT EXISTS commissions (
  id           SERIAL PRIMARY KEY,
  proposal_id  INT NOT NULL UNIQUE REFERENCES proposals(id) ON DELETE CASCADE,
  partner_id   INT NOT NULL REFERENCES partners(id),
  base_amount  NUMERIC(14,2) NOT NULL,           -- first-year value of the accepted proposal
  pct          NUMERIC(5,2) NOT NULL,
  amount       NUMERIC(14,2) NOT NULL,
  status       VARCHAR(10) NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'paid', 'void')),
  note         VARCHAR(300),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  paid_at      TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS commissions_partner_idx ON commissions (partner_id, status);

-- Who changed what
CREATE TABLE IF NOT EXISTS audit_log (
  id          BIGSERIAL PRIMARY KEY,
  user_id     INT REFERENCES app_users(id) ON DELETE SET NULL,
  username    VARCHAR(80),
  action      VARCHAR(60) NOT NULL,
  entity      VARCHAR(40),
  entity_id   INT,
  detail      VARCHAR(500),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_idx ON audit_log (created_at DESC);

-- Co-branded proposals: the partner's logo (a small image, stored as a data URL)
ALTER TABLE partners ADD COLUMN IF NOT EXISTS logo TEXT;

-- ---- Proposal text library and the proposal style ----
-- A replacement for a default section: partner_id NULL = Victory's version for everyone, otherwise that partner's own.
CREATE TABLE IF NOT EXISTS section_overrides (
  id          SERIAL PRIMARY KEY,
  partner_id  INT REFERENCES partners(id) ON DELETE CASCADE,
  key         VARCHAR(30) NOT NULL,
  title       VARCHAR(120),
  body        TEXT NOT NULL,
  updated_by  INT REFERENCES app_users(id) ON DELETE SET NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS section_overrides_uq ON section_overrides (coalesce(partner_id, 0), key);

-- The wording and structure a proposal was saved with, so a sent proposal never changes when the library is edited
ALTER TABLE proposals ADD COLUMN IF NOT EXISTS doc JSONB;

-- ---- Resend / delivery status ----
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS role VARCHAR(4) NOT NULL DEFAULT 'to';
ALTER TABLE email_log ADD COLUMN IF NOT EXISTS resend BOOLEAN NOT NULL DEFAULT FALSE;

-- ---- Images used inside proposal wording ----
CREATE TABLE IF NOT EXISTS proposal_images (
  id          VARCHAR(24) PRIMARY KEY,
  partner_id  INT REFERENCES partners(id),
  uploaded_by INT NOT NULL REFERENCES app_users(id),
  name        VARCHAR(120) NOT NULL,
  mime        VARCHAR(20) NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Proposal templates ----
CREATE TABLE IF NOT EXISTS proposal_templates (
  id          SERIAL PRIMARY KEY,
  partner_id  INT REFERENCES partners(id),      -- NULL = shared by Victory with everyone
  created_by  INT NOT NULL REFERENCES app_users(id),
  name        VARCHAR(80) NOT NULL,
  note        VARCHAR(300),
  input       JSONB NOT NULL,
  validity    INT NOT NULL DEFAULT 30,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- Extra files attached to a proposal email ----
CREATE TABLE IF NOT EXISTS email_attachments (
  id          SERIAL PRIMARY KEY,
  proposal_id INT NOT NULL REFERENCES proposals(id) ON DELETE CASCADE,
  uploaded_by INT NOT NULL REFERENCES app_users(id),
  name        VARCHAR(100) NOT NULL,
  mime        VARCHAR(100) NOT NULL,
  size        INT NOT NULL,
  data        BYTEA NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ---- One tracked link per recipient, so opens and downloads can be attributed ----
ALTER TABLE proposal_links ADD COLUMN IF NOT EXISTS recipient VARCHAR(200);

-- ---- Alerts: who gets an email or an SMS when a client opens, accepts or asks for a call ----
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS alert_email BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS alert_sms BOOLEAN NOT NULL DEFAULT FALSE;

-- ---- WhatsApp and phone push alerts ----
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS alert_whatsapp BOOLEAN NOT NULL DEFAULT FALSE;

-- ---- Phone push alerts (ntfy) ----
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS alert_push BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE app_users ADD COLUMN IF NOT EXISTS ntfy_topic VARCHAR(40);

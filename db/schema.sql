-- Photo-app schema (PostgreSQL / Neon).
-- Idempotent: re-running this file is safe; CREATE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS.
-- For a clean rebuild (drop everything + recreate) in one shot:
--   psql "$DATABASE_URL" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;" -f API/db/schema.sql

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ----------------------------------------------------------------------------
-- Users (Cognito-backed). Both photographers and clients live here.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  cognito_sub   TEXT UNIQUE NOT NULL,
  email         TEXT UNIQUE NOT NULL,
  name          TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('photographer','client')),
  avatar_url    TEXT,
  phone         TEXT,
  studio_name   TEXT,
  bio           TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ----------------------------------------------------------------------------
-- Portfolios. The unit the photographer creates and shares with clients.
-- A portfolio is `draft` until the photographer publishes it; once published,
-- the watermark Lambda processes its photos and the linked clients can see it.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolios (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  photographer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title           TEXT NOT NULL,
  description     TEXT,
  cover_url       TEXT,
  status          TEXT NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft','published')),
  published_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_portfolios_photographer ON portfolios (photographer_id);

-- Forward-compat: add columns if upgrading from an older schema that lacked them.
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS status TEXT NOT NULL DEFAULT 'draft'
  CHECK (status IN ('draft','published'));
ALTER TABLE portfolios ADD COLUMN IF NOT EXISTS published_at TIMESTAMPTZ;

-- ----------------------------------------------------------------------------
-- Photographer ↔ client list (many-to-many). Allows the photographer to keep
-- a client roster independent of any portfolio. Clients added here can later
-- be picked when creating or editing a portfolio.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photographer_clients (
  photographer_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (photographer_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_photographer_clients_client
  ON photographer_clients (client_id);

-- ----------------------------------------------------------------------------
-- Portfolio ↔ clients (many-to-many). A portfolio can have 0..N clients.
-- The client only sees the portfolio when (status='published' AND row exists here).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS portfolio_clients (
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  client_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (portfolio_id, client_id)
);
CREATE INDEX IF NOT EXISTS idx_portfolio_clients_client
  ON portfolio_clients (client_id);

-- ----------------------------------------------------------------------------
-- Photos. Each photo lives inside a portfolio. Lifecycle:
--   uploaded   - original in S3 originals/. Photographer-only visibility.
--   processing - publish triggered watermark; SQS message in flight.
--   ready      - watermark Lambda finished; client can see watermarked + thumb.
--   failed     - watermark Lambda gave up after retries; check DLQ + CloudWatch.
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS photos (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  portfolio_id    UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  original_key    TEXT NOT NULL,
  watermarked_url TEXT,
  thumbnail_url   TEXT,
  status          TEXT NOT NULL DEFAULT 'uploaded'
                  CHECK (status IN ('uploaded','processing','ready','failed')),
  uploaded_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_photos_portfolio ON photos (portfolio_id);

-- Forward-compat for old installs that had photos.session_id NOT NULL.
ALTER TABLE photos ADD COLUMN IF NOT EXISTS portfolio_id UUID REFERENCES portfolios(id) ON DELETE CASCADE;

-- ----------------------------------------------------------------------------
-- Cart & purchases keyed by portfolio (the unit a photo belongs to).
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS cart_items (
  client_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  photo_id     UUID NOT NULL REFERENCES photos(id) ON DELETE CASCADE,
  portfolio_id UUID NOT NULL REFERENCES portfolios(id) ON DELETE CASCADE,
  unit_price   NUMERIC(10,2) NOT NULL,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, photo_id)
);

CREATE TABLE IF NOT EXISTS purchases (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  client_id                UUID NOT NULL REFERENCES users(id),
  portfolio_id             UUID NOT NULL REFERENCES portfolios(id),
  photo_ids                UUID[] NOT NULL,
  total                    NUMERIC(10,2) NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','paid','failed')),
  stripe_payment_intent_id TEXT,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_purchases_client ON purchases (client_id);
CREATE INDEX IF NOT EXISTS idx_purchases_portfolio ON purchases (portfolio_id);

-- Neon (Postgres) schema. Neon is the system of record: every call is written here first,
-- then email, HubSpot, Cal.com and the confirmation call are driven from the outbox table.

CREATE TABLE IF NOT EXISTS calls (
  id                 BIGSERIAL PRIMARY KEY,
  external_call_id   TEXT UNIQUE NOT NULL,        -- id assigned by the voice platform
  caller_phone       TEXT,
  started_at         TIMESTAMPTZ,
  answered_at        TIMESTAMPTZ,                 -- answer time = response time on the dashboard
  ended_at           TIMESTAMPTZ,
  duration_s         INTEGER,
  transcript         TEXT,
  route              TEXT,                        -- QUALIFY | CLARIFY | DECLINE | ESCALATE | LOG_ONLY
  reason_codes       TEXT[] DEFAULT '{}',         -- why: real_project, service_area, timeline, budget, decision_maker
  decision           JSONB,                       -- last full Gemini decision (criteria + evidence + extracted facts)
  clarify_count      INTEGER NOT NULL DEFAULT 0,
  handoff_note       TEXT,
  finalized_at       TIMESTAMPTZ,                 -- set once the end-of-call job has run (idempotency guard)
  hubspot_contact_id TEXT,
  hubspot_deal_id    TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS calls_phone_idx ON calls (caller_phone, created_at DESC);

CREATE TABLE IF NOT EXISTS handoffs (
  id                  BIGSERIAL PRIMARY KEY,
  call_id             BIGINT NOT NULL REFERENCES calls(id),
  email_message_id    TEXT,                       -- Resend email id
  claimed_by          TEXT,
  claimed_at          TIMESTAMPTZ,
  outcome             TEXT CHECK (outcome IN ('won','lost')),
  outcome_at          TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS bookings (
  id                BIGSERIAL PRIMARY KEY,
  call_id           BIGINT NOT NULL REFERENCES calls(id),
  calcom_uid        TEXT UNIQUE,
  calcom_booking_id BIGINT,
  event_type_id     BIGINT,
  visit_type        TEXT,                         -- site_visit | phone
  start_at          TIMESTAMPTZ,
  status            TEXT,                         -- as reported by Cal.com
  confirm_attempts  INTEGER NOT NULL DEFAULT 0,
  confirmed_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- One row per billable unit per call, so the dashboard can show cost per call and per booking.
CREATE TABLE IF NOT EXISTS costs (
  id        BIGSERIAL PRIMARY KEY,
  call_id   BIGINT NOT NULL REFERENCES calls(id),
  provider  TEXT NOT NULL,                        -- gemini | voice | other
  unit_type TEXT NOT NULL,                        -- input_tokens | output_tokens | call_seconds
  units     NUMERIC NOT NULL,
  amount_inr NUMERIC,                             -- null when no rate is configured (never guessed)
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Outbox: written in the same transaction as the call, drained by the worker. Nothing is lost if a vendor is down.
CREATE TABLE IF NOT EXISTS outbox (
  id         BIGSERIAL PRIMARY KEY,
  kind       TEXT NOT NULL,                       -- email_handoff | email_escalation | email_task | hubspot_sync | schedule | outbound_confirm
  payload    JSONB NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  run_after  TIMESTAMPTZ NOT NULL DEFAULT now(),
  done_at    TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS outbox_pending_idx ON outbox (run_after) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS sync_log (
  id        BIGSERIAL PRIMARY KEY,
  call_id   BIGINT REFERENCES calls(id),
  target    TEXT NOT NULL,                        -- hubspot | email | calcom
  ok        BOOLEAN NOT NULL,
  detail    TEXT,
  at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Upgrade for databases created before email replaced Telegram. Safe to run repeatedly.
ALTER TABLE handoffs ADD COLUMN IF NOT EXISTS email_message_id TEXT;
ALTER TABLE handoffs DROP COLUMN IF EXISTS telegram_chat_id;
ALTER TABLE handoffs DROP COLUMN IF EXISTS telegram_message_id;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS confirm_call_id TEXT;   -- Vaani call id of the confirmation call
CREATE INDEX IF NOT EXISTS bookings_confirm_call_idx ON bookings (confirm_call_id);

-- Hardening (idempotent).
ALTER TABLE outbox ADD COLUMN IF NOT EXISTS dead_at TIMESTAMPTZ;                  -- set after the final failed attempt
CREATE UNIQUE INDEX IF NOT EXISTS handoffs_call_unique ON handoffs (call_id);       -- one handoff per call, even across retries
CREATE UNIQUE INDEX IF NOT EXISTS bookings_call_unique ON bookings (call_id);       -- one booking per call: reserved before Cal.com is called
CREATE TABLE IF NOT EXISTS confirm_calls (
  vaani_call_id TEXT PRIMARY KEY,
  booking_id    BIGINT NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

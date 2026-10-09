// Neon is standard Postgres. Use the connection string from the Neon console (it includes sslmode=require).
import pg from 'pg';
import { need, settings } from './config.js';

let pool;
export function db() {
  pool ??= new pg.Pool({ connectionString: need('DATABASE_URL'), max: 5 });
  return pool;
}
const q = (text, params) => db().query(text, params);

export async function upsertCall(c) {
  const { rows } = await q(
    `INSERT INTO calls (external_call_id, caller_phone, started_at, answered_at)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (external_call_id) DO UPDATE
       SET caller_phone = COALESCE(calls.caller_phone, EXCLUDED.caller_phone),
           started_at   = COALESCE(calls.started_at, EXCLUDED.started_at),
           answered_at  = COALESCE(calls.answered_at, EXCLUDED.answered_at)
     RETURNING *`,
    [c.externalCallId, c.callerPhone ?? null, c.startedAt ?? null, c.answeredAt ?? null]
  );
  return rows[0];
}

export async function getCall(id) {
  return (await q('SELECT * FROM calls WHERE id=$1', [id])).rows[0];
}

/** Earlier calls from the same number, as short text for Gemini. The phone number itself is never included. */
export async function historyFor(phone, excludeCallId) {
  if (!phone) return '';
  const { rows } = await q(
    `SELECT created_at, route, reason_codes, handoff_note FROM calls
     WHERE caller_phone=$1 AND id<>$2 ORDER BY created_at DESC LIMIT 5`,
    [phone, excludeCallId]
  );
  return rows
    .map((r) => `${r.created_at.toISOString().slice(0, 16)} route=${r.route ?? 'none'} ${r.reason_codes?.join(',') ?? ''} ${r.handoff_note ? '| ' + r.handoff_note.slice(0, 200) : ''}`)
    .join('\n');
}

export async function saveTurnDecision(callId, { transcript, decision, route, reasonCodes, clarified }) {
  await q(
    `UPDATE calls SET transcript=$2, decision=$3, route=$4, reason_codes=$5,
            clarify_count = clarify_count + $6 WHERE id=$1`,
    [callId, transcript, decision, route, reasonCodes, clarified ? 1 : 0]
  );
}

/** Finalise inside one transaction: save the result, the costs and the outbox jobs together. */
export async function finalizeCall(callId, f, costs, jobs) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const done = await client.query(
      `UPDATE calls SET ended_at=$2, duration_s=$3, transcript=$4, decision=$5, route=$6, reason_codes=$7,
              handoff_note=$8, finalized_at=now()
       WHERE id=$1 AND finalized_at IS NULL RETURNING id`,
      [callId, f.endedAt, f.durationS, f.transcript, f.decision, f.route, f.reasonCodes, f.note ?? null]
    );
    if (done.rowCount === 0) { await client.query('ROLLBACK'); return false; } // already finalised: duplicate delivery
    for (const c of costs) {
      await client.query(
        'INSERT INTO costs (call_id, provider, unit_type, units, amount_inr) VALUES ($1,$2,$3,$4,$5)',
        [callId, c.provider, c.unitType, c.units, c.amountInr ?? null]
      );
    }
    for (const j of jobs) {
      await client.query('INSERT INTO outbox (kind, payload) VALUES ($1,$2)', [j.kind, j.payload]);
    }
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export const enqueue = (kind, payload, delaySeconds = 0) =>
  q(`INSERT INTO outbox (kind, payload, run_after) VALUES ($1,$2, now() + ($3 || ' seconds')::interval)`, [kind, payload, String(delaySeconds)]);

/** Claim one due job. FOR UPDATE SKIP LOCKED lets several workers run safely. */
export async function claimJob() {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `SELECT * FROM outbox WHERE done_at IS NULL AND dead_at IS NULL AND run_after <= now() AND attempts < 6
       ORDER BY id LIMIT 1 FOR UPDATE SKIP LOCKED`
    );
    const job = rows[0];
    if (job) await client.query('UPDATE outbox SET attempts = attempts + 1, run_after = now() + interval \'5 minutes\' WHERE id=$1', [job.id]);
    await client.query('COMMIT');
    return job ?? null;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
export const jobDone = (id) => q('UPDATE outbox SET done_at=now(), last_error=NULL WHERE id=$1', [id]);
/** Record a failure with exponential backoff (2, 4, 8, 16, 32 minutes). After the 6th attempt the job is marked dead and returned so the caller can alert. */
export async function jobFailed(id, err) {
  const { rows } = await q(
    `UPDATE outbox SET last_error=$2,
            run_after = now() + (LEAST(power(2, attempts), 60) || ' minutes')::interval,
            dead_at = CASE WHEN attempts >= 6 THEN now() ELSE NULL END
     WHERE id=$1 RETURNING id, kind, attempts, dead_at`,
    [id, String(err).slice(0, 500)]
  );
  return rows[0];
}

/**
 * Run fn while holding a Postgres advisory lock on a text key, so two workers never process the same call's HubSpot sync at once.
 * Uses a TRANSACTION-level lock held for the whole transaction. Session-level locks do not work through Neon's pooled
 * connection (PgBouncer in transaction mode may hand each statement a different backend), so they would not exclude anyone.
 */
export async function withLock(key, fn) {
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [key]);
    try {
      return await fn();
    } finally {
      await client.query('COMMIT'); // releases the lock
    }
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

export async function outboxStats() {
  const { rows } = await q("SELECT count(*) FILTER (WHERE done_at IS NULL AND dead_at IS NULL)::int AS pending, count(*) FILTER (WHERE dead_at IS NOT NULL)::int AS dead FROM outbox");
  return rows[0];
}
export const logSync = (callId, target, ok, detail) =>
  q('INSERT INTO sync_log (call_id, target, ok, detail) VALUES ($1,$2,$3,$4)', [callId, target, ok, String(detail ?? '').slice(0, 500)]);

export const setHubspotIds = (callId, contactId, dealId) =>
  q('UPDATE calls SET hubspot_contact_id=$2, hubspot_deal_id=$3 WHERE id=$1', [callId, contactId, dealId]);

export async function createHandoff(callId) {
  return (await q('INSERT INTO handoffs (call_id) VALUES ($1) ON CONFLICT (call_id) DO UPDATE SET call_id = EXCLUDED.call_id RETURNING *', [callId])).rows[0];
}
export const setHandoffMessage = (id, emailId) => q('UPDATE handoffs SET email_message_id=$2 WHERE id=$1', [id, emailId]);
export const insertCost = (callId, c) => q('INSERT INTO costs (call_id, provider, unit_type, units, amount_inr) VALUES ($1,$2,$3,$4,$5)', [callId, c.provider, c.unitType, c.units, c.amountInr ?? null]);
export const getHandoff = async (id) => (await q('SELECT * FROM handoffs WHERE id=$1', [id])).rows[0];
/** Returns true only for the first designer to claim. */
export const claimHandoff = async (id, by) => (await q('UPDATE handoffs SET claimed_by=$2, claimed_at=now() WHERE id=$1 AND claimed_by IS NULL', [id, by])).rowCount === 1;
export const setOutcome = (id, outcome) => q('UPDATE handoffs SET outcome=$2, outcome_at=now() WHERE id=$1', [id, outcome]);

export async function insertBooking(b) {
  return (await q(
    `INSERT INTO bookings (call_id, calcom_uid, calcom_booking_id, event_type_id, visit_type, start_at, status)
     VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
    [b.callId, b.uid, b.id, b.eventTypeId, b.visitType, b.start, b.status]
  )).rows[0];
}
/** Reserve the single booking slot for a call BEFORE calling Cal.com. Returns undefined if one already exists (another worker, or an earlier attempt). */
export async function reserveBooking(callId, visitType) {
  return (await q("INSERT INTO bookings (call_id, visit_type, status) VALUES ($1,$2,'pending') ON CONFLICT (call_id) DO NOTHING RETURNING *", [callId, visitType])).rows[0];
}
export async function completeBooking(id, b) {
  return (await q('UPDATE bookings SET calcom_uid=$2, calcom_booking_id=$3, event_type_id=$4, start_at=$5, status=$6 WHERE id=$1 RETURNING *', [id, b.uid, b.id, b.eventTypeId, b.start, b.status])).rows[0];
}
export const releaseBooking = (id) => q('DELETE FROM bookings WHERE id=$1 AND calcom_uid IS NULL', [id]);
export const bookingForCall = async (callId) => (await q('SELECT * FROM bookings WHERE call_id=$1 ORDER BY id DESC LIMIT 1', [callId])).rows[0];
export async function loadByolState(externalCallId) {
  const row = (await q('SELECT byol_state FROM calls WHERE external_call_id=$1', [externalCallId])).rows[0];
  const st = row?.byol_state ?? {};
  return { askedAvailability: Boolean(st.askedAvailability), availabilityAsks: Number(st.availabilityAsks) || 0, priceDeflected: Boolean(st.priceDeflected) };
}
export const saveByolState = (externalCallId, st) => q('UPDATE calls SET byol_state=$2 WHERE external_call_id=$1', [externalCallId, st]);
export const bookingByUid = async (uid) => (await q('SELECT * FROM bookings WHERE calcom_uid=$1', [uid])).rows[0];
export const getBooking = async (id) => (await q('SELECT * FROM bookings WHERE id=$1', [id])).rows[0];
/** Every Vaani call id we place for a booking is kept, so a late webhook for an earlier attempt is still recognised. */
export const addConfirmCall = (vaaniCallId, bookingId) => q('INSERT INTO confirm_calls (vaani_call_id, booking_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [vaaniCallId, bookingId]);
export const bookingByConfirmCallId = async (callId) =>
  (await q('SELECT b.* FROM confirm_calls c JOIN bookings b ON b.id = c.booking_id WHERE c.vaani_call_id=$1', [callId])).rows[0];
/** A booking we are currently trying to confirm by phone for this number (used when a call-started webhook beats our own bookkeeping). */
export const bookingAwaitingConfirmation = async (phone) =>
  phone ? (await q("SELECT b.* FROM bookings b JOIN calls c ON c.id=b.call_id WHERE c.caller_phone=$1 AND b.confirm_attempts>0 AND b.confirmed_at IS NULL AND b.created_at > now() - interval '24 hours' ORDER BY b.id DESC LIMIT 1", [phone])).rows[0] : undefined;
export const callByExternalId = async (externalId) => (await q('SELECT * FROM calls WHERE external_call_id=$1', [externalId])).rows[0];
export const bumpConfirmAttempt = (id) => q('UPDATE bookings SET confirm_attempts = confirm_attempts + 1 WHERE id=$1', [id]);
export const setBookingConfirmed = (id) => q('UPDATE bookings SET confirmed_at=now() WHERE id=$1', [id]);
/** A reschedule can arrive under a new uid: match the old or the new one and keep the new. */
export const setBookingStatusByUid = async (uids, status, start, newUid) =>
  (await q('UPDATE bookings SET status=$2, start_at=COALESCE($3, start_at), calcom_uid=COALESCE($4, calcom_uid) WHERE calcom_uid = ANY($1)', [uids, status, start ?? null, newUid ?? null])).rowCount;

export async function costTotals(callId) {
  const { rows } = await q('SELECT provider, unit_type, SUM(units) AS units, SUM(amount_inr) AS amount FROM costs WHERE call_id=$1 GROUP BY 1,2', [callId]);
  return rows;
}
export async function outcomeForCall(callId) {
  return (await q('SELECT outcome FROM handoffs WHERE call_id=$1 ORDER BY id DESC LIMIT 1', [callId])).rows[0]?.outcome ?? null;
}

export { settings };

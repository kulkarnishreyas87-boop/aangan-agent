// Data for the dashboard and the public landing page.
// Public data: counts only. Dashboard data (behind login): masked phone numbers, names, areas, notes, bookings.
import * as store from './db.js';
import { opt } from './config.js';

const q = (t, p) => store.db().query(t, p);
const TZ = 'Asia/Kolkata';

/** Keep the country code and the last three digits only. */
export function maskPhone(p) {
  const s = String(p ?? '').replace(/\s+/g, '');
  if (!s) return 'Unknown number';
  const cc = s.startsWith('+') ? s.slice(0, s.length > 10 ? s.length - 10 : 3) : '';
  return `${cc} •••••• ${s.slice(-3)}`.trim();
}

export async function publicStats() {
  const { rows } = await q(`SELECT count(*)::int AS total,
      count(*) FILTER (WHERE route='QUALIFY')::int AS qualified,
      count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h
    FROM calls WHERE finalized_at IS NOT NULL`);
  return rows[0];
}

/** First name only. An open dashboard must not show a customer's full name. */
const firstName = (n) => (n ? String(n).trim().split(/\s+/)[0] : n);

/**
 * opts.open = true when there is no login. Then names are cut to a first name and the handoff notes (which hold the details a
 * customer gave: size, budget hints, family) are left out. Counts, areas, masked numbers and booking times stay.
 */
export async function dashboardData(opts = {}) {
  const open = Boolean(opts.open);
  const [totals, daily, routes, reasons, recent, upcoming, usage, outcomes, live] = await Promise.all([
    q(`SELECT count(*)::int AS total,
        count(*) FILTER (WHERE created_at > now() - interval '24 hours')::int AS last_24h,
        count(*) FILTER (WHERE route='QUALIFY')::int AS qualified,
        count(*) FILTER (WHERE route='DECLINE')::int AS declined,
        count(*) FILTER (WHERE route='ESCALATE')::int AS escalated,
        count(*) FILTER (WHERE route='LOG_ONLY')::int AS log_only,
        COALESCE(round(avg(duration_s))::int, 0) AS avg_duration_s,
        COALESCE(round(avg(EXTRACT(EPOCH FROM (answered_at - started_at))))::int, 0) AS avg_answer_s
      FROM calls WHERE finalized_at IS NOT NULL`),
    q(`SELECT to_char(d::date, 'YYYY-MM-DD') AS day,
        count(c.id) FILTER (WHERE c.route='QUALIFY')::int AS qualified,
        count(c.id) FILTER (WHERE c.route='DECLINE')::int AS declined,
        count(c.id) FILTER (WHERE c.route NOT IN ('QUALIFY','DECLINE'))::int AS other
      FROM generate_series((now() AT TIME ZONE '${TZ}')::date - 13, (now() AT TIME ZONE '${TZ}')::date, interval '1 day') d
      LEFT JOIN calls c ON (c.created_at AT TIME ZONE '${TZ}')::date = d::date AND c.finalized_at IS NOT NULL
      GROUP BY d ORDER BY d`),
    q(`SELECT route, count(*)::int AS n FROM calls WHERE finalized_at IS NOT NULL AND route IS NOT NULL GROUP BY route ORDER BY n DESC`),
    q(`SELECT r AS code, count(*)::int AS n FROM calls, unnest(reason_codes) AS r WHERE route='DECLINE' GROUP BY r ORDER BY n DESC`),
    q(`SELECT c.id, c.created_at, c.finalized_at, c.caller_phone, c.route, c.reason_codes, c.duration_s, c.handoff_note,
        c.decision->'extracted'->>'name' AS name, c.decision->'extracted'->>'area' AS area,
        c.decision->'extracted'->>'property_type' AS property_type, c.decision->'extracted'->>'scope' AS scope,
        c.hubspot_deal_id IS NOT NULL AS in_hubspot,
        b.start_at AS booking_start, b.status AS booking_status, b.visit_type, b.confirmed_at,
        (SELECT outcome FROM handoffs h WHERE h.call_id=c.id LIMIT 1) AS outcome
      FROM calls c LEFT JOIN bookings b ON b.call_id=c.id
      ORDER BY c.created_at DESC LIMIT 14`),
    q(`SELECT b.id, b.start_at, b.visit_type, b.status, b.confirmed_at, c.decision->'extracted'->>'name' AS name, c.decision->'extracted'->>'area' AS area
      FROM bookings b JOIN calls c ON c.id=b.call_id
      WHERE b.calcom_uid IS NOT NULL AND b.status <> 'cancelled' AND b.start_at > now() - interval '2 hours'
      ORDER BY b.start_at LIMIT 6`),
    q(`SELECT COALESCE(sum(units) FILTER (WHERE unit_type='input_tokens'),0)::bigint AS tokens_in,
        COALESCE(sum(units) FILTER (WHERE unit_type='output_tokens'),0)::bigint AS tokens_out,
        sum(amount_inr) AS cost_inr, count(DISTINCT call_id)::int AS calls_costed FROM costs`),
    q(`SELECT (SELECT count(*)::int FROM bookings WHERE calcom_uid IS NOT NULL AND status <> 'cancelled') AS booked,
        (SELECT count(*)::int FROM bookings WHERE confirmed_at IS NOT NULL) AS confirmed,
        (SELECT count(*)::int FROM handoffs WHERE outcome='won') AS won,
        (SELECT count(*)::int FROM handoffs WHERE outcome='lost') AS lost`),
    q(`SELECT count(*)::int AS n FROM calls WHERE finalized_at IS NULL AND created_at > now() - interval '30 minutes'`)
  ]);

  const t = totals.rows[0];
  const o = outcomes.rows[0];
  const u = usage.rows[0];
  return {
    generatedAt: new Date().toISOString(),
    open,
    live: live.rows[0].n,
    kpis: {
      total: t.total, last24h: t.last_24h, qualified: t.qualified, declined: t.declined, escalated: t.escalated, logOnly: t.log_only,
      qualifiedRate: t.total ? Math.round((t.qualified / t.total) * 100) : 0,
      booked: o.booked, confirmed: o.confirmed, won: o.won, lost: o.lost,
      avgDurationS: t.avg_duration_s, avgAnswerS: t.avg_answer_s
    },
    daily: daily.rows,
    routes: routes.rows,
    declineReasons: reasons.rows,
    recent: recent.rows.map((r) => ({
      id: r.id, at: r.created_at, done: Boolean(r.finalized_at), phone: maskPhone(r.caller_phone), name: open ? firstName(r.name) : r.name, area: r.area,
      summary: [r.property_type, r.scope].filter(Boolean).join(', ') || null, route: r.route, reasons: r.reason_codes ?? [],
      durationS: r.duration_s, note: open ? null : r.handoff_note, inHubspot: r.in_hubspot, outcome: r.outcome,
      booking: r.booking_start ? { start: r.booking_start, status: r.booking_status, type: r.visit_type, confirmed: Boolean(r.confirmed_at) } : null
    })),
    upcoming: upcoming.rows.map((b) => ({ id: b.id, start: b.start_at, type: b.visit_type, name: open ? firstName(b.name) : b.name, area: b.area, confirmed: Boolean(b.confirmed_at) })),
    usage: { tokensIn: Number(u.tokens_in), tokensOut: Number(u.tokens_out), costInr: u.cost_inr == null ? null : Number(u.cost_inr), callsCosted: u.calls_costed },
    system: {
      outbox: await store.outboxStats(),
      integrations: [
        ['Neon database', Boolean(opt('DATABASE_URL'))],
        ['Gemini decisions', Boolean(opt('GEMINI_API_KEY') && opt('GEMINI_MODEL'))],
        ['Vaani voice link', Boolean(opt('VAANI_WEBHOOK_SECRET') && opt('VAANI_BYOL_TOKEN'))],
        ['Resend email', Boolean(opt('RESEND_API_KEY') && opt('EMAIL_FROM'))],
        ['Cal.com calendar', Boolean(opt('CALCOM_API_KEY'))],
        ['HubSpot CRM', Boolean(opt('HUBSPOT_ACCESS_TOKEN'))],
        ['Confirmation calls', Boolean(opt('VAANI_API_KEY') && opt('VAANI_CONFIRM_AGENT_ID'))]
      ].map(([name, ok]) => ({ name, ok }))
    }
  };
}

// Outbox worker. Everything after "Neon saved it" runs here, so a vendor outage never loses a call.
// Jobs retry with exponential backoff; after the 6th failed attempt a job is marked dead and a person is emailed.
import * as store from './db.js';
import * as email from './email.js';
import * as hubspot from './hubspot.js';
import * as cal from './calcom.js';
import * as vaani from './vaani.js';
import { pickSlot } from './gemini.js';
import { settings } from './config.js';
import { geminiCostRows } from './pipeline.js';

const fmtWhen = (iso) => new Date(iso).toLocaleString('en-IN', { timeZone: settings.timeZone(), dateStyle: 'full', timeStyle: 'short' });
const hasLiveBooking = (b) => Boolean(b?.calcom_uid) && b.status !== 'cancelled';

const handlers = {
  async email_handoff({ callId, flags }, job) {
    const call = await store.getCall(callId);
    const booking = await store.bookingForCall(callId);
    const handoff = await store.createHandoff(callId); // one per call, so a retry reuses it
    const emailId = await email.sendHandoff({
      handoffId: handoff.id,
      call,
      note: call.handoff_note,
      flags,
      booking: hasLiveBooking(booking) && booking.start_at ? fmtWhen(booking.start_at) : null,
      idempotencyKey: `job-${job.id}`
    });
    await store.setHandoffMessage(handoff.id, emailId);
    await store.logSync(callId, 'email', true, `handoff ${handoff.id}`);
  },

  async email_escalation({ callId }, job) {
    const call = await store.getCall(callId);
    await email.sendEscalation({ call, note: call.handoff_note, idempotencyKey: `job-${job.id}` });
    await store.logSync(callId, 'email', true, 'escalation');
  },

  async email_task({ text, to }, job) {
    await email.sendTask({ text, to, idempotencyKey: `job-${job.id}` });
  },

  /** Serialised per call: concurrent drains could otherwise each create a deal. The call is reloaded inside the lock. */
  async hubspot_sync({ callId }) {
    await store.withLock(`hubspot:${callId}`, async () => {
      const call = await store.getCall(callId);
      const booking = await store.bookingForCall(callId);
      const outcome = await store.outcomeForCall(callId);
      const costs = await store.costTotals(callId);
      const known = costs.map((c) => c.amount).filter((a) => a != null);
      const totalCost = known.length ? known.reduce((s, a) => s + Number(a), 0) : undefined;

      const stageKey = outcome === 'won' ? 'WON'
        : outcome === 'lost' ? 'LOST'
        : hasLiveBooking(booking) ? 'BOOKED'
        : call.route === 'QUALIFY' ? 'QUALIFIED'
        : call.route === 'DECLINE' ? 'DECLINED'
        : 'OTHER';

      const x = call.decision?.extracted ?? {};
      const contactId = call.hubspot_contact_id ?? (await hubspot.upsertContact({ phone: call.caller_phone, name: x.name }));
      // Save the id at once. HubSpot search lags a few seconds behind creation, so a retry must not search for a contact we already made.
      if (!call.hubspot_contact_id) await store.setHubspotIds(callId, contactId, call.hubspot_deal_id ?? null);
      const answerSeconds = call.answered_at && call.started_at ? Math.round((call.answered_at - call.started_at) / 1000) : undefined;
      const dealId = await hubspot.upsertDeal({
        dealId: call.hubspot_deal_id,
        contactId,
        name: `${x.name ?? 'Caller'}, ${x.area ?? 'Pune'}, phone enquiry`,
        stage: hubspot.stageId(stageKey),
        properties: {
          aangan_route: call.route,
          aangan_reason_codes: (call.reason_codes ?? []).join(','),
          aangan_answer_seconds: answerSeconds,
          aangan_call_cost_inr: totalCost,
          aangan_booking_start: hasLiveBooking(booking) ? booking.start_at?.toISOString() : undefined,
          aangan_handoff_note: call.handoff_note
        }
      });
      await store.setHubspotIds(callId, contactId, dealId);
      await store.logSync(callId, 'hubspot', true, `deal ${dealId} stage ${stageKey}`);
    });
  },

  /**
   * Auto-scheduler. Gate: only a Qualify route is ever scheduled.
   * The booking row is RESERVED before Cal.com is called, so a retry or a second worker can never book the same call twice.
   */
  async schedule({ callId }) {
    const call = await store.getCall(callId);
    if (call.route !== 'QUALIFY') return; // gate

    const existing = await store.bookingForCall(callId);
    if (existing) {
      // A pending row with no Cal.com uid means an earlier attempt died mid-booking. Do not guess: ask a person to check.
      if (!existing.calcom_uid && Date.now() - existing.created_at.getTime() > 10 * 60 * 1000) {
        await store.enqueue('email_task', { text: `A booking attempt for ${call.caller_phone ?? 'a caller'} did not finish. Please check Cal.com for a booking and, if none exists, schedule it manually.` });
      }
      return;
    }

    const [siteVisit, phone] = await Promise.all([cal.openSlots('site_visit'), cal.openSlots('phone')]);
    const { json: pick, usage } = await pickSlot({
      transcript: call.transcript,
      slotsByType: { site_visit: siteVisit, phone },
      nowIso: new Date().toISOString(),
      timeZone: settings.timeZone()
    });
    for (const c of geminiCostRows(usage)) await store.insertCost(callId, c);

    const pool = pick.visit_type === 'site_visit' ? siteVisit : phone;
    const chosen = pick.chosen_start && pool.includes(pick.chosen_start) ? pick.chosen_start : null; // never trust a time Cal.com did not offer

    if (!chosen) {
      const alts = (pick.alternates ?? []).filter((a) => pool.includes(a)).map(fmtWhen).join(' | ') || 'none';
      await store.enqueue('email_task', {
        text: `Could not auto-schedule ${call.caller_phone ?? 'caller'}. They said: "${pick.stated_availability}". Open options: ${alts}. Please book manually.`
      });
      return;
    }

    const reserved = await store.reserveBooking(callId, pick.visit_type);
    if (!reserved) return; // another worker got there first

    const x = call.decision?.extracted ?? {};
    let booked;
    try {
      booked = await cal.book({ visitType: pick.visit_type, startIso: chosen, name: x.name ?? 'Aangan enquiry', phone: call.caller_phone, timeZone: settings.timeZone() });
    } catch (e) {
      await store.releaseBooking(reserved.id); // nothing was booked, so the retry may try again
      throw e;
    }
    const row = await store.completeBooking(reserved.id, booked);
    await store.logSync(callId, 'calcom', true, `booking ${booked.uid}`);
    await store.enqueue('hubspot_sync', { callId });
    await store.enqueue('email_task', { text: `Consultation booked for ${call.caller_phone ?? 'caller'}: ${fmtWhen(booked.start)} (${pick.visit_type}).` });
    await store.enqueue('outbound_confirm', { bookingId: row.id });
  },

  /** Confirmation call. Up to CONFIRM_MAX_ATTEMPTS tries, then a human gets an email task. */
  async outbound_confirm({ bookingId }) {
    const b = await store.getBooking(bookingId);
    if (!b || b.confirmed_at || b.status === 'cancelled') return;
    const call = await store.getCall(b.call_id);
    if (!call.caller_phone) {
      await store.enqueue('email_task', { text: `No phone number on file for the ${fmtWhen(b.start_at)} booking (call ${call.id}). Please confirm it manually.` });
      return;
    }
    if (b.confirm_attempts >= settings.confirmMaxAttempts()) {
      await store.enqueue('email_task', { text: `Customer ${call.caller_phone} has not confirmed the ${fmtWhen(b.start_at)} slot after ${b.confirm_attempts} calls. Please follow up.` });
      return;
    }
    try {
      await store.bumpConfirmAttempt(b.id); // count the attempt first, so a crash after dialing cannot cause unlimited re-dials
      const { callId } = await vaani.placeOutboundCall({ phone: call.caller_phone, name: call.decision?.extracted?.name, whenText: fmtWhen(b.start_at), visitType: b.visit_type });
      await store.addConfirmCall(callId, b.id);
      await store.enqueue('outbound_confirm', { bookingId: b.id }, 30 * 60); // re-check in 30 minutes
    } catch (e) {
      if (e instanceof vaani.NotConfigured) {
        await store.enqueue('email_task', { text: `Please call ${call.caller_phone} to confirm ${fmtWhen(b.start_at)}. (Automatic confirmation call is not set up yet.)` });
        return;
      }
      throw e;
    }
  }
};

export async function drain(max = 20) {
  for (let i = 0; i < max; i++) {
    const job = await store.claimJob();
    if (!job) return;
    try {
      const fn = handlers[job.kind];
      if (!fn) throw new Error(`Unknown job kind ${job.kind}`);
      await fn(job.payload, job);
      await store.jobDone(job.id);
    } catch (e) {
      console.error(`[worker] ${job.kind} #${job.id} failed (attempt ${job.attempts + 1}):`, e.message);
      let failed;
      try { failed = await store.jobFailed(job.id, e.message); } catch (err) { console.error('[worker] could not record failure:', err.message); }
      if (failed?.dead_at) {
        // Last attempt used. Tell a person; best effort, because the failing job may itself be the email path.
        console.error(`[worker] job ${job.kind} #${job.id} is dead after ${failed.attempts} attempts`);
        try {
          await email.sendTask({ text: `An automatic job failed 6 times and was dropped: ${job.kind} #${job.id}. Last error: ${e.message}. Details: ${JSON.stringify(job.payload).slice(0, 300)}`, to: 'escalation', idempotencyKey: `dead-${job.id}` });
        } catch (err) { console.error('[worker] could not send the dead-job alert:', err.message); }
      }
    }
  }
}

export function startWorker(everyMs = 5000) {
  const t = setInterval(() => drain().catch((e) => console.error('[worker]', e.message)), everyMs);
  t.unref?.();
  return t;
}

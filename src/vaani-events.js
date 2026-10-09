// Vaani webhook events. The docs name these events: call_started, call_ended, call_postprocessing and others.
// We act on two:
//   call_started        -> remember the caller's number for the call
//   call_postprocessing -> the transcript is ready: finalise an enquiry call, or judge a confirmation call
// Everything is idempotent: Vaani's retry and ordering behaviour is not documented.
import * as store from './db.js';
import * as vaani from './vaani.js';
import { finalizeCall } from './pipeline.js';
import { judgeConfirmation } from './gemini.js';
import { drain } from './worker.js';
import { background } from './background.js';

/**
 * Is this one of OUR confirmation calls? Known by call id (we keep every id we placed). If the webhook beat our own
 * bookkeeping, a call with no conversation of its own to a number we are currently confirming also counts.
 */
async function confirmationFor(callId, phone) {
  const known = await store.bookingByConfirmCallId(callId);
  if (known) return known;
  const row = await store.callByExternalId(callId);
  if (row && row.transcript) return null; // it had a live conversation with our server: an enquiry
  const awaiting = await store.bookingAwaitingConfirmation(phone ?? row?.caller_phone ?? null);
  if (awaiting) { await store.addConfirmCall(callId, awaiting.id); return awaiting; }
  return null;
}

export async function onVaaniEvent(body) {
  const e = vaani.parseEvent(body);
  if (!e.callId) return { ignored: 'no call id' };

  if (e.event === 'call_started') {
    if (await confirmationFor(e.callId, e.phone)) return { ignored: 'outbound confirmation call' };
    const now = e.timestamp ?? new Date();
    await store.upsertCall({ externalCallId: e.callId, callerPhone: e.phone, startedAt: now, answeredAt: now });
    return { ok: 'call_started' };
  }

  if (e.event === 'call_postprocessing') {
    let transcript = e.transcript;
    if (!transcript) {
      try { transcript = (await vaani.getCallDetails(e.callId)).transcript; } catch (err) { console.error('[vaani] call details fallback failed:', err.message); }
    }

    const confirmation = await confirmationFor(e.callId, e.phone);
    if (confirmation) {
      const { json } = await judgeConfirmation({ transcript: transcript ?? '' });
      if (json.outcome === 'confirmed') await store.setBookingConfirmed(confirmation.id);
      else await store.enqueue('email_task', { text: `Confirmation call for booking ${confirmation.calcom_uid}: ${json.outcome}. ${json.note}` });
      await background(drain(), { waitMs: 45000 });
      return { ok: 'confirmation', outcome: json.outcome };
    }

    const result = await finalizeCall({
      externalCallId: e.callId,
      callerPhone: e.phone, // used only if call_started did not already store the number
      endedAt: e.timestamp ?? new Date(),
      durationS: e.durationS,
      transcript: transcript ?? ''
    });
    await background(drain(), { waitMs: 45000 }); // run the outbox before answering (see background.js)
    return { ok: 'finalized', ...result };
  }

  return { ignored: e.event };
}

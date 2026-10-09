// Live Cal.com check using our own calcom.js: list open slots, book one throwaway slot (phone only, no email), cancel it.
// Usage: node --env-file=.env scripts/e2e-calcom-live.js
import { openSlots, book } from '../src/calcom.js';
import { need } from '../src/config.js';

const slots = await openSlots('phone');
console.log(`open phone slots in window: ${slots.length}; first 3: ${slots.slice(0, 3).join(', ')}`);
const site = await openSlots('site_visit');
console.log(`open site-visit slots in window: ${site.length}`);
if (!slots.length) { console.log('No slots: check the availability schedule in Cal.com.'); process.exit(1); }

const start = slots[slots.length > 3 ? 3 : 0];
const b = await book({ visitType: 'phone', startIso: start, name: 'TEST Aangan (safe to delete)', phone: '+919999900002', timeZone: 'Asia/Kolkata' });
console.log('booked:', JSON.stringify(b));

const res = await fetch(`https://api.cal.com/v2/bookings/${b.uid}/cancel`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${need('CALCOM_API_KEY')}`, 'cal-api-version': need('CALCOM_BOOKINGS_API_VERSION'), 'content-type': 'application/json' },
  body: JSON.stringify({ cancellationReason: 'Automated integration test' })
});
console.log('cancel:', res.status, (await res.text()).slice(0, 200));

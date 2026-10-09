// Shared cleanup for the test scripts. Deletes ONLY rows that belong to the test calls: never by time window alone,
// so running a test against a database that also has real traffic cannot remove a real job.
export async function cleanupTestRows(store, { startedTest, callIds = [], phones = [], extraTextMarkers = [] }) {
  const q = (t, p) => store.db().query(t, p);
  if (!callIds.length) return;
  const bookingIds = (await q('SELECT id FROM bookings WHERE call_id = ANY($1)', [callIds])).rows.map((r) => String(r.id));
  const markers = [...phones, ...extraTextMarkers].map((m) => `%${m}%`);
  await q(
    `DELETE FROM outbox WHERE created_at >= $1 AND (
       payload->>'callId' = ANY($2)
       OR payload->>'bookingId' = ANY($3)
       OR (payload ? 'text' AND payload->>'text' LIKE ANY($4))
     )`,
    [startedTest, callIds.map(String), bookingIds, markers]
  );
  for (const t of ['costs', 'bookings', 'handoffs', 'sync_log']) await q(`DELETE FROM ${t} WHERE call_id = ANY($1)`, [callIds]);
  await q('DELETE FROM calls WHERE id = ANY($1)', [callIds]);
}

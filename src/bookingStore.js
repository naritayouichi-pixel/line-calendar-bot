const db = require('./firestore');
const pairStore = require('./pairStore');
const collection = db.collection('bookings');

async function addBooking(record) {
  const ref = collection.doc();
  await ref.set({ attended: false, ...record, bookingId: ref.id, status: 'confirmed' });
  return ref.id;
}
async function getBooking(id) {
  const snapshot = await collection.doc(id).get();
  return snapshot.exists ? snapshot.data() : null;
}
async function getBookingsByUser(userId) {
  return (await userRecords(userId)).filter((b) => b.status === 'confirmed');
}
async function updateBooking(id, patch) {
  const ref = collection.doc(id);
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    tx.update(ref, patch);
    return { ...snapshot.data(), ...patch };
  });
}
async function cancelBooking(id) { return updateBooking(id, { status: 'cancelled' }); }
async function markAttended(id) { return updateBooking(id, { attended: true }); }
async function userRecords(userId) {
  const userIds = await pairStore.getMemberIds(userId);
  const snapshots = await Promise.all(userIds.map((id) => collection.where('userId', '==', id).get()));
  const records = snapshots.flatMap((snapshot) => snapshot.docs.map((doc) => doc.data()));
  return [...new Map(records.map((record) => [record.bookingId, record])).values()];
}
async function getOutstandingCount(userId, duration = null, excludeId = null) {
  return (await userRecords(userId)).filter((b) => b.status === 'confirmed' && !b.attended && b.bookingId !== excludeId && (duration === null || b.durationMinutes === duration)).length;
}
async function getMonthlyBookingCount(userId, month, excludeId = null) {
  return (await userRecords(userId)).filter((b) => b.status === 'confirmed' && b.bookingId !== excludeId && b.dateStr.startsWith(month)).length;
}
async function getMonthlyMembershipBookingCount(userId, month, excludeId = null) {
  return (await userRecords(userId)).filter((b) =>
    b.status === 'confirmed'
    && b.bookingId !== excludeId
    && b.dateStr.startsWith(month)
    && b.usageType !== 'ticket'
  ).length;
}
async function getOutstandingTicketBookingCount(userId, duration = null, excludeId = null, includeLegacy = false) {
  return (await userRecords(userId)).filter((b) =>
    b.status === 'confirmed'
    && !b.attended
    && b.bookingId !== excludeId
    && (duration === null || b.durationMinutes === duration)
    && (b.usageType === 'ticket' || (includeLegacy && !b.usageType))
  ).length;
}
async function getDistinctCustomerNames(userId) {
  return [...new Set((await userRecords(userId)).map((b) => b.customerName).filter(Boolean))];
}
async function findByEventId(eventId) {
  const snapshot = await collection.where('eventId', '==', eventId).limit(1).get();
  return snapshot.empty ? null : snapshot.docs[0].data();
}

async function getBookingsForDate(dateStr) {
  const snapshot = await collection.where('dateStr', '==', dateStr).get();
  return snapshot.docs.map((doc) => doc.data()).filter((b) => b.status === 'confirmed');
}

module.exports = { addBooking, getBooking, getBookingsByUser, updateBooking, cancelBooking, markAttended, getOutstandingCount, getMonthlyBookingCount, getMonthlyMembershipBookingCount, getOutstandingTicketBookingCount, getDistinctCustomerNames, findByEventId, getBookingsForDate };

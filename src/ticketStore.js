const db = require('./firestore');
const pairStore = require('./pairStore');
const collection = db.collection('tickets');
const TICKET_DURATIONS = [45, 60];
const TICKET_PACKAGE_COUNTS = [1, 5, 10];

async function get(userId) {
  const snapshot = await collection.doc(await pairStore.canonicalUserId(userId)).get();
  return snapshot.exists ? snapshot.data() : null;
}
async function isTicketCustomer(userId) { return Boolean(await get(userId)); }
async function getBalance(userId, duration) { return (await get(userId))?.tickets?.[duration] || 0; }
async function getBalances(userId) {
  const record = await get(userId);
  return { 45: record?.tickets?.[45] || 0, 60: record?.tickets?.[60] || 0 };
}
async function getName(userId) { return (await get(userId))?.name || null; }

async function addTickets(userId, name, duration, count) {
  const ref = collection.doc(await pairStore.canonicalUserId(userId));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const old = snapshot.exists ? snapshot.data() : {};
    const tickets = { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 };
    tickets[duration] += count;
    tx.set(ref, { name: name || old.name || '(名前未登録)', tickets });
    return tickets[duration];
  });
}

async function decrementTicket(userId, duration) {
  const ref = collection.doc(await pairStore.canonicalUserId(userId));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return 0;
    const old = snapshot.data();
    const tickets = { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 };
    tickets[duration] = Math.max(0, tickets[duration] - 1);
    tx.update(ref, { tickets });
    return tickets[duration];
  });
}

async function registerAsTicketCustomer(userId, name) {
  const ref = collection.doc(await pairStore.canonicalUserId(userId));
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const old = snapshot.exists ? snapshot.data() : {};
    tx.set(ref, {
      name: name || old.name || '(名前未登録)',
      tickets: { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 },
    });
  });
}

/**
 * 予約開始時刻を過ぎたチケット会員の予約を、一度だけ来店済みにして1枚消費する。
 * bookingとticketを同じトランザクションで更新するため、定期処理が重なっても二重消費しない。
 */
async function consumeForDueBooking(bookingId, dateStr, timeStr) {
  const bookingRef = db.collection('bookings').doc(bookingId);
  const initialBooking = await bookingRef.get();
  if (!initialBooking.exists) return null;
  const ticketOwnerId = await pairStore.canonicalUserId(initialBooking.data().userId);
  return db.runTransaction(async (tx) => {
    const bookingSnapshot = await tx.get(bookingRef);
    if (!bookingSnapshot.exists) return null;
    const booking = bookingSnapshot.data();
    if (
      booking.status !== 'confirmed' ||
      booking.attended ||
      booking.dateStr !== dateStr ||
      booking.startTime > timeStr
    ) return null;

    const ticketRef = collection.doc(ticketOwnerId);
    const ticketSnapshot = await tx.get(ticketRef);
    if (!ticketSnapshot.exists) return null;

    const duration = booking.durationMinutes || 60;
    const old = ticketSnapshot.data();
    const tickets = { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 };
    tickets[duration] = Math.max(0, tickets[duration] - 1);
    const consumedAt = new Date().toISOString();
    tx.update(ticketRef, { tickets });
    tx.update(bookingRef, { attended: true, autoConsumedAt: consumedAt });
    return {
      bookingId,
      customerName: booking.customerName,
      duration,
      remainingBalance: tickets[duration],
    };
  });
}

module.exports = { TICKET_DURATIONS, TICKET_PACKAGE_COUNTS, isTicketCustomer, getBalance, getBalances, getName, addTickets, decrementTicket, registerAsTicketCustomer, consumeForDueBooking };

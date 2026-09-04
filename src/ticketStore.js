const db = require('./firestore');
const pairStore = require('./pairStore');
const collection = db.collection('tickets');
const TICKET_DURATIONS = [45, 60];
const TICKET_PACKAGE_COUNTS = [1, 5, 10];

function selectTicketDuration(tickets, fallbackDuration = 60) {
  const balance45 = Number(tickets?.[45] || 0);
  const balance60 = Number(tickets?.[60] || 0);
  if (balance45 > 0 && balance60 <= 0) return 45;
  if (balance60 > 0 && balance45 <= 0) return 60;
  if (balance45 > 0 && balance60 > 0 && TICKET_DURATIONS.includes(Number(fallbackDuration))) {
    return Number(fallbackDuration);
  }
  return TICKET_DURATIONS.includes(Number(fallbackDuration)) ? Number(fallbackDuration) : 60;
}

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
async function updateNameIfMissing(userId, name) {
  if (!name || name === '(名前未登録)') return false;
  const ref = collection.doc(await pairStore.canonicalUserId(userId));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists || (snapshot.data().name && snapshot.data().name !== '(名前未登録)')) return false;
    tx.update(ref, { name });
    return true;
  });
}
async function getPreferredDuration(userId) {
  const record = await get(userId);
  const storedDuration = Number(record?.duration);
  if (TICKET_DURATIONS.includes(storedDuration)) return storedDuration;
  const balance45 = Number(record?.tickets?.[45] || 0);
  const balance60 = Number(record?.tickets?.[60] || 0);
  if (balance45 > 0 && balance60 <= 0) return 45;
  if (balance60 > 0 && balance45 <= 0) return 60;
  return null;
}
async function listTicketCustomers() {
  const snapshot = await collection.get();
  return snapshot.docs.map((doc) => ({ userId: doc.id, ...doc.data() }));
}

async function addTickets(userId, name, duration, count) {
  const ref = collection.doc(await pairStore.canonicalUserId(userId));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const old = snapshot.exists ? snapshot.data() : {};
    const tickets = { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 };
    tickets[duration] += count;
    tx.set(ref, { name: name || old.name || '(名前未登録)', tickets, duration });
    return tickets[duration];
  });
}

async function removeTickets(userId, duration, count) {
  const ref = collection.doc(await pairStore.canonicalUserId(userId));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (!snapshot.exists) return null;
    const old = snapshot.data();
    const tickets = { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 };
    const previousBalance = Number(tickets[duration] || 0);
    const removedCount = Math.min(previousBalance, count);
    tickets[duration] = previousBalance - removedCount;
    tx.update(ref, { tickets, duration });
    return { previousBalance, removedCount, newBalance: tickets[duration] };
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
      booking.usageType === 'membership' ||
      booking.dateStr !== dateStr ||
      booking.startTime > timeStr
    ) return null;

    const ticketRef = collection.doc(ticketOwnerId);
    const ticketSnapshot = await tx.get(ticketRef);
    if (!ticketSnapshot.exists) return null;

    const old = ticketSnapshot.data();
    const tickets = { 45: old.tickets?.[45] || 0, 60: old.tickets?.[60] || 0 };
    const duration = selectTicketDuration(tickets, booking.durationMinutes || 60);
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

module.exports = { TICKET_DURATIONS, TICKET_PACKAGE_COUNTS, selectTicketDuration, isTicketCustomer, getBalance, getBalances, getName, updateNameIfMissing, getPreferredDuration, listTicketCustomers, addTickets, removeTickets, decrementTicket, registerAsTicketCustomer, consumeForDueBooking };

const db = require('./firestore');
const collection = db.collection('reservationReminderDeliveries');

function documentId(period, userId) {
  return `${period}_${userId}`;
}

async function claim(period, userId) {
  const ref = collection.doc(documentId(period, userId));
  return db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    if (snapshot.exists) return false;
    tx.create(ref, { period, userId, claimedAt: new Date().toISOString() });
    return true;
  });
}

async function release(period, userId) {
  await collection.doc(documentId(period, userId)).delete();
}

module.exports = { claim, release };

const db = require('./firestore');
const collection = db.collection('trialBookings');

async function create(record) {
  const ref = collection.doc();
  await ref.set({ trialId: ref.id, status: 'awaiting_payment', createdAt: new Date().toISOString(), ...record });
  return { trialId: ref.id, ...record };
}
async function get(id) { const snap = await collection.doc(id).get(); return snap.exists ? snap.data() : null; }
async function patch(id, values) { await collection.doc(id).set(values, { merge:true }); return get(id); }
async function findByOrderId(orderId) {
  const snap = await collection.where('squareOrderId', '==', orderId).limit(1).get();
  return snap.empty ? null : snap.docs[0].data();
}
async function listExpired(nowIso) {
  const snap = await collection.where('status', '==', 'awaiting_payment').get();
  return snap.docs.map((doc)=>doc.data()).filter((row)=>row.expiresAt && row.expiresAt <= nowIso);
}
module.exports = { create, get, patch, findByOrderId, listExpired };

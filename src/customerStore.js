const db = require('./firestore');
const collection = db.collection('customers');

function normalizeCustomerName(name) {
  const value = String(name || '').replace(/様$/, '').trim();
  if (!value || value.length > 40 || /[\r\n]/.test(value)) {
    throw new Error('フルネームだけを40文字以内で入力してください。');
  }
  return value;
}

function isPairCustomerName(name) {
  return typeof name === 'string' && /ペア\s*$/.test(name);
}

async function linkCustomer(userId, name) {
  const record = { name: normalizeCustomerName(name), linkedAt: new Date().toISOString() };
  await collection.doc(userId).set(record, { merge: true });
  return record;
}

async function getName(userId) {
  const snapshot = await collection.doc(userId).get();
  return snapshot.exists ? snapshot.data().name || null : null;
}

async function listLinkedCustomers() {
  const snapshot = await collection.get();
  return snapshot.docs.map((doc) => ({ userId: doc.id, ...doc.data() }));
}

module.exports = { linkCustomer, getName, listLinkedCustomers, normalizeCustomerName, isPairCustomerName };

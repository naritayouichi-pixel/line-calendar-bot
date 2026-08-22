const db = require('./firestore');
const pairStore = require('./pairStore');
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

function pairLinkKey(name) {
  if (!name) return null;
  const normalized = normalizeCustomerName(name).replace(/[\s　]+/g, '');
  return normalized.endsWith('ペア') ? normalized : null;
}

async function linkCustomer(userId, name) {
  const record = { name: normalizeCustomerName(name), linkedAt: new Date().toISOString() };
  await collection.doc(userId).set(record, { merge: true });
  const key = pairLinkKey(record.name);
  if (key) {
    const snapshot = await collection.get();
    const matches = snapshot.docs
      .map((doc) => ({ userId: doc.id, ...doc.data() }))
      .filter((customer) => pairLinkKey(customer.name) === key)
      .sort((a, b) => String(a.linkedAt || '').localeCompare(String(b.linkedAt || '')));
    if (matches.length >= 2) {
      const memberUserIds = matches.map((customer) => customer.userId);
      await pairStore.linkPair(record.name, memberUserIds[0], memberUserIds);
    }
  }
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

module.exports = { linkCustomer, getName, listLinkedCustomers, normalizeCustomerName, isPairCustomerName, pairLinkKey };

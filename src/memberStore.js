const db = require('./firestore');
const collection = db.collection('members');

async function get(userId) {
  const snapshot = await collection.doc(userId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function isMember(userId) { return Boolean(await get(userId)); }

async function addMember(userId, name, monthlyQuota, sessionDuration) {
  const ref = collection.doc(userId);
  await db.runTransaction(async (tx) => {
    const snapshot = await tx.get(ref);
    const old = snapshot.exists ? snapshot.data() : {};
    tx.set(ref, {
      name: name || old.name || '(名前未登録)',
      monthlyQuota: monthlyQuota != null ? monthlyQuota : old.monthlyQuota || 0,
      sessionDuration: sessionDuration != null ? sessionDuration : old.sessionDuration || null,
    });
  });
}

async function getMonthlyQuota(userId) { return (await get(userId))?.monthlyQuota || 0; }
async function getSessionDuration(userId) { return (await get(userId))?.sessionDuration || null; }
async function getName(userId) { return (await get(userId))?.name || null; }
async function removeMember(userId) { await collection.doc(userId).delete(); }

module.exports = { isMember, addMember, removeMember, getMonthlyQuota, getSessionDuration, getName };

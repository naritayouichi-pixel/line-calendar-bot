const db = require('./firestore');

const accounts = db.collection('pairAccounts');
const members = db.collection('pairMembers');

async function getPair(userId) {
  const snapshot = await members.doc(userId).get();
  return snapshot.exists ? snapshot.data() : null;
}

async function getMemberIds(userId) {
  const pair = await getPair(userId);
  return pair?.memberUserIds?.length ? pair.memberUserIds : [userId];
}

async function canonicalUserId(userId) {
  const pair = await getPair(userId);
  return pair?.primaryUserId || userId;
}

async function getName(userId) {
  return (await getPair(userId))?.name || null;
}

async function sameAccount(firstUserId, secondUserId) {
  if (!firstUserId || !secondUserId) return false;
  if (firstUserId === secondUserId) return true;
  return (await canonicalUserId(firstUserId)) === (await canonicalUserId(secondUserId));
}

async function linkPair(name, primaryUserId, memberUserIds) {
  const uniqueIds = [...new Set([primaryUserId, ...memberUserIds].filter(Boolean))];
  if (uniqueIds.length < 2) throw new Error('ペア連携には2つ以上のLINEユーザーIDが必要です。');
  const groupId = `pair_${primaryUserId}`;
  const record = { groupId, name, primaryUserId, memberUserIds: uniqueIds, updatedAt: new Date().toISOString() };
  const batch = db.batch();
  batch.set(accounts.doc(groupId), record, { merge: true });
  for (const userId of uniqueIds) batch.set(members.doc(userId), record, { merge: true });
  await batch.commit();
  return record;
}

module.exports = { getPair, getMemberIds, canonicalUserId, getName, sameAccount, linkPair };

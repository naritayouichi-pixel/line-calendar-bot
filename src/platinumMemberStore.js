const db = require('./firestore');
const { normalizeMemberName } = require('./platinumMembers');

const collection = db.collection('platinumMembers');

async function isPlatinumName(name) {
  const normalizedName = normalizeMemberName(name);
  if (!normalizedName) return false;
  const snapshot = await collection.doc(normalizedName).get();
  return snapshot.exists && snapshot.data()?.active !== false;
}

async function register(name) {
  const normalizedName = normalizeMemberName(name);
  if (!normalizedName) throw new Error('プラチナ会員名が空です。');
  await collection.doc(normalizedName).set({
    name: normalizedName,
    grade: 'platinum',
    active: true,
    updatedAt: new Date().toISOString(),
  }, { merge: true });
}

module.exports = { isPlatinumName, register };

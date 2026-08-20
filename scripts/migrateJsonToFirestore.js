const fs = require('fs');
const path = require('path');
const db = require('../src/firestore');

const DATA_DIR = path.join(__dirname, '..', 'data');
const sources = [
  ['bookings.json', 'bookings'],
  ['tickets.json', 'tickets'],
  ['members.json', 'members'],
  ['customers.json', 'customers'],
];

async function migrateFile(fileName, collectionName) {
  const file = path.join(DATA_DIR, fileName);
  if (!fs.existsSync(file)) {
    console.log(`${fileName}: skipped (not found)`);
    return;
  }
  const records = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = Object.entries(records);
  for (let offset = 0; offset < entries.length; offset += 400) {
    const batch = db.batch();
    for (const [id, record] of entries.slice(offset, offset + 400)) {
      batch.set(db.collection(collectionName).doc(id), record, { merge: true });
    }
    await batch.commit();
  }
  console.log(`${fileName}: migrated ${entries.length}`);
}

(async () => {
  for (const [file, collection] of sources) await migrateFile(file, collection);
  console.log('Firestore migration complete.');
})().catch((error) => {
  console.error(error);
  process.exit(1);
});

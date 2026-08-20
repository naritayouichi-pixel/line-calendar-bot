require('dotenv').config();

const customerStore = require('../src/customerStore');

async function main() {
  const [userId, name] = process.argv.slice(2);
  if (!/^U[0-9a-fA-F]{32}$/.test(userId || '')) throw new Error('LINEユーザーIDの形式が正しくありません。');
  const record = await customerStore.linkCustomer(userId, name);
  const saved = await customerStore.getName(userId);
  if (saved !== record.name) throw new Error('登録後の確認に失敗しました。');
  console.log(`顧客名を「${saved}」へ修正しました。`);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

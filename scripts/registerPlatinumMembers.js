require('dotenv').config();

const store = require('../src/platinumMemberStore');
const { PLATINUM_MEMBER_NAMES } = require('../src/platinumMembers');

async function main() {
  for (const name of PLATINUM_MEMBER_NAMES) {
    await store.register(name);
    console.log(`登録: ${name}`);
  }
  console.log(`プラチナ会員 ${PLATINUM_MEMBER_NAMES.length}名の登録が完了しました。`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});

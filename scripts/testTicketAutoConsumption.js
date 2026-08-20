const { execFileSync } = require('node:child_process');

process.env.FIRESTORE_PROJECT_ID ||= 'line-calendar-bot-504511';
const db = require('../src/firestore');

const PROJECT = 'line-calendar-bot-504511';
const REGION = 'asia-northeast1';
const JOB = 'ticket-auto-consumption';
const TEST_USER_ID = 'codex-e2e-ticket-auto-test-user';
const TEST_BOOKING_ID = 'codex-e2e-ticket-auto-test-booking';
const ticketRef = db.collection('tickets').doc(TEST_USER_ID);
const bookingRef = db.collection('bookings').doc(TEST_BOOKING_ID);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const todayJst = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

function runScheduler() {
  execFileSync('gcloud', [
    'scheduler', 'jobs', 'run', JOB,
    '--location', REGION,
    '--project', PROJECT,
    '--quiet',
  ], { stdio: 'inherit' });
}

async function readResult() {
  const [ticket, booking] = await Promise.all([ticketRef.get(), bookingRef.get()]);
  return {
    balance: ticket.data()?.tickets?.['45'],
    attended: booking.data()?.attended,
  };
}

async function cleanup() {
  await Promise.all([ticketRef.delete(), bookingRef.delete()]);
}

async function main() {
  console.log('テストデータを作成します（実在のお客様データは使用しません）。');
  await cleanup();
  await ticketRef.set({ name: '自動消費テスト', tickets: { 45: 2, 60: 0 } });
  await bookingRef.set({
    bookingId: TEST_BOOKING_ID,
    userId: TEST_USER_ID,
    customerName: '自動消費テスト',
    dateStr: todayJst(),
    startTime: '00:00',
    endTime: '00:45',
    durationMinutes: 45,
    status: 'confirmed',
    attended: false,
    source: 'e2e-test',
  });

  console.log('自動消費処理を実行します。');
  runScheduler();

  let result;
  for (let i = 0; i < 30; i += 1) {
    await sleep(2000);
    result = await readResult();
    if (result.balance === 1 && result.attended === true) break;
  }
  if (result.balance !== 1 || result.attended !== true) {
    throw new Error(`自動消費を確認できませんでした: ${JSON.stringify(result)}`);
  }

  console.log('1回目: 45分チケットが2枚から1枚へ減りました。');
  console.log('二重消費防止を確認します。');
  runScheduler();
  await sleep(5000);
  result = await readResult();
  if (result.balance !== 1 || result.attended !== true) {
    throw new Error(`二重消費が発生した可能性があります: ${JSON.stringify(result)}`);
  }
  console.log('2回目: 残数は1枚のままです（二重消費なし）。');
  console.log('チケット自動消費テスト: 合格');
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    await cleanup();
    console.log('テストデータを削除しました。');
  });

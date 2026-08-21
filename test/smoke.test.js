const test = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('dayjs');

const config = require('../src/config');
const calendar = require('../src/calendarService');
const shifts = require('../src/shiftSchedule');
const messages = require('../src/lineService');
const { app } = require('../src/index');
const platinum = require('../src/platinumMembers');
const { getSeasonalGreeting } = require('../src/seasonalGreeting');
const { isMonthlyBookingReleased, monthlyBookingMaxDate } = require('../src/bookingRelease');
const { createWebBookingToken, verifyWebBookingToken } = require('../src/webBookingToken');
const { normalizeCustomerName, isPairCustomerName } = require('../src/customerStore');

test('required configuration and staff IDs are valid', () => {
  assert.ok(config.line.channelAccessToken);
  assert.ok(config.line.channelSecret);
  assert.ok(config.google.serviceAccountKeyBase64);
  assert.deepEqual(config.staff.map((staff) => staff.id), ['narita', 'furuya', 'ando']);
  const key = JSON.parse(Buffer.from(config.google.serviceAccountKeyBase64, 'base64').toString('utf8'));
  assert.equal(key.type, 'service_account');
  assert.ok(key.client_email);
  assert.ok(key.private_key);
});

test('shift lookup recognizes closing day and split shifts', () => {
  const tuesday = shifts.getShiftsForDate('jiyugaoka', '2026-08-11');
  assert.equal(tuesday.closed, true);
  const wednesday = shifts.getShiftsForDate('jiyugaoka', '2026-08-12');
  const grouped = shifts.groupShiftsByStaff(wednesday.shifts);
  assert.equal(grouped[0].staffId, 'narita');
  assert.equal(grouped[0].blocks.length, 2);
});

test('Furuya Sunday shifts switch stores at the configured times', () => {
  const sunday = '2026-08-16';
  assert.deepEqual(shifts.getShiftsForDate('jiyugaoka', sunday).shifts, [
    { staffId: 'furuya', start: '09:00', end: '17:00' },
  ]);
  assert.ok(shifts.getShiftsForDate('motosumiyoshi', sunday).shifts.some((shift) =>
    shift.staffId === 'furuya' && shift.start === '18:00' && shift.end === '20:00'
  ));
});

test('platinum members are recognized despite honorifics, spaces, or pair suffix', () => {
  assert.equal(platinum.PLATINUM_MEMBER_NAMES.length, 32);
  assert.equal(platinum.isPlatinumMemberName('吉原 教一郎様'), true);
  assert.equal(platinum.isPlatinumMemberName('西木俊一 ペア'), true);
  assert.equal(platinum.isPlatinumMemberName('山田太郎'), false);
  assert.equal(config.booking.platinumNextMonthOpenDay, 18);
});

test('seasonal reservation greetings cover every month', () => {
  for (let month = 1; month <= 12; month += 1) {
    assert.ok(getSeasonalGreeting(month));
  }
});

test('next-month booking release starts at 10:00 on the configured day', () => {
  assert.equal(isMonthlyBookingReleased(dayjs('2026-08-18T09:59:00'), 18, 10), false);
  assert.equal(isMonthlyBookingReleased(dayjs('2026-08-18T10:00:00'), 18, 10), true);
  assert.equal(isMonthlyBookingReleased(dayjs('2026-08-25T09:59:00'), 25, 10), false);
  assert.equal(isMonthlyBookingReleased(dayjs('2026-08-25T10:00:00'), 25, 10), true);
});

test('released monthly members can reserve through the end of next month', () => {
  assert.equal(
    monthlyBookingMaxDate(dayjs('2026-08-18T09:59:00'), 18, 10, '2026-09-17'),
    '2026-08-31'
  );
  assert.equal(
    monthlyBookingMaxDate(dayjs('2026-08-18T10:00:00'), 18, 10, '2026-09-17'),
    '2026-09-30'
  );
  assert.equal(
    monthlyBookingMaxDate(dayjs('2026-12-25T10:00:00'), 25, 10, '2027-01-24'),
    '2027-01-31'
  );
});

test('web booking links securely preserve the existing LINE user ID', () => {
  const token = createWebBookingToken('U-test-customer', 60);
  assert.equal(verifyWebBookingToken(token).userId, 'U-test-customer');
  assert.equal(verifyWebBookingToken(`${token}broken`), null);
});

test('customer linking rejects pasted documents instead of names', () => {
  assert.equal(normalizeCustomerName('山田 太郎様'), '山田 太郎');
  assert.throws(() => normalizeCustomerName('議事録\n長い本文'), /フルネーム/);
  assert.throws(() => normalizeCustomerName('あ'.repeat(41)), /フルネーム/);
});

test('pair recognition only accepts pair as the customer-name suffix', () => {
  assert.equal(isPairCustomerName('山田太郎 ペア'), true);
  assert.equal(isPairCustomerName('ペア予約についての長い文章'), false);
});

test('bookable slots do not overlap a busy gap', () => {
  const free = [
    { start: dayjs('2026-08-12T09:00:00+09:00'), end: dayjs('2026-08-12T11:00:00+09:00') },
    { start: dayjs('2026-08-12T12:00:00+09:00'), end: dayjs('2026-08-12T14:00:00+09:00') },
  ];
  const result = calendar.getBookableStartTimes(free, 60);
  assert.deepEqual(result.map((slot) => slot.start.format('HH:mm')), ['09:00', '10:00', '12:00', '13:00']);
});

test('LINE menu builders produce valid message objects', () => {
  const main = messages.buildMainMenuMessage();
  const stores = messages.buildStoreSelectionMessage();
  const ticket = messages.buildTicketBalanceMessage({ 45: 2, 60: 1 });
  for (const message of [main, stores, ticket]) {
    assert.ok(message && typeof message === 'object');
    assert.ok(message.type);
  }
  const memberMenu = messages.buildMemberMenuMessage('ビジター', null);
  assert.ok(memberMenu.quickReply.items.some((item) => item.action.label === '顧客紐付け'));
  const adminMenu = messages.buildAdminMemberManagementMessage();
  assert.deepEqual(adminMenu.quickReply.items.map((item) => item.action.label), [
    'チケット付与',
    '月会費コース変更',
    'プラチナ昇格',
    'プラチナ解除',
  ]);
  const confirmed = messages.buildBookingConfirmedMessage(
    '自由が丘店', '成田', '2026-08-12', '10:00', '11:00', '山田太郎'
  );
  const calendarAction = confirmed.contents.footer.contents[0].action;
  assert.equal(calendarAction.type, 'uri');
  assert.match(calendarAction.uri, /^https:\/\/calendar\.google\.com\/calendar\/render\?/);
  const bookingList = messages.buildBookingListMessage([{
    bookingId: 'booking-1', storeName: '自由が丘店', staffName: '成田',
    dateStr: '2099-08-12', startTime: '10:00', endTime: '11:00',
  }], '2099-08-01', 'https://example.com/booking/?changeBookingId=');
  const changeAction = bookingList.contents.contents[0].footer.contents[0].action;
  assert.equal(changeAction.type, 'uri');
  assert.equal(changeAction.uri, 'https://example.com/booking/?changeBookingId=booking-1');
});

test('main menu uses the customer-facing reservation tab labels', () => {
  const menu = messages.buildMainMenuMessage('https://example.com/booking');
  assert.deepEqual(menu.quickReply.items.map((item) => item.action.label), [
    '予約する',
    '予約確認・変更',
    '会員種別',
  ]);
});

test('HTTP health, webhook, and ticket automation routes are registered', () => {
  const routes = app._router.stack
    .filter((layer) => layer.route)
    .map((layer) => ({ path: layer.route.path, methods: layer.route.methods }));
  assert.ok(routes.some((route) => route.path === '/' && route.methods.get));
  assert.ok(routes.some((route) => route.path === '/webhook' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/tasks/consume-due-tickets' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/tasks/send-monthly-reservation-reminder' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/bootstrap' && route.methods.get));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/availability' && route.methods.get));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/week-availability' && route.methods.get));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/book' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/change' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/api/trial/bootstrap' && route.methods.get));
  assert.ok(routes.some((route) => route.path === '/api/trial/checkout' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/webhooks/square' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/tasks/cleanup-trial-holds' && route.methods.post));
});

test('Firestore stores expose asynchronous persistence APIs', () => {
  for (const name of ['bookingStore', 'ticketStore', 'memberStore', 'customerStore', 'platinumMemberStore', 'reservationReminderStore', 'trialBookingStore']) {
    const store = require(`../src/${name}`);
    assert.ok(Object.values(store).some((value) => typeof value === 'function'));
  }
});

test('platinum store supports explicit promotion and demotion overrides', () => {
  const store = require('../src/platinumMemberStore');
  assert.equal(typeof store.register, 'function');
  assert.equal(typeof store.unregister, 'function');
  assert.equal(typeof store.getStatus, 'function');
});

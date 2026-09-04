const test = require('node:test');
const assert = require('node:assert/strict');
const dayjs = require('dayjs');

const config = require('../src/config');
const calendar = require('../src/calendarService');
const shifts = require('../src/shiftSchedule');
const messages = require('../src/lineService');
const { app, isCustomerLinkPendingActive } = require('../src/index');
const platinum = require('../src/platinumMembers');
const { getSeasonalGreeting } = require('../src/seasonalGreeting');
const { isMonthlyBookingReleased, monthlyBookingMaxDate, bookingCalendarMaxDate, ticketBookingMaxDate } = require('../src/bookingRelease');
const { createWebBookingToken, verifyWebBookingToken } = require('../src/webBookingToken');
const { normalizeCustomerName, isPairCustomerName, pairLinkKey } = require('../src/customerStore');
const { selectTicketDuration } = require('../src/ticketStore');
const { selectUsage } = require('../src/bookingEntitlement');
const { normalizeMatchText, eventMatchesCustomerName } = require('../src/externalBookingMatcher');

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

test('direct calendar bookings resolve the store using the appointment time', () => {
  assert.equal(shifts.getStoreForStaffAtTime('narita', '2026-09-18', '15:00').id, 'jiyugaoka');
  assert.equal(shifts.getStoreForStaffAtTime('narita', '2026-09-18', '18:00').id, 'motosumiyoshi');
  assert.equal(shifts.getStoreForStaffAtTime('furuya', '2026-09-20', '16:00').id, 'jiyugaoka');
  assert.equal(shifts.getStoreForStaffAtTime('furuya', '2026-09-20', '18:00').id, 'motosumiyoshi');
});

test('direct ticket sync matches customer names despite spaces and honorifics', () => {
  const timedEvent = {
    summary: '中野 響子様 パーソナルトレーニング',
    start: { dateTime: '2026-08-31T21:00:00+09:00' },
    end: { dateTime: '2026-08-31T21:45:00+09:00' },
  };
  assert.equal(normalizeMatchText('中野 響子様'), '中野響子');
  assert.equal(eventMatchesCustomerName(timedEvent, '中野響子'), true);
  assert.equal(eventMatchesCustomerName(timedEvent, '東野淑恵'), false);
  assert.equal(eventMatchesCustomerName({ summary: '中野響子', start: { date: '2026-08-31' } }, '中野響子'), false);
});

test('pair bookings on a staff calendar only block the store where that staff is working', () => {
  const furuya = config.staff.find((staff) => staff.id === 'furuya');
  const morningEvent = { start: { dateTime: '2026-09-20T09:00:00+09:00' } };
  const eveningEvent = { start: { dateTime: '2026-09-20T18:00:00+09:00' } };
  assert.equal(calendar.pairEventBelongsToStore(furuya.calendarId, morningEvent, 'jiyugaoka'), true);
  assert.equal(calendar.pairEventBelongsToStore(furuya.calendarId, morningEvent, 'motosumiyoshi'), false);
  assert.equal(calendar.pairEventBelongsToStore(furuya.calendarId, eveningEvent, 'motosumiyoshi'), true);
  const exceptionalEvent = {
    start: { dateTime: '2026-09-06T17:00:00+09:00' },
    description: '店舗: 自由が丘店',
  };
  assert.equal(calendar.pairEventBelongsToStore(furuya.calendarId, exceptionalEvent, 'jiyugaoka'), true);
  assert.equal(calendar.pairEventBelongsToStore(furuya.calendarId, exceptionalEvent, 'motosumiyoshi'), false);
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

test('standard booking calendar is not limited to 30 days and ends next month', () => {
  assert.equal(bookingCalendarMaxDate(dayjs('2026-08-22T10:00:00')), '2026-09-30');
  assert.equal(bookingCalendarMaxDate(dayjs('2026-01-31T10:00:00')), '2026-02-28');
});

test('ticket bookings remain available for 90 days', () => {
  assert.equal(ticketBookingMaxDate(dayjs('2026-08-29T10:00:00'), 90), '2026-11-27');
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

test('customer-link name input expires after ten minutes', () => {
  assert.equal(isCustomerLinkPendingActive({ createdAt: Date.now() - 9 * 60 * 1000 }), true);
  assert.equal(isCustomerLinkPendingActive({ createdAt: Date.now() - 11 * 60 * 1000 }), false);
});

test('pair recognition only accepts pair as the customer-name suffix', () => {
  assert.equal(isPairCustomerName('山田太郎 ペア'), true);
  assert.equal(isPairCustomerName('ペア予約についての長い文章'), false);
  assert.equal(pairLinkKey('三島 塩見 ペア'), '三島塩見ペア');
  assert.equal(pairLinkKey('三島塩見'), null);
});

test('ticket consumption follows the customer ticket type for direct calendar bookings', () => {
  assert.equal(selectTicketDuration({ 45: 4, 60: 0 }, 60), 45);
  assert.equal(selectTicketDuration({ 45: 0, 60: 4 }, 45), 60);
  assert.equal(selectTicketDuration({ 45: 2, 60: 3 }, 60), 60);
});

test('monthly members use their monthly quota before additional tickets', () => {
  assert.deepEqual(selectUsage({
    monthlyMember: true, monthlyQuota: 4, monthlyUsed: 3,
    ticketCustomer: true, ticketBalance: 5, ticketOutstanding: 0,
  }), { available: true, usageType: 'membership' });
  assert.deepEqual(selectUsage({
    monthlyMember: true, monthlyQuota: 4, monthlyUsed: 4,
    ticketCustomer: true, ticketBalance: 5, ticketOutstanding: 0,
  }), { available: true, usageType: 'ticket' });
  assert.deepEqual(selectUsage({
    monthlyMember: true, monthlyQuota: 4, monthlyUsed: 4,
    ticketCustomer: true, ticketBalance: 5, ticketOutstanding: 5,
  }), { available: false, usageType: null });
  assert.deepEqual(selectUsage({
    monthlyMember: true, monthlyQuota: 4, monthlyUsed: 0,
    ticketCustomer: true, ticketBalance: 5, ticketOutstanding: 1, ticketOnly: true,
  }), { available: true, usageType: 'ticket' });
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
    'チケットコントロール',
    '月会費コース変更',
    'プラチナ昇格',
    'チケット残数一覧',
  ]);
  const ticketControl = messages.buildAdminTicketControlMessage();
  assert.deepEqual(ticketControl.quickReply.items.map((item) => item.action.label), ['プラス', 'マイナス']);
  assert.match(messages.buildAdminAskTicketCustomerMessage('subtract').text, /マイナス/);
  const countSelection = messages.buildAdminTicketCountSelectionMessage('subtract', 45, 7);
  assert.deepEqual(countSelection.quickReply.items.map((item) => item.action.label), [
    '1枚', '2枚', '3枚', '4枚', '5枚', '6枚', '7枚', '8枚', '9枚', '10枚',
  ]);
  assert.match(countSelection.text, /45分チケット（現在7枚）/);
  assert.match(messages.buildAdminTicketSubtractedMessage('Utest', 45, 5, 3, 0).text, /3枚マイナス/);
  const balanceList = messages.buildAdminTicketBalanceListMessages([
    { name: '山田太郎', tickets: { 45: 2, 60: 0 } },
    { name: '佐藤花子', tickets: { 45: 0, 60: 0 } },
  ]);
  assert.equal(balanceList.length, 1);
  assert.match(balanceList[0].text, /山田太郎：45分 2枚/);
  assert.match(balanceList[0].text, /佐藤花子：残数 0枚/);
  const unnamedBalanceList = messages.buildAdminTicketBalanceListMessages([
    { userId: 'U1234567890abcdef', name: '(名前未登録)', tickets: { 45: 0, 60: 0 } },
  ]);
  assert.match(unnamedBalanceList[0].text, /名前未登録・ID末尾cdef/);
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
  assert.ok(routes.some((route) => route.path === '/tasks/sync-direct-ticket-bookings' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/tasks/consume-due-tickets' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/tasks/send-monthly-reservation-reminder' && route.methods.post));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/bootstrap' && route.methods.get));
  assert.ok(routes.some((route) => route.path === '/api/web-booking/sync-external' && route.methods.post));
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
  for (const name of ['bookingStore', 'ticketStore', 'memberStore', 'customerStore', 'pairStore', 'platinumMemberStore', 'reservationReminderStore', 'trialBookingStore']) {
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

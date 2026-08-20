const dayjs = require('dayjs');
const config = require('./config');
const { STORES, STAFF_PHOTOS, getStore, getShiftsForDate, groupShiftsByStaff } = require('./shiftSchedule');
const { getAvailableSlots, getBookableStartTimes, createBooking, hasFullDayBlock } = require('./calendarService');
const bookingStore = require('./bookingStore');
const customerStore = require('./customerStore');
const memberStore = require('./memberStore');
const ticketStore = require('./ticketStore');
const platinumMemberStore = require('./platinumMemberStore');
const { isPlatinumMemberName } = require('./platinumMembers');
const { monthlyBookingMaxDate } = require('./bookingRelease');
const { normalizeCustomerName } = require('./customerStore');

function findStaff(id) { return config.staff.find((staff) => staff.id === id); }
function pairName(name) { return customerStore.isPairCustomerName(name); }
function storeCalendarIds(storeId, dateStr) {
  return [...new Set(getShiftsForDate(storeId, dateStr).shifts.map((s) => findStaff(s.staffId)?.calendarId).filter(Boolean))];
}
async function isMember(userId) {
  return config.members.some((m) => m.lineUserId === userId) || memberStore.isMember(userId);
}
async function isPlatinum(userId) {
  const configured = config.members.find((m) => m.lineUserId === userId)?.name;
  const names = [configured, await customerStore.getName(userId), await memberStore.getName(userId), ...await bookingStore.getDistinctCustomerNames(userId)].filter(Boolean);
  for (const name of names) {
    const status = await platinumMemberStore.getStatus(name);
    if (status !== null) return status;
  }
  return names.some(isPlatinumMemberName);
}
async function maxDate(userId) {
  const now = dayjs().tz(config.business.timezone);
  const normalMax = now.add(config.business.maxDaysAhead, 'day').format('YYYY-MM-DD');
  if (!await isMember(userId)) return normalMax;
  const openDay = await isPlatinum(userId) ? config.booking.platinumNextMonthOpenDay : config.booking.memberNextMonthOpenDay;
  return monthlyBookingMaxDate(now, openDay, config.booking.memberNextMonthOpenHour, normalMax);
}
async function durationFor(userId) {
  if (await ticketStore.isTicketCustomer(userId)) {
    const balances = await ticketStore.getBalances(userId);
    if (balances[45] > 0) return 45;
    if (balances[60] > 0) return 60;
    throw new Error('チケットの残数がありません。');
  }
  return await memberStore.getSessionDuration(userId) || config.booking.durationMinutes;
}
async function bootstrap(userId) {
  const name = await customerStore.getName(userId);
  if (!name) throw new Error('先にLINEメニューの「会員種別・紐付け」から、お名前を登録してください。');
  try { normalizeCustomerName(name); }
  catch { throw new Error('顧客名が正しくありません。LINEメニューの「会員種別・紐付け」からフルネームを再登録してください。'); }
  const member = await isMember(userId);
  const platinum = member && await isPlatinum(userId);
  const ticketCustomer = !member && await ticketStore.isTicketCustomer(userId);
  const durationMinutes = await durationFor(userId);
  let membershipDetail = '';
  let bookingAllowance = { type: 'unlimited' };
  if (member) {
    const quota = await memberStore.getMonthlyQuota(userId);
    if (quota > 0) membershipDetail = `${durationMinutes}分×${quota}回`;
    const minDate = dayjs().tz(config.business.timezone).add(1, 'day');
    const maximumDate = dayjs(await maxDate(userId));
    const months = [];
    for (let month = minDate.startOf('month'); !month.isAfter(maximumDate, 'month'); month = month.add(1, 'month')) {
      months.push(month.format('YYYY-MM'));
    }
    const usedByMonth = Object.fromEntries(await Promise.all(months.map(async (month) => [month, await bookingStore.getMonthlyBookingCount(userId, month)])));
    bookingAllowance = { type: 'monthly', quota, usedByMonth };
  } else if (ticketCustomer) {
    const balance = await ticketStore.getBalance(userId, durationMinutes);
    membershipDetail = `${durationMinutes}分×${balance}回`;
    const outstanding = await bookingStore.getOutstandingCount(userId, durationMinutes);
    bookingAllowance = { type: 'ticket', remaining: Math.max(0, balance - outstanding) };
  }
  return {
    customer: {
      name,
      memberType: platinum ? 'プラチナ会員' : member ? '月会費会員' : ticketCustomer ? 'チケット会員' : 'ビジター',
      membershipDetail,
    },
    stores: STORES,
    minDate: dayjs().tz(config.business.timezone).add(1, 'day').format('YYYY-MM-DD'),
    maxDate: await maxDate(userId),
    durationMinutes,
    bookingAllowance,
    businessHours: { start: config.business.startHour, end: config.business.endHour },
  };
}
async function availability(userId, storeId, dateStr, suppliedInfo = null) {
  const store = getStore(storeId);
  if (!store) throw new Error('店舗が見つかりません。');
  const info = suppliedInfo || await bootstrap(userId);
  if (dateStr < info.minDate || dateStr > info.maxDate) throw new Error('この日付はまだ予約できません。');
  const { closed, shifts } = getShiftsForDate(storeId, dateStr);
  if (closed) return { closed: true, staff: [] };
  const customerName = info.customer.name;
  const calendars = storeCalendarIds(storeId, dateStr);
  const staffRows = [];
  for (const group of groupShiftsByStaff(shifts)) {
    const staff = findStaff(group.staffId);
    if (!staff || await hasFullDayBlock(staff.calendarId, dateStr, config.booking.fullDayBlockKeyword)) continue;
    let slots = [];
    for (const block of group.blocks) {
      const free = await getAvailableSlots(dateStr, staff.calendarId, block.start, block.end,
        pairName(customerName) ? { allCalendarIds: calendars } : { allCalendarIds: [staff.calendarId], pairCalendarIds: calendars });
      slots.push(...getBookableStartTimes(free, info.durationMinutes));
    }
    const unique = [...new Map(slots.map((s) => [s.start.format('HH:mm'), { start: s.start.format('HH:mm'), end: s.end.format('HH:mm') }])).values()];
    staffRows.push({
      id: staff.id,
      name: staff.name,
      photoUrl: STAFF_PHOTOS[staff.id] || null,
      blocks: group.blocks.map((block) => ({
        start: block.start || `${String(config.business.startHour).padStart(2, '0')}:00`,
        end: block.end || `${String(config.business.endHour).padStart(2, '0')}:00`,
      })),
      slots: unique,
    });
  }
  return { closed: false, staff: staffRows };
}

async function weekAvailability(userId, storeId, startDateStr) {
  const info = await bootstrap(userId);
  const dates = [...Array(7)].map((_, index) => dayjs(startDateStr).add(index, 'day').format('YYYY-MM-DD'));
  const results = await Promise.all(dates.map(async (dateStr) => {
    try {
      return { dateStr, ...(await availability(userId, storeId, dateStr, info)) };
    } catch (error) {
      return { dateStr, closed: true, staff: [], error: error.message };
    }
  }));
  return { dates: results };
}
async function book(userId, input) {
  const store = getStore(input.storeId);
  const staff = findStaff(input.staffId);
  const info = await bootstrap(userId);
  if (!store || !staff) throw new Error('店舗またはトレーナーが見つかりません。');
  const current = await availability(userId, input.storeId, input.dateStr);
  const row = current.staff.find((s) => s.id === input.staffId);
  const slot = row?.slots.find((s) => s.start === input.startTime && s.end === input.endTime);
  if (!slot) throw new Error('選択中にこの時間が埋まりました。別の時間を選んでください。');
  const duration = info.durationMinutes;
  if (await ticketStore.isTicketCustomer(userId)) {
    const balance = await ticketStore.getBalance(userId, duration);
    if (await bookingStore.getOutstandingCount(userId, duration) >= balance) throw new Error('チケット残数を超える予約はできません。');
  }
  if (await isMember(userId)) {
    const quota = await memberStore.getMonthlyQuota(userId);
    if (await bookingStore.getMonthlyBookingCount(userId, input.dateStr.slice(0, 7)) >= quota) throw new Error(`月の予約上限（${quota}回）に達しています。`);
  }
  const event = await createBooking({
    dateStr: input.dateStr, startTime: input.startTime, endTime: input.endTime, calendarId: staff.calendarId,
    summary: `${info.customer.name}様`,
    description: `Web予約画面からの自動登録\nお名前: ${info.customer.name}様\n店舗: ${store.name}`,
  });
  const bookingId = await bookingStore.addBooking({
    userId, storeId: store.id, storeName: store.name, staffId: staff.id, staffName: staff.name,
    calendarId: staff.calendarId, eventId: event.id, dateStr: input.dateStr,
    startTime: input.startTime, endTime: input.endTime, durationMinutes: duration, customerName: info.customer.name,
  });
  return { bookingId, storeName: store.name, staffName: staff.name, customerName: info.customer.name, dateStr: input.dateStr, startTime: input.startTime, endTime: input.endTime };
}

module.exports = { bootstrap, availability, weekAvailability, book };

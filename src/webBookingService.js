const dayjs = require('dayjs');
const config = require('./config');
const { STORES, STAFF_PHOTOS, getStore, getShiftsForDate, groupShiftsByStaff } = require('./shiftSchedule');
const { getAvailableSlots, getBookableStartTimes, createBooking, deleteBooking, hasFullDayBlock, clearCalendarCache, loadCalendarWindow } = require('./calendarService');
const bookingStore = require('./bookingStore');
const customerStore = require('./customerStore');
const memberStore = require('./memberStore');
const ticketStore = require('./ticketStore');
const platinumMemberStore = require('./platinumMemberStore');
const pairStore = require('./pairStore');
const { isPlatinumMemberName } = require('./platinumMembers');
const { monthlyBookingMaxDate, bookingCalendarMaxDate, ticketBookingMaxDate } = require('./bookingRelease');
const { normalizeCustomerName } = require('./customerStore');
const { resolveBookingUsage } = require('./bookingEntitlement');

const BOOTSTRAP_CACHE_MS = 15 * 1000;
const bootstrapCache = new Map();

function clearBootstrapCache(userId) {
  for (const key of bootstrapCache.keys()) {
    if (key.startsWith(`${userId}:`)) bootstrapCache.delete(key);
  }
}

function findStaff(id) { return config.staff.find((staff) => staff.id === id); }
function pairName(name) { return customerStore.isPairCustomerName(name); }
function minutes(value, fallback) {
  const [hour, minute] = String(value || fallback).split(':').map(Number);
  return hour * 60 + minute;
}
function storeCalendarIds(storeId, dateStr, start = null, end = null) {
  const shifts = getShiftsForDate(storeId, dateStr).shifts.filter((shift) => {
    if (!start || !end) return true;
    return minutes(shift.start, `${config.business.startHour}:00`) < minutes(end)
      && minutes(shift.end, `${config.business.endHour}:00`) > minutes(start);
  });
  return [...new Set(shifts.map((s) => findStaff(s.staffId)?.calendarId).filter(Boolean))];
}
async function isMember(userId) {
  return config.members.some((m) => m.lineUserId === userId) || memberStore.isMember(userId);
}
async function isPlatinum(userId) {
  const configured = config.members.find((m) => m.lineUserId === userId)?.name;
  const names = [configured, await pairStore.getName(userId), await customerStore.getName(userId), await memberStore.getName(userId), ...await bookingStore.getDistinctCustomerNames(userId)].filter(Boolean);
  for (const name of names) {
    const status = await platinumMemberStore.getStatus(name);
    if (status !== null) return status;
  }
  return names.some(isPlatinumMemberName);
}
async function monthlyMaxDate(userId, monthlyMember, now) {
  const normalMax = bookingCalendarMaxDate(now);
  if (!monthlyMember) return normalMax;
  const openDay = await isPlatinum(userId) ? config.booking.platinumNextMonthOpenDay : config.booking.memberNextMonthOpenDay;
  return monthlyBookingMaxDate(now, openDay, config.booking.memberNextMonthOpenHour, normalMax);
}
function ticketMaxDate(now) {
  return ticketBookingMaxDate(now, config.business.ticketMaxDaysAhead);
}
async function durationFor(userId, monthlyMember = false) {
  if (monthlyMember) {
    return await memberStore.getSessionDuration(userId) || config.booking.durationMinutes;
  }
  if (await ticketStore.isTicketCustomer(userId)) {
    const balances = await ticketStore.getBalances(userId);
    if (balances[45] > 0) return 45;
    if (balances[60] > 0) return 60;
    throw new Error('チケットの残数がありません。');
  }
  return await memberStore.getSessionDuration(userId) || config.booking.durationMinutes;
}
async function buildBootstrap(userId, changeBookingId = null) {
  const name = await pairStore.getName(userId) || await customerStore.getName(userId);
  if (!name) throw new Error('先にLINEメニューの「会員種別・紐付け」から、お名前を登録してください。');
  try { normalizeCustomerName(name); }
  catch { throw new Error('顧客名が正しくありません。LINEメニューの「会員種別・紐付け」からフルネームを再登録してください。'); }
  const member = await isMember(userId);
  const platinum = member && await isPlatinum(userId);
  const ticketCustomer = await ticketStore.isTicketCustomer(userId);
  const durationMinutes = await durationFor(userId, member);
  const now = dayjs().tz(config.business.timezone);
  const monthlyMaxDateStr = await monthlyMaxDate(userId, member, now);
  let membershipDetail = '';
  let bookingAllowance = { type: 'unlimited' };
  let maximumDate = monthlyMaxDateStr;
  if (member) {
    const quota = await memberStore.getMonthlyQuota(userId);
    const ticketBalance = await ticketStore.getBalance(userId, durationMinutes);
    const ticketOutstanding = await bookingStore.getOutstandingTicketBookingCount(userId, durationMinutes, changeBookingId);
    if (quota > 0) membershipDetail = `${durationMinutes}分×${quota}回${ticketBalance > 0 ? ` / 追加チケット${ticketBalance}枚` : ''}`;
    const ticketRemaining = Math.max(0, ticketBalance - ticketOutstanding);
    if (ticketRemaining > 0) maximumDate = [maximumDate, ticketMaxDate(now)].sort().at(-1);
    const minDate = now.add(1, 'day');
    const monthlyMaximumDate = dayjs(monthlyMaxDateStr);
    const months = [];
    for (let month = minDate.startOf('month'); !month.isAfter(monthlyMaximumDate, 'month'); month = month.add(1, 'month')) {
      months.push(month.format('YYYY-MM'));
    }
    const usedByMonth = Object.fromEntries(await Promise.all(months.map(async (month) => [month, await bookingStore.getMonthlyMembershipBookingCount(userId, month, changeBookingId)])));
    bookingAllowance = {
      type: 'monthly',
      quota,
      usedByMonth,
      ticketRemaining,
      monthlyMaxDate: monthlyMaxDateStr,
    };
  } else if (ticketCustomer) {
    const balance = await ticketStore.getBalance(userId, durationMinutes);
    membershipDetail = `${durationMinutes}分×${balance}回`;
    const outstanding = await bookingStore.getOutstandingCount(userId, durationMinutes, changeBookingId);
    bookingAllowance = { type: 'ticket', remaining: Math.max(0, balance - outstanding) };
    if (bookingAllowance.remaining > 0) maximumDate = [maximumDate, ticketMaxDate(now)].sort().at(-1);
  }
  let changeBooking = null;
  if (changeBookingId) {
    changeBooking = await bookingStore.getBooking(changeBookingId);
    if (!changeBooking || !await pairStore.sameAccount(changeBooking.userId, userId) || changeBooking.status !== 'confirmed') throw new Error('変更する予約が見つかりません。');
    if (changeBooking.dateStr <= dayjs().tz(config.business.timezone).format('YYYY-MM-DD')) throw new Error('当日の予約はWEBから変更できません。店舗へご連絡ください。');
  }
  return {
    customer: {
      name,
      memberType: platinum ? 'プラチナ会員' : member ? '月会費会員' : ticketCustomer ? 'チケット会員' : 'ビジター',
      membershipDetail,
    },
    stores: STORES,
    minDate: now.add(1, 'day').format('YYYY-MM-DD'),
    maxDate: maximumDate,
    durationMinutes,
    bookingAllowance,
    businessHours: { start: config.business.startHour, end: config.business.endHour },
    changeBooking: changeBooking ? {
      bookingId: changeBooking.bookingId,
      storeName: changeBooking.storeName,
      staffName: changeBooking.staffName,
      dateStr: changeBooking.dateStr,
      startTime: changeBooking.startTime,
      endTime: changeBooking.endTime,
    } : null,
  };
}
async function bootstrap(userId, changeBookingId = null) {
  const key = `${userId}:${changeBookingId || ''}`;
  const now = Date.now();
  const existing = bootstrapCache.get(key);
  if (existing && existing.expiresAt > now) return existing.promise;
  const promise = buildBootstrap(userId, changeBookingId).catch((error) => {
    bootstrapCache.delete(key);
    throw error;
  });
  bootstrapCache.set(key, { promise, expiresAt: now + BOOTSTRAP_CACHE_MS });
  return promise;
}
async function availability(userId, storeId, dateStr, suppliedInfo = null, changeBookingId = null, calendarWindow = null) {
  const store = getStore(storeId);
  if (!store) throw new Error('店舗が見つかりません。');
  const info = suppliedInfo || await bootstrap(userId, changeBookingId);
  if (dateStr < info.minDate || dateStr > info.maxDate) throw new Error('この日付はまだ予約できません。');
  const { closed, shifts } = getShiftsForDate(storeId, dateStr);
  if (closed) return { closed: true, staff: [] };
  const customerName = info.customer.name;
  const calendars = storeCalendarIds(storeId, dateStr);
  const staffRows = [];
  for (const group of groupShiftsByStaff(shifts)) {
    const staff = findStaff(group.staffId);
    if (!staff || await hasFullDayBlock(staff.calendarId, dateStr, config.booking.fullDayBlockKeyword, calendarWindow)) continue;
    let slots = [];
    for (const block of group.blocks) {
      const free = await getAvailableSlots(dateStr, staff.calendarId, block.start, block.end,
        pairName(customerName)
          ? { allCalendarIds: storeCalendarIds(storeId, dateStr, block.start, block.end), window: calendarWindow }
          : { allCalendarIds: [staff.calendarId], pairCalendarIds: calendars, targetStoreId: storeId, window: calendarWindow });
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

async function weekAvailability(userId, storeId, startDateStr, changeBookingId = null) {
  const dates = [...Array(7)].map((_, index) => dayjs(startDateStr).add(index, 'day').format('YYYY-MM-DD'));
  const calendarIds = [...new Set(dates.flatMap((dateStr) => storeCalendarIds(storeId, dateStr)))];
  const [info, calendarWindow] = await Promise.all([
    bootstrap(userId, changeBookingId),
    loadCalendarWindow(dates[0], dates[dates.length - 1], calendarIds),
  ]);
  const results = await Promise.all(dates.map(async (dateStr) => {
    try {
      return { dateStr, ...(await availability(userId, storeId, dateStr, info, changeBookingId, calendarWindow)) };
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
  clearCalendarCache();
  const current = await availability(userId, input.storeId, input.dateStr);
  const row = current.staff.find((s) => s.id === input.staffId);
  const slot = row?.slots.find((s) => s.start === input.startTime && s.end === input.endTime);
  if (!slot) throw new Error('選択中にこの時間が埋まりました。別の時間を選んでください。');
  const duration = info.durationMinutes;
  const ticketOnly = info.bookingAllowance.type === 'monthly' && input.dateStr > info.bookingAllowance.monthlyMaxDate;
  const entitlement = await resolveBookingUsage(userId, input.dateStr, duration, null, { ticketOnly });
  if (!entitlement.available) {
    throw new Error(entitlement.monthlyMember
      ? '月会費の予約枠と追加チケットの残数を超えるため、予約できません。'
      : 'チケット残数を超える予約はできません。');
  }
  const event = await createBooking({
    dateStr: input.dateStr, startTime: input.startTime, endTime: input.endTime, calendarId: staff.calendarId,
    summary: `${info.customer.name}様`,
    description: `Web予約画面からの自動登録\nお名前: ${info.customer.name}様\n店舗: ${store.name}\n利用: ${entitlement.usageType === 'ticket' ? '追加チケット' : entitlement.usageType === 'membership' ? '月会費' : '通常'}`,
  });
  const bookingId = await bookingStore.addBooking({
    userId, storeId: store.id, storeName: store.name, staffId: staff.id, staffName: staff.name,
    calendarId: staff.calendarId, eventId: event.id, dateStr: input.dateStr,
    startTime: input.startTime, endTime: input.endTime, durationMinutes: duration, customerName: info.customer.name,
    usageType: entitlement.usageType,
    ticketLocked: entitlement.ticketLocked,
  });
  clearBootstrapCache(userId);
  return { bookingId, storeName: store.name, staffName: staff.name, customerName: info.customer.name, dateStr: input.dateStr, startTime: input.startTime, endTime: input.endTime };
}

async function change(userId, bookingId, input) {
  if (!bookingId) throw new Error('変更する予約が指定されていません。');
  const oldBooking = await bookingStore.getBooking(bookingId);
  if (!oldBooking || !await pairStore.sameAccount(oldBooking.userId, userId) || oldBooking.status !== 'confirmed') throw new Error('変更する予約が見つかりません。');
  const today = dayjs().tz(config.business.timezone).format('YYYY-MM-DD');
  if (oldBooking.dateStr <= today) throw new Error('当日の予約はWEBから変更できません。店舗へご連絡ください。');

  const store = getStore(input.storeId);
  const staff = findStaff(input.staffId);
  const info = await bootstrap(userId, bookingId);
  if (!store || !staff) throw new Error('店舗またはトレーナーが見つかりません。');
  clearCalendarCache();
  const current = await availability(userId, input.storeId, input.dateStr, info, bookingId);
  const row = current.staff.find((s) => s.id === input.staffId);
  const slot = row?.slots.find((s) => s.start === input.startTime && s.end === input.endTime);
  if (!slot) throw new Error('選択中にこの時間が埋まりました。別の時間を選んでください。');
  const duration = info.durationMinutes;
  const ticketOnly = info.bookingAllowance.type === 'monthly' && input.dateStr > info.bookingAllowance.monthlyMaxDate;
  const entitlement = await resolveBookingUsage(userId, input.dateStr, duration, bookingId, { ticketOnly });
  if (!entitlement.available) {
    throw new Error(entitlement.monthlyMember
      ? '月会費の予約枠と追加チケットの残数を超えるため、予約できません。'
      : 'チケット残数を超える予約はできません。');
  }

  const event = await createBooking({
    dateStr: input.dateStr, startTime: input.startTime, endTime: input.endTime, calendarId: staff.calendarId,
    summary: `${info.customer.name}様`,
    description: `Web予約画面からの自動登録(変更)\nお名前: ${info.customer.name}様\n店舗: ${store.name}\n利用: ${entitlement.usageType === 'ticket' ? '追加チケット' : entitlement.usageType === 'membership' ? '月会費' : '通常'}`,
  });
  try { await deleteBooking(oldBooking.calendarId, oldBooking.eventId); }
  catch (error) { console.error('Web変更時の旧カレンダー予約削除でエラー:', error); }
  await bookingStore.cancelBooking(bookingId);
  const newBooking = {
    userId, storeId: store.id, storeName: store.name, staffId: staff.id, staffName: staff.name,
    calendarId: staff.calendarId, eventId: event.id, dateStr: input.dateStr,
    startTime: input.startTime, endTime: input.endTime, durationMinutes: duration, customerName: info.customer.name,
    usageType: entitlement.usageType,
    ticketLocked: entitlement.ticketLocked,
  };
  newBooking.bookingId = await bookingStore.addBooking(newBooking);
  clearBootstrapCache(userId);
  return { oldBooking, newBooking };
}

module.exports = { bootstrap, availability, weekAvailability, book, change };

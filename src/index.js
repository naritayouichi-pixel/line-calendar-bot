const express = require('express');
const path = require('path');
const line = require('@line/bot-sdk');
const dayjs = require('dayjs');
require('dayjs/locale/ja');
dayjs.locale('ja');
const config = require('./config');
const {
  getAvailableSlots,
  getBookableStartTimes,
  createBooking,
  deleteBooking,
  searchEventsByName,
  hasFullDayBlock,
} = require('./calendarService');
const { getStore, getShiftsForDate, getStoreForStaffAtTime, groupShiftsByStaff } = require('./shiftSchedule');
const bookingStore = require('./bookingStore');
const ticketStore = require('./ticketStore');
const memberStore = require('./memberStore');
const customerStore = require('./customerStore');
const { isPlatinumMemberName } = require('./platinumMembers');
const platinumMemberStore = require('./platinumMemberStore');
const pairStore = require('./pairStore');
const reservationReminderStore = require('./reservationReminderStore');
const { getSeasonalGreeting } = require('./seasonalGreeting');
const { isMonthlyBookingReleased, monthlyBookingMaxDate, bookingCalendarMaxDate } = require('./bookingRelease');
const { createWebBookingToken, verifyWebBookingToken } = require('./webBookingToken');
const webBookingService = require('./webBookingService');
const trialBookingService = require('./trialBookingService');
const squareService = require('./squareService');
const { resolveBookingUsage, prepareDueBookingUsage } = require('./bookingEntitlement');
const {
  buildStoreSelectionMessage,
  buildDatePickerMessage,
  buildClosedMessage,
  buildStaffSelectionMessage,
  buildSlotSelectionMessage,
  buildNamePromptMessage,
  buildBookingConfirmedMessage,
  buildStaffNotificationMessage,
  buildBookingListMessage,
  buildCancelConfirmMessage,
  buildCancelledMessage,
  buildChangeConfirmedMessage,
  buildStaffCancelNotificationMessage,
  buildStaffChangeNotificationMessage,
  buildTicketPackageSelectionMessage,
  buildAdminMemberManagementMessage,
  buildAdminMonthlyPackageSelectionMessage,
  buildTicketSelfPurchaseSelectionMessage,
  buildTicketSelfPurchasedMessage,
  buildAdminBillingRequestMessage,
  buildAdminAskCustomerIdMessage,
  buildAdminTicketAddedMessage,
  buildTicketBalanceMessage,
  buildTicketLimitReachedMessage,
  buildAdminAskQuotaMessage,
  buildAdminAskCustomerIdForQuotaMessage,
  buildAdminQuotaSetMessage,
  buildMonthlyQuotaReachedMessage,
  buildAttendanceConfirmedMessage,
  buildMemberMenuMessage,
  buildMemberTypeChangedMessage,
  buildMonthlyPackageSelectionMessage,
  buildMemberTypeChangedWithPlanMessage,
  buildMonthlyMemberStatusMessage,
  buildMainMenuMessage,
  shiftTimeLabel,
  combineShiftLabel,
} = require('./lineService');

const lineConfig = {
  channelAccessToken: config.line.channelAccessToken,
  channelSecret: config.line.channelSecret,
};

const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: lineConfig.channelAccessToken,
});

async function pushToCustomerAccount(userId, messages) {
  const userIds = await pairStore.getMemberIds(userId);
  await Promise.all(userIds.map((to) => client.pushMessage({ to, messages })));
}

const app = express();
app.use('/assets', express.static(path.join(__dirname, '..', 'public')));
app.use('/booking', express.static(path.join(__dirname, '..', 'public', 'booking')));
app.use('/trial', express.static(path.join(__dirname, '..', 'public', 'trial')));

// お客様が「時間枠を選んだ後、お名前の入力待ち」の状態を覚えておくための簡易的なメモリ上のストア。
// キーはLINEのuserId。サーバーを再起動すると消えるため、本番運用では
// ファイルやデータベースなど永続的な保存先に置き換えることを推奨する。
// (確定した予約自体は bookingStore.js でファイルに保存されるので、こちらは
//  あくまで「入力待ちの一時的な状態」のみを保持する)
const pendingBookings = new Map();

// 管理者(成田さん等)が「チケット追加」の対話をしている途中の状態を覚えておくストア。
// { step: 'awaiting_customer_id' | 'awaiting_count', customerId?: string }
const pendingTicketAdmin = new Map();

// 管理者が「月会費回数設定」の対話をしている途中の状態を覚えておくストア。
// { step: 'awaiting_quota' | 'awaiting_customer_id', quota?: number }
const pendingQuotaAdmin = new Map();

// 管理者がプラチナ昇格・解除を行っている途中の状態。
const pendingPlatinumAdmin = new Map();

// 管理者が顧客名とLINEユーザーIDを紐づけている途中の状態。
const pendingCustomerLinkAdmin = new Map();

// お客様自身がLINEユーザーIDとカレンダー上の名前を紐づける途中の状態。
const pendingCustomerLinkSelf = new Map();
const CUSTOMER_LINK_PENDING_MS = 10 * 60 * 1000;

function isCustomerLinkPendingActive(state) {
  return Boolean(state?.createdAt && Date.now() - state.createdAt < CUSTOMER_LINK_PENDING_MS);
}

// ヘルスチェック用(Cloud Run等のデプロイ確認に使う)
app.get('/', (req, res) => res.send('LINE calendar bot is running'));

function webBookingUser(req, res) {
  const identity = verifyWebBookingToken(req.query.token);
  if (!identity) {
    res.status(401).json({ error: '予約リンクの有効期限が切れています。LINEメニューからもう一度開いてください。' });
    return null;
  }
  return identity.userId;
}

app.get('/api/web-booking/bootstrap', async (req, res) => {
  const userId = webBookingUser(req, res); if (!userId) return;
  try { res.json(await webBookingService.bootstrap(userId, req.query.changeBookingId || null)); }
  catch (error) { res.status(400).json({ error: error.message }); }
});

app.get('/api/trial/bootstrap', (req,res)=>res.json(trialBookingService.bootstrap()));
app.get('/api/trial/week-availability', async (req,res)=>{try{res.json(await trialBookingService.week(req.query.storeId,req.query.start));}catch(e){res.status(400).json({error:e.message});}});
app.post('/api/trial/checkout', express.json(), async (req,res)=>{try{res.json(await trialBookingService.checkout(req.body||{}));}catch(e){console.error('体験予約決済開始エラー:',e);res.status(400).json({error:e.message});}});
app.get('/api/trial/status', async (req,res)=>{const result=await trialBookingService.status(req.query.id);if(!result)return res.status(404).json({error:'予約が見つかりません。'});res.json(result);});

app.post('/webhooks/square', express.text({type:'application/json'}), async (req,res)=>{
  const raw=typeof req.body==='string'?req.body:JSON.stringify(req.body||{});
  if(!squareService.validWebhook(raw,req.get('x-square-hmacsha256-signature'))) return res.status(403).send('Invalid signature');
  try{
    const event=JSON.parse(raw); const payment=event.data?.object?.payment;
    if(event.type==='payment.updated'&&payment?.status==='COMPLETED'&&payment.order_id) await trialBookingService.finalize(payment.order_id,payment.id);
    return res.status(200).send('OK');
  }catch(e){console.error('Square Webhook処理エラー:',e);return res.status(500).send('Failed');}
});

app.post('/tasks/cleanup-trial-holds', async(req,res)=>{
  if(!config.automationTaskSecret||req.get('x-automation-secret')!==config.automationTaskSecret)return res.status(401).send('Unauthorized');
  try{return res.json({expired:await trialBookingService.cleanupExpired()});}catch(e){console.error('体験仮押さえ解除エラー:',e);return res.status(500).send('Failed');}
});

app.get('/api/web-booking/availability', async (req, res) => {
  const userId = webBookingUser(req, res); if (!userId) return;
  try { res.json(await webBookingService.availability(userId, req.query.storeId, req.query.date, null, req.query.changeBookingId || null)); }
  catch (error) { console.error('Web空き枠取得でエラー:', error); res.status(400).json({ error: error.message }); }
});

app.get('/api/web-booking/week-availability', async (req, res) => {
  const userId = webBookingUser(req, res); if (!userId) return;
  try { res.json(await webBookingService.weekAvailability(userId, req.query.storeId, req.query.start, req.query.changeBookingId || null)); }
  catch (error) { console.error('Web週間空き枠取得でエラー:', error); res.status(400).json({ error: error.message }); }
});

app.post('/api/web-booking/book', express.json(), async (req, res) => {
  const userId = webBookingUser(req, res); if (!userId) return;
  try {
    const result = await webBookingService.book(userId, req.body || {});
    res.json(result);
    try {
      await pushToCustomerAccount(userId, [buildBookingConfirmedMessage(result.storeName, result.staffName, result.dateStr, result.startTime, result.endTime, result.customerName)]);
    } catch (pushError) {
      console.error('Web予約の完了通知でエラー:', pushError);
    }
  } catch (error) {
    console.error('Web予約登録でエラー:', error);
    res.status(400).json({ error: error.message });
  }
});

app.post('/api/web-booking/change', express.json(), async (req, res) => {
  const userId = webBookingUser(req, res); if (!userId) return;
  try {
    const result = await webBookingService.change(userId, req.query.changeBookingId, req.body || {});
    res.json(result);
    try {
      await pushToCustomerAccount(userId, [buildChangeConfirmedMessage(result.oldBooking, result.newBooking)]);
    } catch (pushError) {
      console.error('Web予約変更の完了通知でエラー:', pushError);
    }
    if (isTomorrow(result.oldBooking.dateStr) || isTomorrow(result.newBooking.dateStr)) {
      await notifyStaff(config.adminNotificationGroupId, '会社グループ', buildStaffChangeNotificationMessage(result.oldBooking, result.newBooking));
    }
  } catch (error) {
    console.error('Web予約変更でエラー:', error);
    res.status(400).json({ error: error.message });
  }
});

// 毎分Cloud Schedulerから呼び出し、開始時刻になったチケット予約を自動消費する。
app.post('/tasks/consume-due-tickets', express.json(), async (req, res) => {
  if (!config.automationTaskSecret || req.get('x-automation-secret') !== config.automationTaskSecret) {
    return res.status(401).send('Unauthorized');
  }

  const now = dayjs().tz(config.business.timezone);
  const dateStr = now.format('YYYY-MM-DD');
  const timeStr = now.format('HH:mm');
  try {
    const bookings = await bookingStore.getBookingsForDate(dateStr);
    const consumed = [];
    for (const booking of bookings) {
      if (booking.startTime > timeStr || booking.attended) continue;
      const dueUsage = await prepareDueBookingUsage(booking);
      if (!dueUsage.consumeTicket) continue;
      const result = await ticketStore.consumeForDueBooking(booking.bookingId, dateStr, timeStr);
      if (result) consumed.push(result);
    }
    if (consumed.length) console.log('チケット自動消費:', consumed);
    return res.status(200).json({ checked: bookings.length, consumed: consumed.length });
  } catch (err) {
    console.error('チケット自動消費でエラー:', err);
    return res.status(500).send('Failed');
  }
});

// 毎月18日/25日8:00にCloud Schedulerから呼び出し、月会費会員へ翌月予約開始を通知する。
app.post('/tasks/send-monthly-reservation-reminder', express.json(), async (req, res) => {
  if (!config.automationTaskSecret || req.get('x-automation-secret') !== config.automationTaskSecret) {
    return res.status(401).send('Unauthorized');
  }

  const memberType = req.query.type;
  if (!['platinum', 'regular'].includes(memberType)) {
    return res.status(400).send('type must be platinum or regular');
  }
  const now = dayjs().tz(config.business.timezone);
  const period = `${now.format('YYYY-MM')}_${memberType}`;
  const seasonalGreeting = getSeasonalGreeting(now.month() + 1);
  let eligible = 0;
  let sent = 0;
  let failed = 0;

  try {
    const customers = await customerStore.listLinkedCustomers();
    for (const customer of customers) {
      const monthlyMember = await isMember(customer.userId);
      const platinumMember = await isPlatinumMember(customer.userId);
      const target = memberType === 'platinum'
        ? monthlyMember && platinumMember
        : monthlyMember && !platinumMember;
      if (!target) continue;
      eligible += 1;
      if (!await reservationReminderStore.claim(period, customer.userId)) continue;
      try {
        await client.pushMessage({
          to: customer.userId,
          messages: [
            {
              type: 'text',
              text: `こんにちは❗️PLAYGRANDです😁\n\n${seasonalGreeting}\n\n${memberType === 'platinum' ? 'プラチナ会員様' : '月会費会員様'}翌月分のご予約受付を10時より開始となります🙋\nLINEメニューの「予約」からご予約いただけます。\n\n不明点ございましたら、スタッフにお声がけください🤲`,
            },
            {
              type: 'image',
              originalContentUrl: `${config.publicBaseUrl}/assets/monthly-schedule.png`,
              previewImageUrl: `${config.publicBaseUrl}/assets/monthly-schedule.png`,
            },
          ],
        });
        sent += 1;
      } catch (error) {
        failed += 1;
        await reservationReminderStore.release(period, customer.userId);
        console.error(`${customer.name}様への予約開始通知でエラー:`, error);
      }
    }
    return res.status(200).json({ eligible, sent, failed });
  } catch (error) {
    console.error('月会費会員への予約開始通知でエラー:', error);
    return res.status(500).send('Failed');
  }
});

// LINEの署名検証を含むmiddlewareを使うため、webhookのルートだけexpress.json()を使わずline.middlewareに任せる
app.post('/webhook', line.middleware(lineConfig), async (req, res) => {
  try {
    await Promise.all(req.body.events.map(handleEvent));
    res.status(200).end();
  } catch (err) {
    console.error('Webhook処理でエラー:', err);
    // LINE側の再送を防ぐため200を返す(エラー内容はログで確認する)
    res.status(200).end();
  }
});

// postbackのdata文字列(例: "action=select_staff&storeId=jiyugaoka&staffId=narita&date=2026-08-05")を
// { action: 'select_staff', storeId: 'jiyugaoka', staffId: 'narita', date: '2026-08-05' } に変換する
function parsePostbackData(data) {
  const params = new URLSearchParams(data);
  return Object.fromEntries(params.entries());
}

function findStaff(staffId) {
  return config.staff.find((s) => s.id === staffId);
}

function todayStr() {
  return dayjs().tz(config.business.timezone).format('YYYY-MM-DD');
}

function isTomorrow(dateStr) {
  return dateStr === dayjs().tz(config.business.timezone).add(1, 'day').format('YYYY-MM-DD');
}

async function notifyCompanyForTomorrow(dateStr, message) {
  if (!isTomorrow(dateStr) || !config.adminNotificationGroupId) return;
  await notifyStaff(config.adminNotificationGroupId, '会社グループ', message);
}

function maxBookingDateStr() {
  return bookingCalendarMaxDate(dayjs().tz(config.business.timezone));
}

/**
 * "HH:mm"形式の開始・終了時刻から、所要時間(分)を計算する。
 * (チケット会員の予約が45分/60分どちらのコースかを判定するために使う)
 */
function timeDiffMinutes(startTime, endTime) {
  const [sh, sm] = startTime.split(':').map(Number);
  const [eh, em] = endTime.split(':').map(Number);
  return eh * 60 + em - (sh * 60 + sm);
}

function isPairBookingName(name) {
  return customerStore.isPairCustomerName(name);
}

function getStoreCalendarIds(storeId, dateStr, startTime = null, endTime = null) {
  const { shifts } = getShiftsForDate(storeId, dateStr);
  const toMinutes = (value, fallback) => {
    const [hour, minute] = String(value || fallback).split(':').map(Number);
    return hour * 60 + minute;
  };
  const matching = shifts.filter((shift) => {
    if (!startTime || !endTime) return true;
    return toMinutes(shift.start, `${config.business.startHour}:00`) < toMinutes(endTime)
      && toMinutes(shift.end, `${config.business.endHour}:00`) > toMinutes(startTime);
  });
  return [...new Set(matching.map((s) => findStaff(s.staffId)?.calendarId).filter(Boolean))];
}

async function isMember(userId) {
  // .envで決め打ち登録された分と、お客様自身がLINEで登録した分の両方を見る
  return config.members.some((m) => m.lineUserId === userId) || await memberStore.isMember(userId);
}

async function isPlatinumMember(userId) {
  const configuredMember = config.members.find((member) => member.lineUserId === userId);
  const names = [
    configuredMember?.name,
    await pairStore.getName(userId),
    await customerStore.getName(userId),
    await memberStore.getName(userId),
    ...await bookingStore.getDistinctCustomerNames(userId),
  ];
  for (const name of names.filter(Boolean)) {
    const status = await platinumMemberStore.getStatus(name);
    if (status !== null) return status;
  }
  // データベース登録前でも従来の固定名簿を使えるようにする。
  return names.some(isPlatinumMemberName);
}

/**
 * そのお客様の現在の会員種別を判定し、「会員種別」メニューのメッセージを組み立てる。
 * 優先順位: 月会費メンバー > チケット会員 > ビジター
 * (両方に登録されることは基本想定していないが、両方登録されていた場合は月会費を優先表示する)
 */
async function buildMemberMenu(userId) {
  if (await isMember(userId)) {
    return buildMemberMenuMessage(
      await isPlatinumMember(userId) ? '月会費メンバー（プラチナ）' : '月会費メンバー',
      await ticketStore.getBalances(userId)
    );
  }
  if (await ticketStore.isTicketCustomer(userId)) {
    return buildMemberMenuMessage('チケット会員', await ticketStore.getBalances(userId));
  }
  return buildMemberMenuMessage('ビジター(会員登録なし)', null);
}

/**
 * 「予約」の開始処理(店舗選択の表示)。テキストの合言葉・リッチメニューのpostback両方から呼ぶ。
 */
async function startReservationFlow(event, userId) {
  const token = createWebBookingToken(userId, 60 * 60);
  const bookingUrl = `${config.publicBaseUrl}/booking/?token=${encodeURIComponent(token)}`;
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{
      type: 'template',
      altText: '予約画面を開く',
      template: {
        type: 'buttons',
        title: 'WEB予約',
        text: '空き時間を一覧で確認して、そのまま予約できます。',
        actions: [{ type: 'uri', label: '予約画面を開く', uri: bookingUrl }],
      },
    }],
  });
}

/**
 * 「予約確認」の表示処理。テキストの合言葉・リッチメニューのpostback両方から呼ぶ。
 */
async function showBookingList(event, userId, requestedPage = 0) {
  const monthStart = dayjs().tz(config.business.timezone).startOf('month').format('YYYY-MM-DD');
  const bookings = (await getBookingsWithSync(userId))
    .filter((b) => b.dateStr >= monthStart)
    .sort((a, b) => `${a.dateStr} ${a.startTime}`.localeCompare(`${b.dateStr} ${b.startTime}`));
  const pageSize = 10;
  const lastPage = Math.max(0, Math.ceil(bookings.length / pageSize) - 1);
  const page = Math.min(Math.max(0, Number(requestedPage) || 0), lastPage);
  const pageBookings = bookings.slice(page * pageSize, (page + 1) * pageSize);
  const token = createWebBookingToken(userId, 60 * 60);
  const webChangeBaseUrl = `${config.publicBaseUrl}/booking/?token=${encodeURIComponent(token)}&changeBookingId=`;
  const messages = [buildBookingListMessage(pageBookings, todayStr(), webChangeBaseUrl)];
  if (bookings.length > pageSize) {
    const items = [];
    if (page > 0) {
      items.push({ type: 'action', action: { type: 'postback', label: '前の予約', data: `action=booking_list_page&page=${page - 1}` } });
    }
    if (page < lastPage) {
      items.push({ type: 'action', action: { type: 'postback', label: '次の予約', data: `action=booking_list_page&page=${page + 1}` } });
    }
    messages.push({
      type: 'text',
      text: `予約一覧 ${page + 1}/${lastPage + 1}ページ`,
      quickReply: { items },
    });
  }
  return client.replyMessage({
    replyToken: event.replyToken,
    messages,
  });
}

/**
 * 「会員種別」メニューの表示処理。テキストの合言葉・リッチメニューのpostback両方から呼ぶ。
 */
async function showMemberMenu(event, userId) {
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [await buildMemberMenu(userId)],
  });
}

/**
 * 月会費メンバーが予約できる上限日を計算する。
 * ルール: 通常会員は毎月25日10時、プラチナ会員は毎月18日10時から翌月分を予約できる。
 * それ以外の日(会員以外・条件を満たした会員)は、通常の上限(maxBookingDateStr)をそのまま使う。
 */
async function effectiveMaxDateStr(userId) {
  const normalMax = maxBookingDateStr();

  if (await isMember(userId)) {
    const today = dayjs().tz(config.business.timezone);
    const openDay = await isPlatinumMember(userId)
      ? config.booking.platinumNextMonthOpenDay
      : config.booking.memberNextMonthOpenDay;

    return monthlyBookingMaxDate(
      today,
      openDay,
      config.booking.memberNextMonthOpenHour,
      normalMax
    );
  }

  if (await ticketStore.isTicketCustomer(userId)) {
    // チケット会員は日付の制限なし(実質無制限の日数を使う)
    return dayjs()
      .tz(config.business.timezone)
      .add(config.business.ticketMaxDaysAhead, 'day')
      .format('YYYY-MM-DD');
  }

  return normalMax; // ビジター等は通常通り
}

async function memberBookingReleaseLabel(userId) {
  const openDay = await isPlatinumMember(userId)
    ? config.booking.platinumNextMonthOpenDay
    : config.booking.memberNextMonthOpenDay;
  return `${openDay}日${config.booking.memberNextMonthOpenHour}時`;
}

/**
 * Googleカレンダーに直接入力された(LINE経由ではない)予約を、
 * お客様が過去にLINEで使ったお名前と照合して見つけ出し、予約データに取り込む。
 * 既に取り込み済みのもの(eventIdが一致するもの)は二重登録しない。
 *
 * 過去にLINEで一度も予約したことがないお客様は、照合できるお名前が
 * ないため、この同期の対象にはならない(サーバーが「そのお名前」を知らないため)。
 */
async function syncExternalBookings(userId) {
  const names = [...new Set([
    ...await bookingStore.getDistinctCustomerNames(userId),
    await pairStore.getName(userId),
    await customerStore.getName(userId),
  ].filter(Boolean))];
  if (names.length === 0) return; // 照合できるお名前がまだない

  for (const staff of config.staff) {
    for (const name of names) {
      let events;
      try {
        const monthStart = dayjs().tz(config.business.timezone).startOf('month').format('YYYY-MM-DD');
        events = await searchEventsByName(staff.calendarId, name, monthStart);
      } catch (err) {
        console.error(`カレンダー検索でエラー(${staff.name} / ${name}):`, err);
        continue;
      }

      for (const ev of events) {
        if (await bookingStore.findByEventId(ev.id)) continue; // 既に取り込み済み

        const store = getStoreForStaffAtTime(staff.id, ev.dateStr, ev.startTime);
        // シフト時間外の予定は、店舗を安全に特定できないため予約として自動取り込みしない。
        if (!store) continue;
        const eventDuration = timeDiffMinutes(ev.startTime, ev.endTime);
        const monthlyMember = await isMember(userId);
        const durationMinutes = monthlyMember
          ? await memberStore.getSessionDuration(userId) || eventDuration
          : await ticketStore.isTicketCustomer(userId)
            ? ticketStore.selectTicketDuration(await ticketStore.getBalances(userId), eventDuration)
            : eventDuration;
        const entitlement = await resolveBookingUsage(userId, ev.dateStr, durationMinutes);
        await bookingStore.addBooking({
          userId,
          storeId: store.id,
          storeName: store.name,
          staffId: staff.id,
          staffName: staff.name,
          calendarId: staff.calendarId,
          eventId: ev.id,
          dateStr: ev.dateStr,
          startTime: ev.startTime,
          endTime: ev.endTime,
          durationMinutes,
          usageType: entitlement.available ? entitlement.usageType : (monthlyMember ? 'membership' : 'ticket'),
          customerName: name,
          source: 'calendar', // Googleカレンダーへの直接入力から取り込んだことが分かるように記録
        });
      }
    }
  }
}

/**
 * 「予約確認」等で予約一覧を表示する前に、外部(カレンダー直接入力)の
 * 予約も同期してから、まとめて予約一覧を返す。
 */
async function getBookingsWithSync(userId) {
  await syncExternalBookings(userId);
  return bookingStore.getBookingsByUser(userId);
}

async function canAccessBooking(userId, booking) {
  return Boolean(booking && await pairStore.sameAccount(userId, booking.userId));
}

// リッチメニューの「予約」ボタンから送られてくる文字列。
// LINE Official Account Managerでリッチメニューのアクションを
// 「テキスト」タイプにし、送信するテキストをこれと同じにしてください。
const RESERVATION_KEYWORD = '予約';

// 予約の変更・キャンセルを行うための合言葉。
const CHECK_BOOKINGS_KEYWORD = '予約確認';

// スタッフが自分のLINEユーザーIDを確認するための合言葉。
// これを送ると、そのユーザーIDがそのまま返信される(STAFF_LISTの設定に使う)。
const ID_CHECK_KEYWORD = 'ID確認';

// 会社グループの通知先IDを確認するための合言葉。
const GROUP_ID_CHECK_KEYWORD = 'グループID確認';

// 管理者(config.adminUserIdsに登録された人)が、チケットを追加するための合言葉。
const TICKET_ADD_KEYWORD = 'チケット追加';

// お客様が自分のチケット残数を確認するための合言葉。
const TICKET_CHECK_KEYWORD = 'チケット残数確認';

// お客様が自分の会員種別を確認・変更するための合言葉。
// LINE Official Account Managerのリッチメニューにこの文字列を送るボタンを追加すると、
// タップだけで会員種別メニューを開けるようになる。
const MEMBER_MENU_KEYWORD = '会員種別';

// 管理者だけが使える、月会費メンバーの月あたり回数を設定するための合言葉。
const MEMBER_QUOTA_KEYWORD = '月会費回数設定';

// 管理者用の会員情報変更メニュー。
const ADMIN_MEMBER_KEYWORD = '会員管理';

// 管理者がGoogleカレンダー上の顧客名とLINEユーザーIDを紐づける合言葉。
const CUSTOMER_LINK_KEYWORD = '顧客紐付け';

async function handleEvent(event) {
  if (event.type === 'message' && event.message.type === 'text') {
    return handleTextMessage(event);
  }

  if (event.type === 'follow') {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        {
          type: 'text',
          text: '友だち追加ありがとうございます。\nご予約は「予約」、ご予約内容の確認・変更・キャンセルは「予約確認」と送ってください。',
        },
      ],
    });
  }

  if (event.type === 'postback') {
    return handlePostback(event);
  }

  return null;
}

async function handleTextMessage(event) {
  const userId = event.source.userId;
  const text = event.message.text.trim();

  // 既知の合言葉(キーワード)は、途中で止まっている対話よりも常に優先する。
  // (例: 「チケット追加」の途中でIDを送らずに他の操作をしても、そのまま固まってしまわないようにする)
  const KNOWN_KEYWORDS = [
    ID_CHECK_KEYWORD,
    GROUP_ID_CHECK_KEYWORD,
    TICKET_ADD_KEYWORD,
    TICKET_CHECK_KEYWORD,
    RESERVATION_KEYWORD,
    CHECK_BOOKINGS_KEYWORD,
    MEMBER_MENU_KEYWORD,
    MEMBER_QUOTA_KEYWORD,
    ADMIN_MEMBER_KEYWORD,
    CUSTOMER_LINK_KEYWORD,
  ];
  if (KNOWN_KEYWORDS.includes(text)) {
    pendingTicketAdmin.delete(userId); // 中断していたチケット管理者対話があれば解除する
    pendingQuotaAdmin.delete(userId); // 中断していた月会費回数設定対話があれば解除する
    pendingPlatinumAdmin.delete(userId);
    pendingCustomerLinkAdmin.delete(userId); // 中断していた顧客紐付け対話があれば解除する
    pendingCustomerLinkSelf.delete(userId); // 中断していた自己紐付け対話があれば解除する
  } else {
    // お名前の入力待ち状態であれば、このテキストをお客様の名前として予約を確定させる
    if (userId && pendingBookings.has(userId)) {
      return finalizeBooking(event, userId, text);
    }

    // 「会員種別 > 顧客紐付け」からフルネームの入力待ちであれば登録する
    if (userId && pendingCustomerLinkSelf.has(userId)) {
      const state = pendingCustomerLinkSelf.get(userId);
      if (!isCustomerLinkPendingActive(state)) {
        pendingCustomerLinkSelf.delete(userId);
      } else {
        const name = text.replace(/様$/, '').trim();
        if (!name) return replyText(event, 'フルネームを入力してください。');
        try {
          await customerStore.linkCustomer(userId, name);
        } catch (error) {
          return replyText(event, error.message);
        }
        pendingCustomerLinkSelf.delete(userId);
        return replyText(
          event,
          `${name}様として顧客情報を紐付けました。`
        );
      }
    }

    // 管理者がチケット追加の対話中であれば、そちらを優先する
    if (userId && pendingTicketAdmin.has(userId)) {
      return handleTicketAdminDialogue(event, userId, text);
    }

    // 管理者が月会費回数設定の対話中であれば、そちらを優先する
    if (userId && pendingQuotaAdmin.has(userId)) {
      return handleQuotaAdminDialogue(event, userId, text);
    }

    if (userId && pendingPlatinumAdmin.has(userId)) {
      return handlePlatinumAdminDialogue(event, userId, text);
    }

    if (userId && pendingCustomerLinkAdmin.has(userId)) {
      return handleCustomerLinkAdminDialogue(event, userId, text);
    }
  }

  if (text === ID_CHECK_KEYWORD) {
    return replyText(event, userId);
  }

  if (text === GROUP_ID_CHECK_KEYWORD) {
    return replyText(
      event,
      event.source.type === 'group'
        ? event.source.groupId
        : 'このコマンドは通知先にするLINEグループ内で送ってください。'
    );
  }

  // お客様が自分の会員種別を確認・変更する
  if (text === MEMBER_MENU_KEYWORD) {
    return showMemberMenu(event, userId);
  }

  // 管理者だけが使える、チケット追加の対話を開始する(まずパッケージを選ばせる)
  if (text === TICKET_ADD_KEYWORD) {
    if (!config.adminUserIds.includes(userId)) {
      return null; // 管理者以外には何も反応しない(誤操作・不正防止)
    }
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildTicketPackageSelectionMessage()],
    });
  }

  // 管理者だけが使える、月会費メンバーの月あたり回数設定を開始する
  if (text === MEMBER_QUOTA_KEYWORD) {
    if (!config.adminUserIds.includes(userId)) {
      return null; // 管理者以外には何も反応しない(誤操作・不正防止)
    }
    pendingQuotaAdmin.set(userId, { step: 'awaiting_quota' });
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildAdminAskQuotaMessage()],
    });
  }

  if (text === ADMIN_MEMBER_KEYWORD) {
    if (!config.adminUserIds.includes(userId)) return null;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildAdminMemberManagementMessage()],
    });
  }

  // 管理者だけが使える、顧客名とLINEユーザーIDの紐付けを開始する
  if (text === CUSTOMER_LINK_KEYWORD) {
    if (!config.adminUserIds.includes(userId)) return null;
    pendingCustomerLinkAdmin.set(userId, { step: 'awaiting_name' });
    return replyText(
      event,
      '紐付けるお客様のお名前を、Googleカレンダーと同じ表記で送ってください。\nお二人でご利用の場合は、名前の最後に「ペア」を付けてください。\n例: 山田 太郎 ペア'
    );
  }

  // お客様が自分のチケット残数を確認する
  if (text === TICKET_CHECK_KEYWORD) {
    const balances = await ticketStore.getBalances(userId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildTicketBalanceMessage(balances)],
    });
  }

  // 「予約」ボタン(リッチメニュー)が押された時だけ、店舗選択フローを開始する。
  if (text === RESERVATION_KEYWORD) {
    return startReservationFlow(event, userId);
  }

  // 「予約確認」で、自分の予約一覧(変更・キャンセルのボタン付き、1ヶ月以内のもの)を表示する
  if (text === CHECK_BOOKINGS_KEYWORD) {
    return showBookingList(event, userId);
  }

  // それ以外のテキストメッセージは、他のスタッフとの通常のやり取りを妨げないよう反応しない。
  return null;
}

/**
 * 管理者の「チケット追加」対話を1ステップ進める。
 * (パッケージ(時間・枚数)は事前にボタンで確定済みのため、
 *  ここではLINEユーザーIDを受け取って追加するだけでよい)
 */
async function handleTicketAdminDialogue(event, adminUserId, text) {
  const state = pendingTicketAdmin.get(adminUserId);

  if (state.step === 'awaiting_customer_id') {
    const customerId = text.trim();
    if (!customerId.startsWith('U') || customerId.length < 10) {
      return replyText(
        event,
        'LINEユーザーIDの形式が正しくないようです(Uから始まる文字列のはずです)。もう一度送ってください。'
      );
    }
    pendingTicketAdmin.delete(adminUserId);

    if (await isMember(customerId)) {
      const memberDuration = await memberStore.getSessionDuration(customerId);
      if (memberDuration && memberDuration !== state.duration) {
        return replyText(event, `このお客様は月会費${memberDuration}分コースです。${memberDuration}分チケットを追加してください。`);
      }
    }

    // お客様の名前が分かれば(過去にLINE予約したことがあれば)一緒に記録しておく
    const knownNames = await bookingStore.getDistinctCustomerNames(customerId);
    const name = knownNames[0] || await ticketStore.getName(customerId) || '(名前未登録)';

    const newBalance = await ticketStore.addTickets(customerId, name, state.duration, state.count);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildAdminTicketAddedMessage(customerId, state.duration, state.count, newBalance)],
    });
  }

  pendingTicketAdmin.delete(adminUserId);
  return replyText(event, '入力内容が分からなかったため、最初からやり直してください。');
}

/**
 * 管理者の「月会費回数設定」対話を1ステップ進める。
 * Step1: 月あたりの回数を受け取る → Step2: LINEユーザーIDを受け取る → 設定して完了
 */
async function handleQuotaAdminDialogue(event, adminUserId, text) {
  const state = pendingQuotaAdmin.get(adminUserId);

  if (state.step === 'awaiting_quota') {
    const quota = Number(text.trim());
    if (!Number.isInteger(quota) || quota <= 0) {
      return replyText(event, '回数は1以上の整数で送ってください。(例: 8)');
    }
    pendingQuotaAdmin.set(adminUserId, { step: 'awaiting_customer_id', quota });
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildAdminAskCustomerIdForQuotaMessage(quota)],
    });
  }

  if (state.step === 'awaiting_customer_id') {
    const customerId = text.trim();
    if (!customerId.startsWith('U') || customerId.length < 10) {
      return replyText(
        event,
        'LINEユーザーIDの形式が正しくないようです(Uから始まる文字列のはずです)。もう一度送ってください。'
      );
    }
    pendingQuotaAdmin.delete(adminUserId);

    // お客様の名前が分かれば(過去にLINE予約したことがあれば)一緒に記録しておく
    const knownNames = await bookingStore.getDistinctCustomerNames(customerId);
    const name = knownNames[0] || await memberStore.getName(customerId) || null;

    await memberStore.addMember(customerId, name, state.quota, state.duration);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildAdminQuotaSetMessage(customerId, state.quota, state.duration)],
    });
  }

  pendingQuotaAdmin.delete(adminUserId);
  return replyText(event, '入力内容が分からなかったため、最初からやり直してください。');
}

async function handlePlatinumAdminDialogue(event, adminUserId, text) {
  const state = pendingPlatinumAdmin.get(adminUserId);
  const customerId = text.trim();
  if (!customerId.startsWith('U') || customerId.length < 10) {
    return replyText(event, 'LINEユーザーIDの形式が正しくありません。Uから始まるIDをもう一度送ってください。');
  }
  const names = [
    await customerStore.getName(customerId),
    await memberStore.getName(customerId),
    ...(await bookingStore.getDistinctCustomerNames(customerId)),
  ].filter(Boolean);
  const name = names[0];
  if (!name) return replyText(event, 'お名前が未登録です。先に「顧客紐付け」を行ってください。');

  pendingPlatinumAdmin.delete(adminUserId);
  if (state.mode === 'register') {
    await platinumMemberStore.register(name);
    return replyText(event, `${name}様をプラチナ会員へ昇格しました。`);
  }
  await platinumMemberStore.unregister(name);
  return replyText(event, `${name}様のプラチナ登録を解除し、通常の月会費会員へ変更しました。`);
}

/**
 * 管理者の「顧客紐付け」対話。
 * Step1: カレンダーで使う名前 → Step2: LINEユーザーID → 登録完了
 */
async function handleCustomerLinkAdminDialogue(event, adminUserId, text) {
  const state = pendingCustomerLinkAdmin.get(adminUserId);

  if (state.step === 'awaiting_name') {
    let name;
    try {
      name = customerStore.normalizeCustomerName(text);
    } catch (error) {
      return replyText(event, error.message);
    }
    pendingCustomerLinkAdmin.set(adminUserId, { step: 'awaiting_customer_id', name });
    return replyText(
      event,
      `${name}様のLINEユーザーIDを送ってください。\nお客様本人が「ID確認」と送ると確認できます。`
    );
  }

  if (state.step === 'awaiting_customer_id') {
    const customerId = text.trim();
    if (!/^U[0-9a-fA-F]{32}$/.test(customerId)) {
      return replyText(event, 'LINEユーザーIDの形式が正しくありません。Uから始まる33文字のIDを送ってください。');
    }
    await customerStore.linkCustomer(customerId, state.name);
    pendingCustomerLinkAdmin.delete(adminUserId);
    return replyText(
      event,
      `${state.name}様とLINEユーザーIDを紐付けました。\n今後、カレンダー予定に「${state.name}」を含めると「予約確認」に反映されます。`
    );
  }

  pendingCustomerLinkAdmin.delete(adminUserId);
  return replyText(event, '入力内容が分からなかったため、最初から「顧客紐付け」と送ってください。');
}

async function handlePostback(event) {
  const data = parsePostbackData(event.postback.data);
  const userId = event.source.userId;

  if (data.action === 'admin_ticket_add') {
    if (!config.adminUserIds.includes(userId)) return null;
    return client.replyMessage({ replyToken: event.replyToken, messages: [buildTicketPackageSelectionMessage()] });
  }

  if (data.action === 'admin_monthly_change') {
    if (!config.adminUserIds.includes(userId)) return null;
    return client.replyMessage({ replyToken: event.replyToken, messages: [buildAdminMonthlyPackageSelectionMessage()] });
  }

  if (data.action === 'admin_monthly_package') {
    if (!config.adminUserIds.includes(userId)) return null;
    const duration = Number(data.duration);
    const quota = Number(data.quota);
    pendingQuotaAdmin.set(userId, { step: 'awaiting_customer_id', duration, quota });
    return replyText(event, `${duration}分×月${quota}回へ変更します。対象のお客様のLINEユーザーIDを貼り付けてください。`);
  }

  if (data.action === 'admin_platinum') {
    if (!config.adminUserIds.includes(userId)) return null;
    const mode = data.mode === 'unregister' ? 'unregister' : 'register';
    pendingPlatinumAdmin.set(userId, { mode });
    return replyText(event, `${mode === 'register' ? 'プラチナへ昇格' : 'プラチナを解除'}するお客様のLINEユーザーIDを貼り付けてください。`);
  }

  // リッチメニューの「メニュー」ボタン → 「予約する」「予約確認・変更」「会員種別」の3択を表示
  if (data.action === 'menu_open') {
    const token = createWebBookingToken(userId, 60 * 60);
    const bookingUrl = `${config.publicBaseUrl}/booking/?token=${encodeURIComponent(token)}`;
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildMainMenuMessage(bookingUrl)],
    });
  }

  // リッチメニューの「予約」タブ(postbackアクション)
  if (data.action === 'menu_reservation') {
    return startReservationFlow(event, userId);
  }

  // リッチメニューの「予約確認」タブ(postbackアクション)
  if (data.action === 'menu_check_bookings') {
    return showBookingList(event, userId);
  }

  if (data.action === 'booking_list_page') {
    return showBookingList(event, userId, data.page);
  }

  // リッチメニューの「会員種別」タブ(postbackアクション)
  if (data.action === 'menu_member_menu') {
    return showMemberMenu(event, userId);
  }

  // 店舗が選択された → 日付選択ボタンを出す
  if (data.action === 'select_store') {
    const store = getStore(data.storeId);
    if (!store) {
      return replyText(event, '店舗情報が見つかりませんでした。もう一度お試しください。');
    }
    const maxDateStr = await effectiveMaxDateStr(event.source.userId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildDatePickerMessage(store.id, store.name, extraParamsFrom(data), maxDateStr)],
    });
  }

  // 日付が選択された → 固定シフトからその日の出勤スタッフを絞り込んで表示
  if (data.action === 'pick_date') {
    return handlePickDate(event, data);
  }

  // スタッフが選択された → チケット会員は残っている時間(45分/60分)を自動判定、それ以外は固定時間で計算する
  if (data.action === 'select_staff') {
    return handleSelectStaff(event, data);
  }

  // 開始時刻が選択された → 通常予約ならお名前の入力を依頼、変更フローなら即座に変更を実行する
  if (data.action === 'select_slot') {
    return handleSelectSlot(event, data);
  }

  // 管理者がチケットのパッケージ(時間・枚数)を選択した → お客様のIDを尋ねる
  if (data.action === 'select_ticket_package') {
    return handleSelectTicketPackage(event, data);
  }

  // 予約一覧から「変更する」が押された → 店舗選択からやり直す(変更対象のbookingIdを引き継ぐ)
  if (data.action === 'start_change') {
    return handleStartChange(event, data);
  }

  // 予約一覧から「キャンセルする」が押された → 最終確認を挟む
  if (data.action === 'start_cancel') {
    return handleStartCancel(event, data);
  }

  if (data.action === 'confirm_cancel') {
    return handleConfirmCancel(event, data);
  }

  if (data.action === 'abort_cancel') {
    return replyText(event, 'キャンセルを取りやめました。ご予約はそのまま残っています。');
  }

  // スタッフが「来店確認」ボタンを押した → チケットを1枚消費する
  if (data.action === 'confirm_attendance') {
    return handleConfirmAttendance(event, data);
  }

  // 会員種別メニューの「LINEユーザーID確認」ボタン
  if (data.action === 'show_line_id') {
    return replyText(event, event.source.userId);
  }

  // 会員種別メニューから、お客様自身のIDとカレンダー上の名前を紐づける
  if (data.action === 'link_customer_self') {
    const userId = event.source.userId;
    pendingCustomerLinkSelf.set(userId, { step: 'awaiting_name', createdAt: Date.now() });
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [
        { type: 'text', text: userId },
        {
          type: 'text',
          text: '10分以内にフルネームを入力してください。\nお二人でご利用の場合は、名前の最後に「ペア」を付けてください。\n例: 山田 太郎 ペア',
        },
      ],
    });
  }

  // 会員種別メニューの「チケット購入及び残数確認」ボタン
  // → 現在の残数を表示した上で、購入したいパッケージを選ばせる
  if (data.action === 'ticket_menu') {
    const userId = event.source.userId;
    const balances = await ticketStore.getBalances(userId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildTicketBalanceMessage(balances), buildTicketSelfPurchaseSelectionMessage()],
    });
  }

  // お客様自身がチケットのパッケージを選んだ → 自分の残数に追加する
  if (data.action === 'self_buy_ticket') {
    const userId = event.source.userId;
    const duration = Number(data.duration);
    const count = Number(data.count);
    if (!duration || !count) {
      return replyText(event, 'パッケージの指定が正しくありませんでした。もう一度お試しください。');
    }
    if (await isMember(userId)) {
      const memberDuration = await memberStore.getSessionDuration(userId);
      if (memberDuration && memberDuration !== duration) {
        return replyText(event, `月会費コースと同じ${memberDuration}分チケットを選んでください。`);
      }
    }
    const knownNames = await bookingStore.getDistinctCustomerNames(userId);
    const name = knownNames[0] || await ticketStore.getName(userId) || '(名前未登録)';
    const newBalance = await ticketStore.addTickets(userId, name, duration, count);

    await client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildTicketSelfPurchasedMessage(duration, count, newBalance)],
    });

    // 会社グループ(未設定時は管理者全員)へ、店頭会計をお願いする通知を送る
    const billingMessage = buildAdminBillingRequestMessage(name, duration, count);
    if (config.adminNotificationGroupId) {
      await notifyStaff(config.adminNotificationGroupId, '会社グループ', billingMessage);
    } else {
      for (const adminUserId of config.adminUserIds) {
        await notifyStaff(adminUserId, '管理者', billingMessage);
      }
    }

    return null;
  }

  // 会員種別メニューの「月会費メンバー確認」ボタン
  // → まだ登録していなければコース選択、既に登録済みなら現状表示のみ(自己変更は不可)
  if (data.action === 'select_monthly_package') {
    const userId = event.source.userId;
    if (await memberStore.isMember(userId)) {
      const quota = await memberStore.getMonthlyQuota(userId);
      const duration = await memberStore.getSessionDuration(userId);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [buildMonthlyMemberStatusMessage(duration, quota)],
      });
    }
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildMonthlyPackageSelectionMessage()],
    });
  }

  // 会員種別メニューの「月会費メンバーになる」「チケット会員になる」ボタン
  if (data.action === 'become_member_type') {
    return handleBecomeMemberType(event, data);
  }

  return null;
}

// data.mode / data.bookingId が含まれている場合(=変更フローの途中)、
// 次のメッセージにもそのまま引き継ぐためのクエリ文字列を作る
function extraParamsFrom(data) {
  if (data.mode === 'change' && data.bookingId) {
    return `&mode=change&bookingId=${data.bookingId}`;
  }
  return '';
}

async function handlePickDate(event, data) {
  const store = getStore(data.storeId);
  const dateStr = data.date; // 例: "2026-08-05" (日付一覧のボタンから渡ってくる)
  if (!store) {
    return replyText(event, '店舗情報が見つかりませんでした。もう一度お試しください。');
  }

  // 当日・過去日の予約は不可(日付選択UIのmin指定だけに頼らず、サーバー側でも確認する)
  if (dateStr <= todayStr()) {
    return replyText(event, '大変申し訳ございませんが、当日のご予約はお受けできません。翌日以降の日付でお試しください。');
  }

  // 月会費メンバーの「来月分は25日から」制限(日付選択UIのmax指定だけに頼らず、サーバー側でも確認する)
  const maxDateStr = await effectiveMaxDateStr(event.source.userId);
  if (dateStr > maxDateStr) {
    const releaseLabel = await memberBookingReleaseLabel(event.source.userId);
    return replyText(
      event,
      `大変申し訳ございませんが、来月分のご予約は今月${releaseLabel}から受け付けます。`
    );
  }

  const { closed, shifts } = getShiftsForDate(store.id, dateStr);

  if (closed) {
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildClosedMessage(store.name, dateStr)],
    });
  }

  // シフトのエントリを、スタッフごとにまとめて表示名を付与する
  // (1人のスタッフが同じ日に飛び飛びの時間帯を持つ場合、1枚のカードにまとめる)
  const grouped = groupShiftsByStaff(shifts)
    .map((g) => {
      const staff = findStaff(g.staffId);
      if (!staff) return null;
      return { staffId: g.staffId, blocks: g.blocks, name: staff.name, calendarId: staff.calendarId };
    })
    .filter(Boolean);

  // カレンダーに終日の休みブロック(例: "NG")が入っているスタッフは、一覧から除外する
  const shiftsWithStaff = [];
  for (const s of grouped) {
    let blocked = false;
    try {
      blocked = await hasFullDayBlock(s.calendarId, dateStr, config.booking.fullDayBlockKeyword);
    } catch (err) {
      console.error(`終日休みブロックの確認でエラー(${s.name}):`, err);
    }
    if (!blocked) shiftsWithStaff.push(s);
  }

  if (shiftsWithStaff.length === 0) {
    return replyText(event, `${store.name}\nこの日は出勤予定のスタッフがいません。`);
  }

  const dateLabel = dayjs(dateStr).format('M月D日(ddd)');
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      { type: 'text', text: `${store.name} ${dateLabel}\n出勤しているスタッフを選んでください` },
      buildStaffSelectionMessage(store.id, dateStr, store.name, shiftsWithStaff, extraParamsFrom(data)),
    ],
  });
}

/**
 * シフトのブロック一覧から、指定した時間(分)で予約可能な開始時刻を計算する共通処理。
 * (通常予約と、チケット会員の45分/60分選択の両方から使う)
 * 開始時刻は常に「00分」のみになる。
 */
async function computeBookableSlots(calendarId, dateStr, blocks, durationMinutes, calendarOptions = {}) {
  let bookableSlots = [];
  for (const block of blocks) {
    const options = typeof calendarOptions === 'function' ? calendarOptions(block) : calendarOptions;
    const freeSlots = await getAvailableSlots(dateStr, calendarId, block.start, block.end, options);
    bookableSlots = bookableSlots.concat(getBookableStartTimes(freeSlots, durationMinutes));
  }
  bookableSlots.sort((a, b) => a.start.valueOf() - b.start.valueOf());
  return bookableSlots;
}

async function handleSelectStaff(event, data) {
  const store = getStore(data.storeId);
  const staff = findStaff(data.staffId);
  const dateStr = data.date;
  const userId = event.source.userId;

  if (!store || !staff) {
    return replyText(event, 'スタッフ情報が見つかりませんでした。もう一度お試しください。');
  }

  const { shifts } = getShiftsForDate(store.id, dateStr);
  // 同じスタッフが同じ日に複数の時間帯(飛び飛びのシフト)を持つ場合があるため、
  // 該当するエントリすべてを対象に空き時間を計算する
  const blocks = shifts.filter((s) => s.staffId === staff.id);

  if (blocks.length === 0) {
    return replyText(event, 'この日はシフト情報が見つかりませんでした。もう一度お試しください。');
  }

  let isBlocked = false;
  try {
    isBlocked = await hasFullDayBlock(staff.calendarId, dateStr, config.booking.fullDayBlockKeyword);
  } catch (err) {
    console.error(`終日休みブロックの確認でエラー(${staff.name}):`, err);
  }
  if (isBlocked) {
    return replyText(event, `${staff.name}さんはこの日お休みのため、ご予約いただけません。`);
  }

  // チケット会員は、残っている方の時間(45分/60分)を自動的に使う
  // (両方残っている場合は基本想定しないが、念のため両方残っていれば45分を優先する)
  // 月会費メンバーは、登録したコースのセッション時間を使う(未設定ならデフォルト時間)
  let durationMinutes = config.booking.durationMinutes;
  if (await isMember(userId)) {
    const sessionDuration = await memberStore.getSessionDuration(userId);
    if (sessionDuration) {
      durationMinutes = sessionDuration;
    }
  } else if (await ticketStore.isTicketCustomer(userId)) {
    const balances = await ticketStore.getBalances(userId);
    if (balances[45] > 0) {
      durationMinutes = 45;
    } else if (balances[60] > 0) {
      durationMinutes = 60;
    } else {
      return replyText(event, 'チケットの残数がありません。ご購入後にあらためてご予約ください。');
    }
  }

  let bookingName = await customerStore.getName(userId);
  if (data.mode === 'change' && data.bookingId) {
    const oldBooking = await bookingStore.getBooking(data.bookingId);
    bookingName = oldBooking?.customerName || bookingName;
  }
  const storeCalendarIds = getStoreCalendarIds(store.id, dateStr);
  const pairBooking = isPairBookingName(bookingName);
  const bookableSlots = await computeBookableSlots(
    staff.calendarId,
    dateStr,
    blocks,
    durationMinutes,
    pairBooking
      ? (block) => ({ allCalendarIds: getStoreCalendarIds(store.id, dateStr, block.start, block.end) })
      : { allCalendarIds: [staff.calendarId], pairCalendarIds: storeCalendarIds, targetStoreId: store.id }
  );

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      buildSlotSelectionMessage(
        store.id,
        staff.id,
        dateStr,
        staff.name,
        combineShiftLabel(blocks),
        bookableSlots,
        extraParamsFrom(data)
      ),
    ],
  });
}

/**
 * 管理者がチケットのパッケージ(時間・枚数)を選んだ後、対象のお客様のIDを尋ねる。
 */
async function handleSelectTicketPackage(event, data) {
  const adminUserId = event.source.userId;
  if (!config.adminUserIds.includes(adminUserId)) {
    return null; // 管理者以外には反応しない
  }
  const duration = Number(data.duration);
  const count = Number(data.count);
  pendingTicketAdmin.set(adminUserId, { step: 'awaiting_customer_id', duration, count });
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [buildAdminAskCustomerIdMessage(duration, count)],
  });
}

async function handleSelectSlot(event, data) {
  const userId = event.source.userId;
  const store = getStore(data.storeId);
  const staff = findStaff(data.staffId);

  if (!store || !staff || !userId) {
    return replyText(event, '情報が見つかりませんでした。もう一度「予約」からやり直してください。');
  }

  const maxDateStr = await effectiveMaxDateStr(userId);
  if (data.date > maxDateStr) {
    return replyText(
      event,
      `大変申し訳ございませんが、来月分のご予約は今月${await memberBookingReleaseLabel(userId)}から受け付けます。`
    );
  }

  // 変更フローの場合は、お名前を再度聞かず、元の予約の名前をそのまま使って即座に変更を実行する
  if (data.mode === 'change' && data.bookingId) {
    return finalizeChange(event, data.bookingId, {
      storeId: store.id,
      storeName: store.name,
      staffId: staff.id,
      staffName: staff.name,
      calendarId: staff.calendarId,
      staffLineUserId: staff.lineUserId,
      dateStr: data.date,
      startTime: data.start,
      endTime: data.end,
    });
  }

  // 通常の新規予約。必要な情報を一時保存する。
  pendingBookings.set(userId, {
    storeId: store.id,
    storeName: store.name,
    staffId: staff.id,
    staffName: staff.name,
    calendarId: staff.calendarId,
    staffLineUserId: staff.lineUserId,
    dateStr: data.date,
    startTime: data.start,
    endTime: data.end,
  });

  // 顧客紐付け済みなら登録名をそのまま使い、名前の再入力なしで予約を確定する。
  const linkedName = await customerStore.getName(userId);
  if (linkedName) {
    return finalizeBooking(event, userId, linkedName);
  }

  // 未紐付けの利用者だけ、従来どおり名前を尋ねる。
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [buildNamePromptMessage(store.name, staff.name, data.date, data.start, data.end)],
  });
}

async function finalizeBooking(event, userId, customerName) {
  const booking = pendingBookings.get(userId);
  pendingBookings.delete(userId); // 成功・失敗にかかわらず入力待ち状態は解除する

  const durationMinutes = timeDiffMinutes(booking.startTime, booking.endTime);

  // 時間選択後に別予約が入る競合も防ぐため、確定直前に店舗全体の条件を再確認する。
  const finalFree = await getAvailableSlots(
    booking.dateStr,
    booking.calendarId,
    booking.startTime,
    booking.endTime,
    isPairBookingName(customerName)
      ? { allCalendarIds: getStoreCalendarIds(booking.storeId, booking.dateStr, booking.startTime, booking.endTime), bypassCache: true }
      : {
          allCalendarIds: [booking.calendarId],
          pairCalendarIds: getStoreCalendarIds(booking.storeId, booking.dateStr),
          targetStoreId: booking.storeId,
          bypassCache: true,
        }
  );
  if (!finalFree.some((slot) => slot.end.diff(slot.start, 'minute') >= durationMinutes)) {
    return replyText(event, '申し訳ございません。選択中にこの時間帯が埋まりました。もう一度「予約」からお選びください。');
  }

  const entitlement = await resolveBookingUsage(userId, booking.dateStr, durationMinutes);
  if (!entitlement.available) {
    return replyText(
      event,
      entitlement.monthlyMember
        ? '月会費の予約枠と追加チケットの残数を超えるため、予約できません。'
        : 'チケット残数を超える予約はできません。'
    );
  }

  let created;
  try {
    created = await createBooking({
      dateStr: booking.dateStr,
      startTime: booking.startTime,
      endTime: booking.endTime,
      calendarId: booking.calendarId,
      summary: `${customerName}様`,
      description: `LINE予約Botからの自動登録\nお名前: ${customerName}様\n店舗: ${booking.storeName}\n利用: ${entitlement.usageType === 'ticket' ? '追加チケット' : entitlement.usageType === 'membership' ? '月会費' : '通常'}`,
    });
  } catch (err) {
    console.error('カレンダー登録でエラー:', err);
    return replyText(
      event,
      '予約の登録中にエラーが発生しました。お手数ですが、店舗まで直接ご連絡ください。'
    );
  }

  // 予約データを保存(変更・キャンセルの際にこれを参照する)
  const bookingId = await bookingStore.addBooking({
    userId,
    storeId: booking.storeId,
    storeName: booking.storeName,
    staffId: booking.staffId,
    staffName: booking.staffName,
    calendarId: booking.calendarId,
    eventId: created.id,
    dateStr: booking.dateStr,
    startTime: booking.startTime,
    endTime: booking.endTime,
    durationMinutes,
    usageType: entitlement.usageType,
    customerName,
  });

  // お客様に確定メッセージを返す
  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      buildBookingConfirmedMessage(
        booking.storeName,
        booking.staffName,
        booking.dateStr,
        booking.startTime,
        booking.endTime,
        customerName
      ),
    ],
  });

  // 予約日の前日に入った新規予約だけ、会社グループへ通知する。
  await notifyCompanyForTomorrow(
    booking.dateStr,
    buildStaffNotificationMessage(
      booking.storeName,
      booking.dateStr,
      booking.startTime,
      booking.endTime,
      customerName,
      bookingId,
      false // チケットは予約開始時刻に自動消費するため、手動ボタンは表示しない
    )
  );

  return null;
}

async function handleStartChange(event, data) {
  const booking = await bookingStore.getBooking(data.bookingId);
  if (!booking || !await canAccessBooking(event.source.userId, booking) || booking.status !== 'confirmed') {
    return replyText(event, 'この予約は見つかりませんでした。「予約確認」からやり直してください。');
  }
  if (booking.dateStr <= todayStr()) {
    return replyText(event, '大変申し訳ございませんが、当日のご予約の変更はお受けできません。お電話にてご連絡ください。');
  }

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [
      { type: 'text', text: '変更後の店舗・日付・スタッフ・時間を選び直してください。' },
      buildStoreSelectionMessage(`&mode=change&bookingId=${booking.bookingId}`),
    ],
  });
}

async function finalizeChange(event, oldBookingId, newDetails) {
  const oldBooking = await bookingStore.getBooking(oldBookingId);
  if (!oldBooking || !await canAccessBooking(event.source.userId, oldBooking) || oldBooking.status !== 'confirmed') {
    return replyText(event, '変更元の予約が見つかりませんでした。「予約確認」からやり直してください。');
  }
  if (oldBooking.dateStr <= todayStr()) {
    return replyText(event, '大変申し訳ございませんが、当日のご予約の変更はお受けできません。お電話にてご連絡ください。');
  }

  const userId = event.source.userId;
  const customerName = oldBooking.customerName;
  const newDurationMinutes = timeDiffMinutes(newDetails.startTime, newDetails.endTime);

  const entitlement = await resolveBookingUsage(userId, newDetails.dateStr, newDurationMinutes, oldBookingId);
  if (!entitlement.available) {
    return replyText(
      event,
      entitlement.monthlyMember
        ? '月会費の予約枠と追加チケットの残数を超えるため、変更できません。'
        : 'チケット残数を超えるため、変更できません。'
    );
  }

  // 変更操作中に別予約が入った場合も、確定直前の再確認で重複を防ぐ。
  const changeFree = await getAvailableSlots(
    newDetails.dateStr,
    newDetails.calendarId,
    newDetails.startTime,
    newDetails.endTime,
    isPairBookingName(customerName)
      ? { allCalendarIds: getStoreCalendarIds(newDetails.storeId, newDetails.dateStr, newDetails.startTime, newDetails.endTime), bypassCache: true }
      : {
          allCalendarIds: [newDetails.calendarId],
          pairCalendarIds: getStoreCalendarIds(newDetails.storeId, newDetails.dateStr),
          targetStoreId: newDetails.storeId,
          bypassCache: true,
        }
  );
  if (!changeFree.some((slot) => slot.end.diff(slot.start, 'minute') >= newDurationMinutes)) {
    return replyText(event, '申し訳ございません。選択中にこの時間帯が埋まりました。もう一度「予約確認」から変更してください。');
  }

  let created;
  try {
    created = await createBooking({
      dateStr: newDetails.dateStr,
      startTime: newDetails.startTime,
      endTime: newDetails.endTime,
      calendarId: newDetails.calendarId,
      summary: `${customerName}様`,
      description: `LINE予約Botからの自動登録(変更)\nお名前: ${customerName}様\n店舗: ${newDetails.storeName}\n利用: ${entitlement.usageType === 'ticket' ? '追加チケット' : entitlement.usageType === 'membership' ? '月会費' : '通常'}`,
    });
  } catch (err) {
    console.error('カレンダー登録(変更)でエラー:', err);
    return replyText(event, '予約の変更中にエラーが発生しました。お手数ですが、店舗まで直接ご連絡ください。');
  }

  // 古い予約を削除(カレンダー・ストア両方)
  try {
    await deleteBooking(oldBooking.calendarId, oldBooking.eventId);
  } catch (err) {
    console.error('旧予約のカレンダー削除でエラー:', err);
    // カレンダー削除に失敗しても、新しい予約自体は成立させる(手動でのフォローが必要になる)
  }
  await bookingStore.cancelBooking(oldBookingId);

  const newBooking = {
    userId,
    storeId: newDetails.storeId,
    storeName: newDetails.storeName,
    staffId: newDetails.staffId,
    staffName: newDetails.staffName,
    calendarId: newDetails.calendarId,
    eventId: created.id,
    dateStr: newDetails.dateStr,
    startTime: newDetails.startTime,
    endTime: newDetails.endTime,
    durationMinutes: newDurationMinutes,
    usageType: entitlement.usageType,
    customerName,
  };
  const newBookingId = await bookingStore.addBooking(newBooking);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [buildChangeConfirmedMessage(oldBooking, newBooking)],
  });

  // 変更前または変更後が明日の予約なら、会社グループへその場で通知する。
  if (isTomorrow(oldBooking.dateStr) || isTomorrow(newBooking.dateStr)) {
    await notifyStaff(
      config.adminNotificationGroupId,
      '会社グループ',
      buildStaffChangeNotificationMessage(oldBooking, newBooking)
    );
  }

  return null;
}

async function handleStartCancel(event, data) {
  const booking = await bookingStore.getBooking(data.bookingId);
  if (!booking || !await canAccessBooking(event.source.userId, booking) || booking.status !== 'confirmed') {
    return replyText(event, 'この予約は見つかりませんでした。「予約確認」からやり直してください。');
  }
  if (booking.dateStr <= todayStr()) {
    return replyText(event, '大変申し訳ございませんが、当日のご予約のキャンセルはお受けできません。お電話にてご連絡ください。');
  }

  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [buildCancelConfirmMessage(booking)],
  });
}

async function handleConfirmCancel(event, data) {
  const booking = await bookingStore.getBooking(data.bookingId);
  if (!booking || !await canAccessBooking(event.source.userId, booking) || booking.status !== 'confirmed') {
    return replyText(event, 'この予約はすでにキャンセルされているか、見つかりませんでした。');
  }
  if (booking.dateStr <= todayStr()) {
    return replyText(event, '大変申し訳ございませんが、当日のご予約のキャンセルはお受けできません。お電話にてご連絡ください。');
  }

  try {
    await deleteBooking(booking.calendarId, booking.eventId);
  } catch (err) {
    console.error('カレンダー削除でエラー:', err);
    return replyText(event, 'キャンセル処理中にエラーが発生しました。お手数ですが、店舗まで直接ご連絡ください。');
  }
  await bookingStore.cancelBooking(booking.bookingId);

  await client.replyMessage({
    replyToken: event.replyToken,
    messages: [buildCancelledMessage(booking)],
  });

  // 明日の予約がキャンセルされた時だけ、会社グループへ通知する。
  await notifyCompanyForTomorrow(
    booking.dateStr,
    buildStaffCancelNotificationMessage(booking)
  );

  return null;
}

/**
 * スタッフが「来店確認」ボタンを押した時の処理。
 * その予約を来店確認済みにし、対象のお客様がチケット会員であればチケットを1枚消費する。
 */
async function handleConfirmAttendance(event, data) {
  const booking = await bookingStore.getBooking(data.bookingId);
  if (!booking || booking.status !== 'confirmed') {
    return replyText(event, 'この予約が見つかりませんでした(既にキャンセルされている可能性があります)。');
  }
  if (booking.attended) {
    return replyText(event, `${booking.customerName}様は既に来店確認済みです。`);
  }

  const dueUsage = await prepareDueBookingUsage(booking);
  if (dueUsage.consumeTicket && await ticketStore.isTicketCustomer(booking.userId)) {
    const balances = await ticketStore.getBalances(booking.userId);
    const duration = ticketStore.selectTicketDuration(
      balances,
      booking.durationMinutes || config.booking.durationMinutes
    );
    const remainingBalance = await ticketStore.decrementTicket(booking.userId, duration);
    await bookingStore.markAttended(booking.bookingId);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildAttendanceConfirmedMessage(booking.customerName, duration, remainingBalance)],
    });
  }

  await bookingStore.markAttended(booking.bookingId);
  return replyText(event, `${booking.customerName}様の来店を確認しました。`);
}

/**
 * お客様が会員種別メニューから「月会費メンバーになる」「チケット会員になる」を選んだ時の処理。
 */
async function handleBecomeMemberType(event, data) {
  const userId = event.source.userId;
  const knownNames = await bookingStore.getDistinctCustomerNames(userId);
  const name = knownNames[0] || null;

  if (data.type === 'monthly') {
    if (await memberStore.isMember(userId)) {
      // 既に登録済みの場合、ここから再登録(変更)はさせない(店舗側での変更のみ許可)
      const quota = await memberStore.getMonthlyQuota(userId);
      const duration = await memberStore.getSessionDuration(userId);
      return client.replyMessage({
        replyToken: event.replyToken,
        messages: [buildMonthlyMemberStatusMessage(duration, quota)],
      });
    }
    const duration = Number(data.duration);
    const quota = Number(data.quota);
    if (!duration || !quota) {
      return replyText(event, 'コースの指定が正しくありませんでした。もう一度「会員種別」からお試しください。');
    }
    await memberStore.addMember(userId, name, quota, duration);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildMemberTypeChangedWithPlanMessage(duration, quota)],
    });
  }

  if (data.type === 'ticket') {
    await ticketStore.registerAsTicketCustomer(userId, name);
    return client.replyMessage({
      replyToken: event.replyToken,
      messages: [buildMemberTypeChangedMessage('チケット会員')],
    });
  }

  return replyText(event, '種別の指定が正しくありませんでした。もう一度「会員種別」からお試しください。');
}

async function notifyStaff(staffLineUserId, staffName, message) {
  if (!staffLineUserId) {
    console.log(`(通知スキップ) ${staffName} さんはLINEユーザーIDが未設定のため、通知を送信しませんでした。`);
    return;
  }
  try {
    await client.pushMessage({ to: staffLineUserId, messages: [message] });
  } catch (err) {
    // 通知に失敗しても、お客様側の処理自体は成功しているのでエラーはログのみに留める
    console.error(`${staffName} さんへのLINE通知でエラー:`, err);
  }
}

function replyText(event, text) {
  return client.replyMessage({
    replyToken: event.replyToken,
    messages: [{ type: 'text', text }],
  });
}

if (require.main === module) {
  app.listen(config.port, () => {
    console.log(`Server listening on port ${config.port}`);
  });
}

module.exports = { app, isCustomerLinkPendingActive };

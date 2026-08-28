const { google } = require('googleapis');
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('./config');
const { getStoreForStaffAtTime } = require('./shiftSchedule');

dayjs.extend(utc);
dayjs.extend(timezone);

const CACHE_TTL_MS = 15 * 1000;
const calendarCache = new Map();
let sharedCalendarClient = null;

function cached(key, loader, bypass = false) {
  const now = Date.now();
  const existing = calendarCache.get(key);
  if (!bypass && existing && existing.expiresAt > now) return existing.promise;
  const promise = Promise.resolve().then(loader).catch((error) => {
    calendarCache.delete(key);
    throw error;
  });
  calendarCache.set(key, { promise, expiresAt: now + CACHE_TTL_MS });
  return promise;
}

function clearCalendarCache() {
  calendarCache.clear();
}

function pairEventBelongsToStore(calendarId, event, targetStoreId) {
  if (!targetStoreId) return true;
  if (!event?.start?.dateTime) return false;
  const explicitStore = [event.summary, event.description, event.location]
    .filter(Boolean)
    .join('\n');
  if (explicitStore.includes('自由が丘')) return targetStoreId === 'jiyugaoka';
  if (explicitStore.includes('元住吉')) return targetStoreId === 'motosumiyoshi';
  const staff = config.staff.find((item) => item.calendarId === calendarId);
  if (!staff) return false;
  const start = dayjs(event.start.dateTime).tz(config.business.timezone);
  const store = getStoreForStaffAtTime(staff.id, start.format('YYYY-MM-DD'), start.format('HH:mm'));
  return store?.id === targetStoreId;
}

/**
 * サービスアカウントの認証情報からGoogle Calendar APIクライアントを作成する。
 * GOOGLE_SERVICE_ACCOUNT_KEY_BASE64 は鍵JSON全体をBase64エンコードした文字列。
 *
 * 予約をカレンダーに書き込む(events.insert)ため、readonlyではなく
 * 書き込み可能な "calendar" スコープを使う。
 * そのため、各スタッフのカレンダー共有設定も
 * 「予定の変更権限」以上にしてもらう必要がある(READMEを参照)。
 */
function getCalendarClient() {
  if (sharedCalendarClient) return sharedCalendarClient;
  const keyJson = JSON.parse(
    Buffer.from(config.google.serviceAccountKeyBase64, 'base64').toString('utf-8')
  );

  const auth = new google.auth.GoogleAuth({
    credentials: keyJson,
    scopes: ['https://www.googleapis.com/auth/calendar'],
  });

  sharedCalendarClient = google.calendar({ version: 'v3', auth });
  return sharedCalendarClient;
}

async function getDayEvents(calendarId, dateStr, bypassCache = false) {
  const tz = config.business.timezone;
  const timeMin = dayjs.tz(`${dateStr} 00:00`, tz).toISOString();
  const timeMax = dayjs.tz(`${dateStr} 00:00`, tz).add(1, 'day').toISOString();
  return cached(`events:${calendarId}:${dateStr}`, async () => {
    const res = await getCalendarClient().events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
    });
    return res.data.items || [];
  }, bypassCache);
}

async function loadCalendarWindow(startDateStr, endDateStr, calendarIds, bypassCache = false) {
  const tz = config.business.timezone;
  const ids = [...new Set(calendarIds)].sort();
  const timeMin = dayjs.tz(`${startDateStr} 00:00`, tz).toISOString();
  const timeMax = dayjs.tz(`${endDateStr} 00:00`, tz).add(1, 'day').toISOString();
  const key = `window:${startDateStr}:${endDateStr}:${ids.join(',')}`;
  return cached(key, async () => {
    const calendar = getCalendarClient();
    const [freeBusy, ...eventResponses] = await Promise.all([
      calendar.freebusy.query({
        requestBody: {
          timeMin,
          timeMax,
          timeZone: tz,
          items: ids.map((id) => ({ id })),
        },
      }),
      ...ids.map((calendarId) => calendar.events.list({
        calendarId,
        timeMin,
        timeMax,
        singleEvents: true,
      })),
    ]);
    return {
      busyByCalendar: Object.fromEntries(ids.map((id) => [id, freeBusy.data.calendars[id]?.busy || []])),
      eventsByCalendar: Object.fromEntries(ids.map((id, index) => [id, eventResponses[index].data.items || []])),
    };
  }, bypassCache);
}

/**
 * 指定日(YYYY-MM-DD)・指定カレンダー・指定の勤務時間帯における空き時間帯を計算する。
 * calendarId: スタッフのGoogleカレンダーID
 * shiftStart/shiftEnd: "HH:mm"形式。省略時はconfigの営業時間(終日勤務扱い)を使う。
 * 戻り値: [{ start: dayjs, end: dayjs }, ...] 空き枠のリスト
 */
async function getAvailableSlots(dateStr, calendarId, shiftStart, shiftEnd, options = {}) {
  const tz = config.business.timezone;
  const startTime = shiftStart || `${pad(config.business.startHour)}:00`;
  const endTime = shiftEnd || `${pad(config.business.endHour)}:00`;
  const dayStart = dayjs.tz(`${dateStr} ${startTime}`, tz);
  const dayEnd = dayjs.tz(`${dateStr} ${endTime}`, tz);

  const calendar = getCalendarClient();

  const allCalendarIds = [...new Set(options.allCalendarIds || [calendarId])];
  const pairCalendarIds = [...new Set(options.pairCalendarIds || [])];
  const freeBusyKey = `freebusy:${dayStart.toISOString()}:${dayEnd.toISOString()}:${allCalendarIds.slice().sort().join(',')}`;
  let busyRaw;
  if (options.window) {
    busyRaw = allCalendarIds.flatMap((id) => options.window.busyByCalendar[id] || []);
  } else {
    const res = await cached(freeBusyKey, () => calendar.freebusy.query({
      requestBody: {
        timeMin: dayStart.toISOString(),
        timeMax: dayEnd.toISOString(),
        timeZone: tz,
        items: allCalendarIds.map((id) => ({ id })),
      },
    }), options.bypassCache);
    busyRaw = allCalendarIds.flatMap((id) => res.data.calendars[id]?.busy || []);
  }

  // 通常予約でも、同じ店舗の別スタッフに入っている「ペア」予定は店舗全体を塞ぐ。
  for (const id of pairCalendarIds) {
    const events = options.window?.eventsByCalendar[id]
      || await getDayEvents(id, dateStr, options.bypassCache);
    for (const ev of events) {
      if (!(ev.summary || '').includes('ペア') || !ev.start?.dateTime || !ev.end?.dateTime) continue;
      const eventStart = dayjs(ev.start.dateTime).tz(tz);
      const eventEnd = dayjs(ev.end.dateTime).tz(tz);
      if (!eventStart.isBefore(dayEnd) || !eventEnd.isAfter(dayStart)) continue;
      // 同じスタッフカレンダーに別店舗の予約があっても、対象店舗の枠は塞がない。
      if (!pairEventBelongsToStore(id, ev, options.targetStoreId)) continue;
      busyRaw.push({ start: ev.start.dateTime, end: ev.end.dateTime });
    }
  }

  const busy = busyRaw
    .filter((b) => dayjs(b.start).isBefore(dayEnd) && dayjs(b.end).isAfter(dayStart))
    // dayjs(b.start)だけだとタイムゾーン情報が付かず、サーバーの実行環境(Cloud RunはUTC)によっては
    // 表示時に時刻がズレてしまうため、明示的に営業時間と同じタイムゾーンを付与する
    .map((b) => ({ start: dayjs(b.start).tz(tz), end: dayjs(b.end).tz(tz) }))
    .sort((a, b) => a.start.valueOf() - b.start.valueOf());

  // 営業時間からbusyを差し引いて空き枠を作る
  const freeSlots = [];
  let cursor = dayStart;

  for (const b of busy) {
    if (b.start.isAfter(cursor)) {
      freeSlots.push({ start: cursor, end: b.start });
    }
    if (b.end.isAfter(cursor)) {
      cursor = b.end;
    }
  }
  if (cursor.isBefore(dayEnd)) {
    freeSlots.push({ start: cursor, end: dayEnd });
  }

  // 1分未満の隙間は無視する
  return freeSlots.filter((s) => s.end.diff(s.start, 'minute') >= 1);
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/**
 * 空き時間帯のリストから、固定の予約時間(durationMinutes)で
 * 予約可能な開始時刻の一覧を作る。
 * 例: 空き時間帯が10:00〜13:00で、durationMinutes=60の場合、
 *     10:00, 11:00, 12:00 の3つの開始時刻を返す(12:00開始なら13:00に終わるのでOK)。
 *
 * intervalMinutes: 開始時刻の間隔。省略時はdurationMinutesと同じ(枠が重ならない形)。
 * 戻り値: [{ start: dayjs, end: dayjs }, ...]
 */
/**
 * 空き時間帯のリストから、固定の予約時間(durationMinutes)で
 * 予約可能な開始時刻を作る。
 * 開始時刻は必ず「00分(時間ちょうど)」のみを候補にする
 * (例: 9:00, 10:00, 11:00... であり、9:45や10:30のような開始時刻は作らない)。
 *
 * 戻り値: [{ start: dayjs, end: dayjs }, ...]
 */
function getBookableStartTimes(freeSlots, durationMinutes) {
  if (freeSlots.length === 0) return [];

  const overallStart = freeSlots[0].start;
  const overallEnd = freeSlots[freeSlots.length - 1].end;

  // 最初の「00分」の候補時刻まで切り上げる(例: 9:20開始なら10:00から候補にする)
  let cursor =
    overallStart.minute() === 0 ? overallStart : overallStart.startOf('hour').add(1, 'hour');

  const results = [];
  while (cursor.add(durationMinutes, 'minute').isBefore(overallEnd.add(1, 'second'))) {
    const candidateEnd = cursor.add(durationMinutes, 'minute');
    // この候補の開始〜終了が、いずれかの空き枠にすっぽり収まっているか確認する
    const fits = freeSlots.some((slot) => !cursor.isBefore(slot.start) && !candidateEnd.isAfter(slot.end));
    if (fits) {
      results.push({ start: cursor, end: candidateEnd });
    }
    cursor = cursor.add(1, 'hour');
  }

  return results;
}

/**
 * スタッフのGoogleカレンダーに予約(予定)を登録する。
 * dateStr: "YYYY-MM-DD", startTime/endTime: "HH:mm"
 * 戻り値: 作成されたイベント情報(Google Calendar API のレスポンス)
 */
async function createBooking({ dateStr, startTime, endTime, calendarId, summary, description }) {
  const tz = config.business.timezone;
  const start = dayjs.tz(`${dateStr} ${startTime}`, tz);
  const end = dayjs.tz(`${dateStr} ${endTime}`, tz);

  const calendar = getCalendarClient();

  const res = await calendar.events.insert({
    calendarId,
    requestBody: {
      summary,
      description,
      start: { dateTime: start.toISOString(), timeZone: tz },
      end: { dateTime: end.toISOString(), timeZone: tz },
    },
  });
  clearCalendarCache();
  return res.data;
}

async function updateCalendarBooking(calendarId, eventId, patch) {
  const calendar = getCalendarClient();
  const res = await calendar.events.patch({ calendarId, eventId, requestBody: patch });
  clearCalendarCache();
  return res.data;
}

/**
 * スタッフのGoogleカレンダーから予約(予定)を削除する。
 */
async function deleteBooking(calendarId, eventId) {
  const calendar = getCalendarClient();
  await calendar.events.delete({ calendarId, eventId });
  clearCalendarCache();
}

/**
 * 指定した名前を含む、指定日以降の予定をカレンダーからすべて検索する。
 * (LINE経由ではなく、Googleカレンダーに直接入力された予約を見つけるために使う)
 * 戻り値: [{ id, summary, dateStr, startTime, endTime }, ...]
 */
async function searchEventsByName(calendarId, name, fromDateStr) {
  const tz = config.business.timezone;
  const timeMin = dayjs.tz(`${fromDateStr} 00:00`, tz).toISOString();
  const calendar = getCalendarClient();

  const items = [];
  let pageToken;
  do {
    const res = await calendar.events.list({
      calendarId,
      q: name,
      timeMin,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    items.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken;
  } while (pageToken);

  return items
    // 終日予定や記念日を顧客予約として取り込まない。開始・終了時刻のある予定だけを対象にする。
    .filter((ev) => ev.start?.dateTime && ev.end?.dateTime)
    .map((ev) => {
      const start = dayjs(ev.start.dateTime || ev.start.date).tz(tz);
      const end = dayjs(ev.end.dateTime || ev.end.date).tz(tz);
      return {
        id: ev.id,
        summary: ev.summary || '',
        dateStr: start.format('YYYY-MM-DD'),
        startTime: start.format('HH:mm'),
        endTime: end.format('HH:mm'),
      };
    });
}

/**
 * 指定した日に、指定したキーワード(例: "NG")の終日予定が入っているか確認する。
 * スタッフがイレギュラーに休みたい時、カレンダーに終日予定を1つ入れるだけで
 * その日の予約を丸ごと受け付けないようにするために使う。
 */
async function hasFullDayBlock(calendarId, dateStr, keyword, window = null) {
  const events = window?.eventsByCalendar[calendarId] || await getDayEvents(calendarId, dateStr);
  return events.some((ev) => {
    const isAllDay = ev.start && ev.start.date && !ev.start.dateTime; // 終日予定かどうか
    const titleMatches = (ev.summary || '').includes(keyword);
    const coversDate = !isAllDay || (ev.start.date <= dateStr && ev.end?.date > dateStr);
    return isAllDay && coversDate && titleMatches;
  });
}

module.exports = {
  getAvailableSlots,
  getBookableStartTimes,
  createBooking,
  updateCalendarBooking,
  deleteBooking,
  searchEventsByName,
  hasFullDayBlock,
  pairEventBelongsToStore,
  clearCalendarCache,
  loadCalendarWindow,
};

const dayjs = require('dayjs');
const config = require('./config');

function pad(n) {
  return String(n).padStart(2, '0');
}

// 「終日」の代わりに使う営業時間(.envのBUSINESS_HOUR_START/ENDと連動)
const BUSINESS_START = `${pad(config.business.startHour)}:00`;
const BUSINESS_END = `${pad(config.business.endHour)}:00`;

/**
 * 店舗の一覧。ここに店舗を追加すれば、LINEの店舗選択ボタンにも自動で反映される。
 */
const STORES = [
  {
    id: 'jiyugaoka',
    name: '自由が丘店',
    logoUrl: 'https://i.ibb.co/Zp4zV49b/2019-10-18-19-24-32.jpg',
    bookingLogoUrl: '/booking/jiyugaoka-store-logo.png',
  },
  {
    id: 'motosumiyoshi',
    name: '元住吉店',
    logoUrl: 'https://i.ibb.co/60YzbfTs/2026-08-05-1-37-02.png',
  },
];

/**
 * スタッフの顔写真URL。staffId(.envのSTAFF_LISTのidと一致させる)をキーにする。
 * 写真がない場合はキー自体を省略してよい(その場合は写真なしで表示される)。
 */
const STAFF_PHOTOS = {
  narita: 'https://i.ibb.co/YByYRsTc/image.jpg',
  furuya: 'https://i.ibb.co/TD14kxSj/image.jpg',
  ando: 'https://i.ibb.co/4RPJJyNN/image.jpg',
};

// dayjs().day() の数値(0=日,1=月,...6=土)を曜日キーに変換するための対応表
const WEEKDAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/**
 * 固定シフトの定義。
 * start/end が null の場合は「終日勤務」として扱う(店舗の営業時間をそのまま使う)。
 * time形式は "HH:mm"。
 *
 * 同じスタッフが同じ日に「飛び飛びの時間帯」で働く場合(例: 研修等で中抜けする場合)は、
 * 同じstaffIdのエントリを2つに分けて書く。
 * 例: 9:00〜14:00 と 16:00〜22:00 の間(14:00〜16:00)だけ空けたい場合、
 *     { staffId: 'narita', start: BUSINESS_START, end: '14:00' },
 *     { staffId: 'narita', start: '16:00', end: BUSINESS_END },
 * のように2つのエントリに分ける。
 *
 * ※ここを直接編集すれば、シフトパターンの変更にすぐ対応できる。
 */
const SCHEDULE = {
  jiyugaoka: {
    closedWeekdays: ['tue'], // 火曜定休
    mon: [{ staffId: 'narita', start: null, end: null }],
    tue: [],
    wed: [
      // 成田: 水曜研修のため14:00〜16:00は予約不可 → 前後2つに分割
      { staffId: 'narita', start: BUSINESS_START, end: '14:00' },
      { staffId: 'narita', start: '16:00', end: BUSINESS_END },
      { staffId: 'ando', start: '16:00', end: '21:00' },
    ],
    thu: [{ staffId: 'furuya', start: null, end: null }],
    fri: [{ staffId: 'narita', start: '09:00', end: '16:00' }],
    sat: [
      { staffId: 'narita', start: '09:00', end: '19:00' },
      { staffId: 'ando', start: '09:00', end: '13:00' },
    ],
    sun: [{ staffId: 'furuya', start: '09:00', end: '17:00' }],
  },
  motosumiyoshi: {
    closedWeekdays: ['tue'], // 火曜定休
    mon: [{ staffId: 'furuya', start: null, end: null }],
    tue: [],
    wed: [
      // 古屋: 水曜研修のため13:00〜16:00は予約不可 → 前後2つに分割
      { staffId: 'furuya', start: BUSINESS_START, end: '13:00' },
      { staffId: 'furuya', start: '16:00', end: BUSINESS_END },
    ],
    thu: [{ staffId: 'ando', start: null, end: null }],
    fri: [{ staffId: 'narita', start: '18:00', end: '22:00' }],
    sat: [{ staffId: 'furuya', start: '09:00', end: '20:00' }],
    sun: [
      { staffId: 'furuya', start: '18:00', end: '20:00' },
      { staffId: 'ando', start: '09:00', end: '14:00' },
    ],
  },
};

function getWeekdayKey(dateStr) {
  return WEEKDAY_KEYS[dayjs(dateStr).day()];
}

function getStore(storeId) {
  return STORES.find((s) => s.id === storeId);
}

/**
 * 指定した店舗・日付の、固定シフトに基づく出勤スタッフ一覧を返す。
 * 定休日の場合は { closed: true, shifts: [] } を返す。
 * shiftsは、1人のスタッフが複数エントリ(飛び飛びの時間帯)を持つ場合がある。
 */
function getShiftsForDate(storeId, dateStr) {
  const storeSchedule = SCHEDULE[storeId];
  if (!storeSchedule) {
    return { closed: false, shifts: [] };
  }

  const weekday = getWeekdayKey(dateStr);

  if (storeSchedule.closedWeekdays.includes(weekday)) {
    return { closed: true, shifts: [] };
  }

  return { closed: false, shifts: storeSchedule[weekday] || [] };
}

/**
 * シフトのエントリ一覧を、スタッフごとにまとめる。
 * 同じスタッフの飛び飛びの時間帯(複数エントリ)を1人分にグループ化するために使う。
 * 戻り値: [{ staffId, blocks: [{ start, end }, ...] }, ...] (出現順)
 */
function groupShiftsByStaff(shifts) {
  const order = [];
  const map = new Map();

  for (const shift of shifts) {
    if (!map.has(shift.staffId)) {
      map.set(shift.staffId, []);
      order.push(shift.staffId);
    }
    map.get(shift.staffId).push({ start: shift.start, end: shift.end });
  }

  return order.map((staffId) => ({ staffId, blocks: map.get(staffId) }));
}

/**
 * 指定したスタッフが、指定した日付にどの店舗のシフトに入っているかを調べる。
 * (Googleカレンダーに直接入力された予約には店舗の情報がないため、
 *  シフト表から逆引きするために使う)
 * 複数店舗のシフトに同時に入っている(通常はありえない)場合は最初に見つかったものを返す。
 * どの店舗にも見つからない場合は null を返す。
 */
function getStoreForStaffOnDate(staffId, dateStr) {
  for (const store of STORES) {
    const { closed, shifts } = getShiftsForDate(store.id, dateStr);
    if (!closed && shifts.some((s) => s.staffId === staffId)) {
      return store;
    }
  }
  return null;
}

module.exports = {
  STORES,
  STAFF_PHOTOS,
  getStore,
  getShiftsForDate,
  getWeekdayKey,
  getStoreForStaffOnDate,
  groupShiftsByStaff,
};

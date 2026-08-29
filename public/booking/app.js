const token = new URLSearchParams(location.search).get('token');
const changeBookingId = new URLSearchParams(location.search).get('changeBookingId');
const $ = (id) => document.getElementById(id);
let data;
let storeId;
let weekStart;
let availabilityRequest = 0;
const staffPhotoById = new Map();
const selections = new Map();

async function api(path, options = {}) {
  const separator = path.includes('?') ? '&' : '?';
  const changeParam = changeBookingId ? `&changeBookingId=${encodeURIComponent(changeBookingId)}` : '';
  const response = await fetch(`/api/web-booking/${path}${separator}token=${encodeURIComponent(token || '')}${changeParam}`, {
    headers: { 'content-type': 'application/json' }, ...options,
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'エラーが発生しました。');
  return result;
}

function parseDate(value) { return new Date(`${value}T00:00:00`); }
function ymd(date) { return date.toLocaleDateString('sv-SE'); }
function addDays(date, count) { const result = new Date(date); result.setDate(result.getDate() + count); return result; }
function sunday(date) { const result = new Date(date); result.setDate(result.getDate() - result.getDay()); result.setHours(0, 0, 0, 0); return result; }
function nthMonday(year, month, nth) { const first = new Date(year, month - 1, 1); return 1 + ((8 - first.getDay()) % 7) + (nth - 1) * 7; }

function japaneseHolidays(year) {
  const holidays = new Map();
  const add = (month, day, name) => holidays.set(ymd(new Date(year, month - 1, day)), name);
  add(1, 1, '元日'); add(1, nthMonday(year, 1, 2), '成人の日'); add(2, 11, '建国記念の日'); add(2, 23, '天皇誕生日');
  add(3, Math.floor(20.8431 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)), '春分の日');
  add(4, 29, '昭和の日'); add(5, 3, '憲法記念日'); add(5, 4, 'みどりの日'); add(5, 5, 'こどもの日');
  add(7, nthMonday(year, 7, 3), '海の日'); add(8, 11, '山の日'); add(9, nthMonday(year, 9, 3), '敬老の日');
  add(9, Math.floor(23.2488 + 0.242194 * (year - 1980) - Math.floor((year - 1980) / 4)), '秋分の日');
  add(10, nthMonday(year, 10, 2), 'スポーツの日'); add(11, 3, '文化の日'); add(11, 23, '勤労感謝の日');
  const originals = [...holidays.keys()].sort();
  for (const value of originals) {
    if (parseDate(value).getDay() !== 0) continue;
    let substitute = addDays(parseDate(value), 1);
    while (holidays.has(ymd(substitute))) substitute = addDays(substitute, 1);
    holidays.set(ymd(substitute), '振替休日');
  }
  for (let date = new Date(year, 0, 2); date.getFullYear() === year; date = addDays(date, 1)) {
    const value = ymd(date);
    if (!holidays.has(value) && holidays.has(ymd(addDays(date, -1))) && holidays.has(ymd(addDays(date, 1)))) holidays.set(value, '国民の休日');
  }
  return holidays;
}

function holidayFor(date) { return japaneseHolidays(date.getFullYear()).get(ymd(date)) || ''; }
function dayClass(date) { return date.getDay() === 6 ? 'saturday' : date.getDay() === 0 ? 'sunday' : holidayFor(date) ? 'holiday' : ''; }

async function init() {
  try {
    data = await api('bootstrap');
    storeId = data.stores[0].id;
    weekStart = sunday(parseDate(data.minDate));
    $('name').textContent = data.customer.name;
    if (data.changeBooking) {
      document.querySelector('.hello span').textContent = `現在の予約：${data.changeBooking.dateStr} ${data.changeBooking.startTime}〜${data.changeBooking.endTime}　変更後の時間をお選びください`;
      $('reviewSelections').textContent = '変更内容を確認する';
    }
    $('member').innerHTML = `<strong>${data.customer.memberType}</strong>${data.customer.membershipDetail ? `<span>${data.customer.membershipDetail}</span>` : ''}`;
    $('stores').innerHTML = data.stores.map((store) => {
      const logoUrl = store.bookingLogoUrl || store.logoUrl;
      return `<button data-id="${store.id}">${logoUrl ? `<img class="store-logo" src="${logoUrl}" alt="${store.name}ロゴ" onerror="this.hidden=true">` : ''}<span>${store.name}</span></button>`;
    }).join('');
    $('stores').onclick = (event) => {
      if (!event.target.dataset.id) return;
      storeId = event.target.dataset.id;
      renderStores();
      loadWeek();
    };
    renderStores();
    $('loading').hidden = true;
    $('app').hidden = false;
    await loadWeek();
    api('sync-external', { method:'POST', body:'{}' }).then((latest) => {
      data = latest;
      $('member').innerHTML = `<strong>${data.customer.memberType}</strong>${data.customer.membershipDetail ? `<span>${data.customer.membershipDetail}</span>` : ''}`;
    }).catch((error) => console.warn('Googleカレンダー直接予約の同期に失敗しました:', error));
  } catch (error) { showError(error.message); }
}

function renderStores() { [...$('stores').children].forEach((button) => button.classList.toggle('active', button.dataset.id === storeId)); }
function selectionKey(selection) { return `${selection.store}|${selection.date}|${selection.staff}|${selection.start}`; }
function updateSelectionBar() {
  $('selectionCount').textContent = selections.size;
  $('selectionBar').hidden = selections.size === 0;
}
function selectionLimitError(selection) {
  const allowance = data.bookingAllowance || { type:'unlimited' };
  if (allowance.type === 'ticket') {
    if (selections.size >= allowance.remaining) return `予約に使えるチケットは残り${allowance.remaining}回です。`;
  }
  if (allowance.type === 'monthly') {
    const proposed = [...selections.values(), selection];
    const selectedByMonth = {};
    let ticketNeeded = 0;
    for (const item of proposed) {
      if (item.date > allowance.monthlyMaxDate) {
        ticketNeeded += 1;
        continue;
      }
      const month = item.date.slice(0, 7);
      selectedByMonth[month] = (selectedByMonth[month] || 0) + 1;
    }
    ticketNeeded += Object.entries(selectedByMonth).reduce((total, [month, selected]) => {
      const monthlyRemaining = Math.max(0, allowance.quota - (allowance.usedByMonth?.[month] || 0));
      return total + Math.max(0, selected - monthlyRemaining);
    }, 0);
    if (ticketNeeded > (allowance.ticketRemaining || 0)) {
      return '月会費の予約枠と追加チケットの残数を超えるため、これ以上選択できません。';
    }
  }
  return '';
}
function markAllowanceUsed(selection) {
  const allowance = data.bookingAllowance;
  if (allowance?.type === 'ticket') allowance.remaining = Math.max(0, allowance.remaining - 1);
  if (allowance?.type === 'monthly') {
    // 予約完了後はサーバーから最新の利用区分を再取得するため、ここでは概算値を更新しない。
  }
}

async function loadWeek() {
  const requestId = ++availabilityRequest;
  const requestedStore = storeId;
  const start = ymd(weekStart);
  const weekDates = [...Array(7)].map((_, index) => addDays(weekStart, index));
  $('range').textContent = `${weekDates[0].getMonth() + 1}/${weekDates[0].getDate()} 〜 ${weekDates[6].getMonth() + 1}/${weekDates[6].getDate()}`;
  $('schedule').innerHTML = '<div class="empty">週間の空き枠を確認しています…</div>';
  try {
    const result = await api(`week-availability?storeId=${requestedStore}&start=${start}`);
    if (requestId !== availabilityRequest || requestedStore !== storeId) return;
    renderTimetable(result.dates, weekDates, requestedStore);
  } catch (error) {
    if (requestId === availabilityRequest) $('schedule').innerHTML = `<div class="empty error">${error.message}</div>`;
  }
}

function renderTimetable(days, weekDates, requestedStore) {
  const starts = [];
  const startHour = Number(data.businessHours?.start ?? 9);
  const endHour = Number(data.businessHours?.end ?? 22);
  for (let hour = startHour; hour < endHour; hour += 1) starts.push(`${String(hour).padStart(2, '0')}:00`);
  let html = '<div class="timetable"><div class="time-head"></div>';
  html += weekDates.map((date) => {
    const value = ymd(date);
    const holiday = holidayFor(date);
    const disabled = value < data.minDate || value > data.maxDate;
    const weekday = new Intl.DateTimeFormat('ja-JP', { weekday:'short' }).format(date);
    const dayData = days.find((day) => day.dateStr === value);
    const roster = [...new Map((dayData?.staff || []).map((staff) => [staff.id, staff])).values()];
    roster.forEach((staff) => staffPhotoById.set(staff.id, staff.photoUrl || ''));
    const rosterHtml = roster.length ? roster.map((staff) => `<i class="staff-pill staff-${staff.id}">${staff.name}</i>`).join('') : '―';
    return `<div class="day-head ${dayClass(date)} ${disabled ? 'disabled' : ''}">${date.getMonth() + 1}/${date.getDate()}<strong>${weekday}</strong>${holiday ? `<span class="holiday-name">${holiday}</span>` : ''}<span class="staff-roster">${rosterHtml}</span></div>`;
  }).join('');
  if (!starts.length) {
    html += `<div class="time-label">―</div><div class="slot-cell closed" style="grid-column:span 7;text-align:center;padding:28px;color:#777">この週は予約可能な枠がありません</div>`;
  } else {
    for (const start of starts) {
      html += `<div class="time-label">${start}</div>`;
      for (const day of days) {
        const choices = day.staff.flatMap((staff) => staff.slots.filter((slot) => slot.start === start).map((slot) => ({ ...slot, staff })));
        const availableHtml = choices.map((choice) => {
          const choiceData = { store: requestedStore, date: day.dateStr, staff: choice.staff.id, start: choice.start };
          const selected = selections.has(selectionKey(choiceData));
          const photo = choice.staff.photoUrl
            ? `<img class="slot-photo" src="${choice.staff.photoUrl}" alt="" loading="lazy" decoding="async" onerror="this.hidden=true">`
            : '';
          return `<button class="slot staff-${choice.staff.id} ${selected ? 'selected' : ''}" aria-label="${choice.staff.name} ${choice.start}から${choice.end}" aria-pressed="${selected}" data-store="${requestedStore}" data-date="${day.dateStr}" data-staff="${choice.staff.id}" data-name="${choice.staff.name}" data-start="${choice.start}" data-end="${choice.end}">${photo}<b>${selected ? '✓ ' : ''}${choice.staff.name}</b></button>`;
        }).join('');
        html += `<div class="slot-cell ${day.closed ? 'closed' : ''}">${availableHtml}</div>`;
      }
    }
  }
  $('schedule').innerHTML = `${html}</div>`;
  $('schedule').onclick = (event) => { const button = event.target.closest('.slot'); if (button) toggleSelection(button); };
}

function toggleSelection(button) {
  const selection = { ...button.dataset };
  const key = selectionKey(selection);
  if (selections.has(key)) {
    selections.delete(key);
  } else {
    if (changeBookingId) {
      selections.clear();
      document.querySelectorAll('.slot.selected').forEach((oldButton) => {
        oldButton.classList.remove('selected');
        oldButton.setAttribute('aria-pressed', 'false');
        const label = oldButton.querySelector('b');
        if (label) label.textContent = oldButton.dataset.name;
      });
    }
    const sameTime = [...selections.values()].some((item) => item.date === selection.date && item.start === selection.start);
    if (sameTime) return alert('同じ日時の予約は1件だけ選択できます。');
    const limitError = selectionLimitError(selection);
    if (limitError) return alert(limitError);
    selections.set(key, selection);
  }
  button.classList.toggle('selected', selections.has(key));
  button.setAttribute('aria-pressed', selections.has(key));
  button.querySelector('b').textContent = `${selections.has(key) ? '✓ ' : ''}${selection.name}`;
  updateSelectionBar();
}

function openConfirm() {
  const rows = [...selections.values()].sort((a, b) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  $('summary').innerHTML = `<div class="selection-summary">${rows.map((selection) => {
    const store = data.stores.find((item) => item.id === selection.store);
    const photo = staffPhotoById.get(selection.staff);
    return `<div class="selection-item">${photo ? `<img src="${photo}" alt="${selection.name}トレーナー">` : ''}<span><strong>${selection.date} ${selection.start}〜${selection.end}</strong><br>${store.name}／${selection.name}トレーナー</span></div>`;
  }).join('')}</div>`;
  $('confirm').hidden = false;
  $('confirm').textContent = changeBookingId ? 'この内容に変更する' : `${rows.length}件をまとめて予約する`;
  $('cancel').textContent = '戻る';
  $('modal').hidden = false;
}

$('reviewSelections').onclick = openConfirm;
$('cancel').onclick = () => { $('modal').hidden = true; };
$('confirm').onclick = async () => {
  const button = $('confirm');
  const queue = [...selections.entries()].sort(([, a], [, b]) => `${a.date} ${a.start}`.localeCompare(`${b.date} ${b.start}`));
  button.disabled = true;
  let completed = 0;
  let failure = null;
  for (const [key, item] of queue) {
    button.textContent = `予約しています… ${completed + 1}/${queue.length}`;
    try {
      await api(changeBookingId ? 'change' : 'book', { method:'POST', body:JSON.stringify({ storeId:item.store, dateStr:item.date, staffId:item.staff, startTime:item.start, endTime:item.end }) });
      selections.delete(key);
      markAllowanceUsed(item);
      completed += 1;
    } catch (error) { failure = error; break; }
  }
  updateSelectionBar();
  button.disabled = false;
  if (failure) {
    $('summary').innerHTML = `<strong>${completed}件の予約が完了しました</strong><br><span class="error">残りは予約できませんでした。<br>${failure.message}</span>`;
    button.hidden = true;
    $('cancel').textContent = '閉じる';
  } else {
    $('summary').innerHTML = `<strong>${changeBookingId ? '予約を変更しました' : `${completed}件の予約が完了しました`}</strong>`;
    button.hidden = true;
    $('cancel').textContent = '閉じる';
  }
  data = await api('bootstrap');
  $('member').innerHTML = `<strong>${data.customer.memberType}</strong>${data.customer.membershipDetail ? `<span>${data.customer.membershipDetail}</span>` : ''}`;
  await loadWeek();
};
$('prev').onclick = () => { weekStart = addDays(weekStart, -7); loadWeek(); };
$('next').onclick = () => { weekStart = addDays(weekStart, 7); loadWeek(); };
function showError(message) { $('loading').hidden = true; $('error').hidden = false; $('error').textContent = message; }

init();

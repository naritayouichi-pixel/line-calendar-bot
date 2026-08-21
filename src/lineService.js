const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
require('dayjs/locale/ja');
const config = require('./config');
const { STORES, STAFF_PHOTOS, getShiftsForDate } = require('./shiftSchedule');

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.locale('ja'); // 曜日を「月」「火」...のように日本語表記にする

function buildGoogleCalendarUrl({ storeName, staffName, dateStr, startTime, endTime, customerName }) {
  const compactDate = dateStr.replace(/-/g, '');
  const compactStart = startTime.replace(':', '');
  const compactEnd = endTime.replace(':', '');
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: `トレーニング予約（${storeName}）`,
    dates: `${compactDate}T${compactStart}00/${compactDate}T${compactEnd}00`,
    ctz: config.business.timezone,
    details: `担当: ${staffName}\nお名前: ${customerName}様`,
    location: storeName,
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

/**
 * 「店舗を選ぶ」ためのFlex Message(ロゴ画像のカルーセル、カード全体をタップして選択)。
 */
function buildStoreSelectionMessage(extraParams = '') {
  return {
    type: 'flex',
    altText: '空き状況を確認したい店舗を選んでください',
    contents: {
      type: 'carousel',
      contents: STORES.map((store) => {
        const action = {
          type: 'postback',
          label: `${store.name}を選ぶ`,
          data: `action=select_store&storeId=${store.id}${extraParams}`,
          displayText: `${store.name}を選択`,
        };
        return {
          type: 'bubble',
          size: 'micro',
          hero: {
            type: 'image',
            url: store.logoUrl,
            size: 'full',
            aspectRatio: '4:2',
            aspectMode: 'fit',
            action,
          },
          body: {
            type: 'box',
            layout: 'vertical',
            paddingAll: 'md',
            action,
            contents: [
              {
                type: 'text',
                text: store.name,
                weight: 'bold',
                size: 'sm',
                align: 'center',
              },
            ],
          },
        };
      }),
    },
  };
}

/**
 * 「日付を選ぶ」ためのFlex Message(選べる日付を一覧・グリッドで表示)。
 * LINE標準のdatetimepickerと違い、定休日をあらかじめ除外して表示できる。
 * storeId をdataに含めて、日付選択後にどの店舗のシフトを見るか分かるようにする。
 */
function buildDatePickerMessage(storeId, storeName, extraParams = '', maxDateStrOverride = null) {
  const today = dayjs().tz(config.business.timezone);
  const defaultMax = today.add(config.business.maxDaysAhead, 'day').format('YYYY-MM-DD');
  // 月会費メンバーの「来月分は25日から」制限がある場合、外部から上限日を指定できる
  const max = maxDateStrOverride && maxDateStrOverride < defaultMax ? maxDateStrOverride : defaultMax;

  // 明日から上限日までの日付を、定休日を除いてリストアップする
  const dateStrs = [];
  let cursor = today.add(1, 'day');
  while (cursor.format('YYYY-MM-DD') <= max) {
    const dateStr = cursor.format('YYYY-MM-DD');
    const { closed } = getShiftsForDate(storeId, dateStr);
    if (!closed) dateStrs.push(dateStr);
    cursor = cursor.add(1, 'day');
  }

  if (dateStrs.length === 0) {
    return {
      type: 'text',
      text: `${storeName}\n現在、ご予約いただける日付がありません。`,
    };
  }

  // 日付ボタンを1行3個ずつのグリッドに並べる(文字が省略されないよう幅を広めに取る)
  const COLUMNS = 3;
  const buttons = dateStrs.map((dateStr) => ({
    type: 'button',
    style: 'secondary',
    height: 'sm',
    action: {
      type: 'postback',
      label: dayjs(dateStr).format('M/D(ddd)'),
      data: `action=pick_date&storeId=${storeId}&date=${dateStr}${extraParams}`,
      displayText: `${dayjs(dateStr).format('M月D日(ddd)')}を選択`,
    },
  }));

  const rows = [];
  for (let i = 0; i < buttons.length; i += COLUMNS) {
    rows.push({
      type: 'box',
      layout: 'horizontal',
      spacing: 'xs',
      margin: i === 0 ? 'none' : 'xs',
      contents: buttons.slice(i, i + COLUMNS),
    });
  }

  return {
    type: 'flex',
    altText: `${storeName}のご予約日を選んでください`,
    contents: {
      type: 'bubble',
      size: 'giga',
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          { type: 'text', text: `${storeName}`, weight: 'bold', size: 'md' },
          {
            type: 'text',
            text: 'ご予約日を選んでください(当日のご予約はお受けできません)',
            size: 'xs',
            color: '#888888',
            wrap: true,
          },
          { type: 'separator', margin: 'md' },
          ...rows,
        ],
      },
    },
  };
}

/**
 * 定休日の場合の返信メッセージ。
 */
function buildClosedMessage(storeName, dateStr) {
  const dateLabel = dayjs(dateStr).format('YYYY年M月D日(ddd)');
  return {
    type: 'text',
    text: `${storeName}\n${dateLabel}は定休日です。`,
  };
}

/**
 * シフトの時間帯を「終日」または「9:00〜15:00」のような表示用文字列にする。
 */
function shiftTimeLabel(shift) {
  if (!shift.start || !shift.end) {
    return '終日';
  }
  return `${shift.start}〜${shift.end}`;
}

/**
 * 1人のスタッフが同じ日に複数の時間帯(飛び飛びのシフト)を持つ場合、
 * それらをまとめて表示用の文字列にする。
 * 例: [{start:'09:00',end:'14:00'}, {start:'16:00',end:'22:00'}] → "9:00〜14:00 / 16:00〜22:00"
 */
function combineShiftLabel(blocks) {
  return blocks.map(shiftTimeLabel).join(' / ');
}

/**
 * その日にシフトが入っているスタッフだけを表示するFlex Message(顔写真+選択ボタンのカルーセル)。
 * shiftsWithStaff: [{ staffId, name, blocks: [{start, end}, ...] }, ...]
 */
function buildStaffSelectionMessage(storeId, dateStr, storeName, shiftsWithStaff, extraParams = '') {
  const dateLabel = dayjs(dateStr).format('M月D日(ddd)');
  return {
    type: 'flex',
    altText: `${storeName} ${dateLabel} 出勤しているスタッフを選んでください`,
    contents: {
      type: 'carousel',
      contents: shiftsWithStaff.map((s) => {
        const photoUrl = STAFF_PHOTOS[s.staffId];
        const action = {
          type: 'postback',
          label: `${s.name}を選ぶ`,
          data: `action=select_staff&storeId=${storeId}&staffId=${s.staffId}&date=${dateStr}${extraParams}`,
          displayText: `${s.name}さんの空き状況を確認`,
        };
        return {
          type: 'bubble',
          size: 'nano',
          ...(photoUrl && {
            hero: {
              type: 'image',
              url: photoUrl,
              size: 'full',
              aspectRatio: '1:1',
              aspectMode: 'cover',
              action,
            },
          }),
          body: {
            type: 'box',
            layout: 'vertical',
            paddingAll: 'md',
            spacing: 'xs',
            action,
            contents: [
              {
                type: 'text',
                text: s.name,
                weight: 'bold',
                size: 'sm',
                align: 'center',
              },
              {
                type: 'text',
                text: combineShiftLabel(s.blocks),
                size: 'xxs',
                color: '#888888',
                align: 'center',
                wrap: true,
              },
            ],
          },
        };
      }),
    },
  };
}

/**
 * 空き時間のリストからユーザー向けの返信メッセージ(Flex Message)を組み立てる。
 */
function buildAvailabilityMessage(staffName, dateStr, shiftLabel, freeSlots) {
  const dateLabel = dayjs(dateStr).format('YYYY年M月D日(ddd)');

  if (freeSlots.length === 0) {
    return {
      type: 'text',
      text: `${staffName}さん / ${dateLabel}(勤務時間: ${shiftLabel})\nこの時間帯に空きはありません。`,
    };
  }

  const slotLines = freeSlots
    .map((s) => `・${s.start.format('HH:mm')} 〜 ${s.end.format('HH:mm')}`)
    .join('\n');

  return {
    type: 'flex',
    altText: `${staffName}さんの${dateLabel}の空き状況`,
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'text',
            text: staffName,
            weight: 'bold',
            size: 'md',
            color: '#06C755',
          },
          {
            type: 'text',
            text: dateLabel,
            weight: 'bold',
            size: 'lg',
            margin: 'sm',
          },
          {
            type: 'text',
            text: `勤務時間: ${shiftLabel}`,
            size: 'xs',
            color: '#888888',
          },
          {
            type: 'text',
            text: '空き時間',
            size: 'sm',
            color: '#888888',
            margin: 'md',
          },
          {
            type: 'text',
            text: slotLines,
            wrap: true,
            margin: 'sm',
          },
        ],
      },
    },
  };
}

/**
 * 空き時間の中から、予約可能な開始時刻をボタンで選ばせるメッセージ。
 * bookableSlots: [{ start: dayjs, end: dayjs }, ...] (calendarService.getBookableStartTimesの戻り値)
 */
function buildSlotSelectionMessage(storeId, staffId, dateStr, staffName, shiftLabel, bookableSlots, extraParams = '') {
  const dateLabel = dayjs(dateStr).format('M月D日(ddd)');

  if (bookableSlots.length === 0) {
    return {
      type: 'text',
      text: `${staffName}さん / ${dateLabel}(勤務時間: ${shiftLabel})\nご予約いただける時間帯がありません。`,
    };
  }

  return {
    type: 'text',
    text: `${staffName}さん / ${dateLabel}\nご希望の開始時刻を選んでください`,
    quickReply: {
      // Quick Replyは最大13個までのため、それ以上ある場合は先頭13件のみ表示する
      items: bookableSlots.slice(0, 13).map((slot) => ({
        type: 'action',
        action: {
          type: 'postback',
          label: slot.start.format('HH:mm'),
          data: `action=select_slot&storeId=${storeId}&staffId=${staffId}&date=${dateStr}&start=${slot.start.format('HH:mm')}&end=${slot.end.format('HH:mm')}${extraParams}`,
          displayText: `${slot.start.format('HH:mm')}を選択`,
        },
      })),
    },
  };
}

/**
 * 時間枠選択後、お客様のお名前を尋ねるメッセージ。
 */
function buildNamePromptMessage(storeName, staffName, dateStr, startTime, endTime) {
  const dateLabel = dayjs(dateStr).format('M月D日(ddd)');
  return {
    type: 'text',
    text: `${storeName} / ${staffName}さん\n${dateLabel} ${startTime}〜${endTime}\n\nご予約にあたり、お名前をフルネームで教えてください。(例: 山田 太郎)`,
  };
}

/**
 * 予約確定後、お客様に返す確認メッセージ。
 */
function buildBookingConfirmedMessage(storeName, staffName, dateStr, startTime, endTime, customerName) {
  const dateLabel = dayjs(dateStr).format('YYYY年M月D日(ddd)');
  const calendarUrl = buildGoogleCalendarUrl({ storeName, staffName, dateStr, startTime, endTime, customerName });
  return {
    type: 'flex',
    altText: 'ご予約が確定しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'ご予約が確定しました', weight: 'bold', size: 'md', color: '#06C755' },
          { type: 'text', text: storeName, weight: 'bold', size: 'lg', margin: 'sm' },
          { type: 'text', text: `担当: ${staffName}`, size: 'sm', margin: 'md' },
          { type: 'text', text: `${dateLabel}`, size: 'sm' },
          { type: 'text', text: `${startTime} 〜 ${endTime}`, size: 'sm' },
          { type: 'text', text: `お名前: ${customerName}様`, size: 'sm', margin: 'md' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'button',
          style: 'primary',
          color: '#4285F4',
          action: { type: 'uri', label: 'Googleカレンダーに追加', uri: calendarUrl },
        }],
      },
    },
  };
}

/**
 * お客様自身の予約一覧を表示するFlex Message。
 * bookings: [{ bookingId, storeName, staffName, dateStr, startTime, endTime }, ...]
 * todayStr: "YYYY-MM-DD" (当日の予約は変更・キャンセル不可のため、ボタンを出さない)
 */
function buildBookingListMessage(bookings, todayStr, webChangeBaseUrl = null) {
  if (bookings.length === 0) {
    return {
      type: 'text',
      text: '現在表示できるご予約はありません。',
    };
  }

  const sorted = [...bookings].sort((a, b) => {
    const aKey = `${a.dateStr} ${a.startTime}`;
    const bKey = `${b.dateStr} ${b.startTime}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  return {
    type: 'flex',
    altText: 'ご予約一覧',
    contents: {
      type: 'carousel',
      contents: sorted.slice(0, 10).map((b) => {
        const dateLabel = dayjs(b.dateStr).format('YYYY年M月D日(ddd)');
        const isPast = b.dateStr < todayStr;
        const isToday = b.dateStr === todayStr;
        const isLocked = isPast || isToday;

        return {
          type: 'bubble',
          size: 'kilo',
          body: {
            type: 'box',
            layout: 'vertical',
            contents: [
              { type: 'text', text: b.storeName, weight: 'bold', size: 'md', color: '#06C755' },
              { type: 'text', text: `担当: ${b.staffName}`, size: 'sm', margin: 'sm' },
              { type: 'text', text: dateLabel, size: 'sm' },
              { type: 'text', text: `${b.startTime} 〜 ${b.endTime}`, size: 'sm' },
              ...(b.source === 'calendar'
                ? [
                    {
                      type: 'text',
                      text: '(お電話・店頭等でのご予約)',
                      size: 'xs',
                      color: '#888888',
                    },
                  ]
                : []),
              ...(isLocked
                ? [
                    {
                      type: 'text',
                      text: isPast
                        ? '過去のご予約です。変更・キャンセルはできません。'
                        : '本日のご予約は変更・キャンセルを承っておりません。お電話にてご連絡ください。',
                      size: 'xs',
                      color: '#888888',
                      wrap: true,
                      margin: 'md',
                    },
                  ]
                : []),
            ],
          },
          footer: isLocked
            ? undefined
            : {
                type: 'box',
                layout: 'horizontal',
                spacing: 'sm',
                contents: [
                  {
                    type: 'button',
                    style: 'secondary',
                    action: webChangeBaseUrl
                      ? { type: 'uri', label: '変更する', uri: `${webChangeBaseUrl}${encodeURIComponent(b.bookingId)}` }
                      : {
                          type: 'postback',
                          label: '変更する',
                          data: `action=start_change&bookingId=${b.bookingId}`,
                          displayText: 'この予約を変更する',
                        },
                  },
                  {
                    type: 'button',
                    style: 'primary',
                    color: '#FF4B4B',
                    action: {
                      type: 'postback',
                      label: 'キャンセルする',
                      data: `action=start_cancel&bookingId=${b.bookingId}`,
                      displayText: 'この予約をキャンセルする',
                    },
                  },
                ],
              },
        };
      }),
    },
  };
}

/**
 * キャンセル前の最終確認メッセージ(はい/いいえ)。
 */
function buildCancelConfirmMessage(booking) {
  const dateLabel = dayjs(booking.dateStr).format('M月D日(ddd)');
  return {
    type: 'text',
    text: `以下のご予約をキャンセルします。よろしいですか?\n\n${booking.storeName} / ${booking.staffName}さん\n${dateLabel} ${booking.startTime}〜${booking.endTime}`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'はい、キャンセルする',
            data: `action=confirm_cancel&bookingId=${booking.bookingId}`,
            displayText: 'はい、キャンセルします',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'いいえ',
            data: `action=abort_cancel&bookingId=${booking.bookingId}`,
            displayText: 'キャンセルをやめる',
          },
        },
      ],
    },
  };
}

/**
 * キャンセル完了後、お客様に返すメッセージ。
 */
function buildCancelledMessage(booking) {
  const dateLabel = dayjs(booking.dateStr).format('YYYY年M月D日(ddd)');
  return {
    type: 'text',
    text: `ご予約をキャンセルしました。\n\n${booking.storeName} / ${booking.staffName}さん\n${dateLabel} ${booking.startTime}〜${booking.endTime}`,
  };
}

/**
 * 変更完了後、お客様に返すメッセージ。
 */
function buildChangeConfirmedMessage(oldBooking, newBooking) {
  const oldDateLabel = dayjs(oldBooking.dateStr).format('M月D日(ddd)');
  const newDateLabel = dayjs(newBooking.dateStr).format('YYYY年M月D日(ddd)');
  const calendarUrl = buildGoogleCalendarUrl({
    storeName: newBooking.storeName,
    staffName: newBooking.staffName,
    dateStr: newBooking.dateStr,
    startTime: newBooking.startTime,
    endTime: newBooking.endTime,
    customerName: newBooking.customerName,
  });
  return {
    type: 'flex',
    altText: 'ご予約を変更しました',
    contents: {
      type: 'bubble',
      body: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: 'ご予約を変更しました', weight: 'bold', size: 'md', color: '#06C755' },
          {
            type: 'text',
            text: `変更前: ${oldDateLabel} ${oldBooking.startTime}〜${oldBooking.endTime}`,
            size: 'xs',
            color: '#888888',
            margin: 'md',
          },
          { type: 'text', text: newBooking.storeName, weight: 'bold', size: 'lg', margin: 'sm' },
          { type: 'text', text: `担当: ${newBooking.staffName}`, size: 'sm', margin: 'md' },
          { type: 'text', text: newDateLabel, size: 'sm' },
          { type: 'text', text: `${newBooking.startTime} 〜 ${newBooking.endTime}`, size: 'sm' },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{
          type: 'button',
          style: 'primary',
          color: '#4285F4',
          action: { type: 'uri', label: '変更後の予定をカレンダーに追加', uri: calendarUrl },
        }],
      },
    },
  };
}

/**
 * 予約が入ったことをスタッフに知らせる通知メッセージ(push message用)。
 * bookingIdとisTicketCustomerを渡すと、チケット会員向けに「来店確認」ボタンを追加する
 * (来店確認をタップすると、そのお客様のチケットが1枚消費される)。
 */
function buildStaffNotificationMessage(storeName, dateStr, startTime, endTime, customerName, bookingId = null, isTicketCustomer = false) {
  const dateLabel = dayjs(dateStr).format('YYYY年M月D日(ddd)');
  const text = `【新規予約】\n${storeName}\n${dateLabel} ${startTime}〜${endTime}\nお名前: ${customerName}様`;

  if (!isTicketCustomer || !bookingId) {
    return { type: 'text', text };
  }

  return {
    type: 'template',
    altText: text,
    template: {
      type: 'buttons',
      text: text.slice(0, 160), // buttons templateのtextは160文字までのため念のため切る
      actions: [
        {
          type: 'postback',
          label: '来店確認(チケット消費)',
          data: `action=confirm_attendance&bookingId=${bookingId}`,
          displayText: '来店確認しました',
        },
      ],
    },
  };
}

/**
 * 予約がキャンセルされたことをスタッフに知らせる通知メッセージ。
 */
function buildStaffCancelNotificationMessage(booking) {
  const dateLabel = dayjs(booking.dateStr).format('YYYY年M月D日(ddd)');
  return {
    type: 'text',
    text: `【予約キャンセル】\n${booking.storeName}\n${dateLabel} ${booking.startTime}〜${booking.endTime}\nお名前: ${booking.customerName}様`,
  };
}

/**
 * 予約が変更されたことをスタッフに知らせる通知メッセージ。
 * (担当スタッフが変わった場合は、旧担当への「キャンセル通知」と新担当への「新規予約通知」を
 *  それぞれ別に送る形にするため、この関数は「同じスタッフ内での日時変更」の通知に使う)
 */
function buildStaffChangeNotificationMessage(oldBooking, newBooking) {
  const oldDateLabel = dayjs(oldBooking.dateStr).format('M月D日(ddd)');
  const newDateLabel = dayjs(newBooking.dateStr).format('YYYY年M月D日(ddd)');
  return {
    type: 'text',
    text: `【予約変更】\n${newBooking.storeName}\nお名前: ${newBooking.customerName}様\n変更前: ${oldDateLabel} ${oldBooking.startTime}〜${oldBooking.endTime}\n変更後: ${newDateLabel} ${newBooking.startTime}〜${newBooking.endTime}`,
  };
}

/**
 * 「予約」を始める前に、現在の自分の予約件数・内容を知らせるサマリーメッセージ。
 * (ボタンなしのシンプルな案内。詳しい変更・キャンセルは「予約確認」で行う)
 */
function buildCurrentBookingsSummaryMessage(bookings) {
  if (bookings.length === 0) {
    return null; // 予約が1件もない場合は表示しない
  }

  const sorted = [...bookings].sort((a, b) => {
    const aKey = `${a.dateStr} ${a.startTime}`;
    const bKey = `${b.dateStr} ${b.startTime}`;
    return aKey < bKey ? -1 : aKey > bKey ? 1 : 0;
  });

  const lines = sorted
    .map((b) => {
      const dateLabel = dayjs(b.dateStr).format('M月D日(ddd)');
      return `・${dateLabel} ${b.startTime}〜${b.endTime} ${b.storeName}(${b.staffName})`;
    })
    .join('\n');

  return {
    type: 'text',
    text: `現在、${sorted.length}件のご予約があります。\n${lines}`,
  };
}

/**
 * 管理者(成田さん等)が「チケット追加」と送った直後、
 * どのパッケージ(45分/60分 × 1・5・10回)を追加するか選ばせるメッセージ。
 */
function buildTicketPackageSelectionMessage() {
  const durations = [45, 60];
  const counts = [1, 5, 10];
  const items = [];
  for (const duration of durations) {
    for (const count of counts) {
      items.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${duration}分×${count}回`,
          data: `action=select_ticket_package&duration=${duration}&count=${count}`,
          displayText: `${duration}分×${count}回を選択`,
        },
      });
    }
  }
  return {
    type: 'text',
    text: '追加するチケットの種類を選んでください。',
    quickReply: { items },
  };
}

function buildAdminMemberManagementMessage() {
  return {
    type: 'text',
    text: '変更する内容を選んでください。',
    quickReply: {
      items: [
        { type: 'action', action: { type: 'postback', label: 'チケット付与', data: 'action=admin_ticket_add' } },
        { type: 'action', action: { type: 'postback', label: '月会費コース変更', data: 'action=admin_monthly_change' } },
        { type: 'action', action: { type: 'postback', label: 'プラチナ昇格', data: 'action=admin_platinum&mode=register' } },
        { type: 'action', action: { type: 'postback', label: 'プラチナ解除', data: 'action=admin_platinum&mode=unregister' } },
      ],
    },
  };
}

function buildAdminMonthlyPackageSelectionMessage() {
  const items = [];
  for (const duration of [45, 60]) {
    for (const quota of [4, 6]) {
      items.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${duration}分×月${quota}回`,
          data: `action=admin_monthly_package&duration=${duration}&quota=${quota}`,
        },
      });
    }
  }
  return { type: 'text', text: '変更後の月会費コースを選んでください。', quickReply: { items } };
}

/**
 * お客様自身がチケットを購入(自己申告で追加)するための選択メッセージ。
 * 管理者向けのbuildTicketPackageSelectionMessageとは別のpostbackアクションを使う
 * (お客様自身のLINEユーザーIDにそのまま追加されるため、ID入力は不要)。
 */
function buildTicketSelfPurchaseSelectionMessage() {
  const durations = [45, 60];
  const counts = [1, 5, 10];
  const items = [];
  for (const duration of durations) {
    for (const count of counts) {
      items.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${duration}分×${count}回`,
          data: `action=self_buy_ticket&duration=${duration}&count=${count}`,
          displayText: `${duration}分×${count}回を購入`,
        },
      });
    }
  }
  return {
    type: 'text',
    text: '購入するチケットの種類を選んでください。',
    quickReply: { items },
  };
}

/**
 * お客様自身のチケット購入が完了したことを知らせるメッセージ。
 */
function buildTicketSelfPurchasedMessage(duration, count, newBalance) {
  return {
    type: 'text',
    text: `${duration}分チケットを${count}枚購入しました。\n現在の${duration}分チケット残数: ${newBalance}枚\n\n※お支払いは店頭にてお願いいたします。`,
  };
}

/**
 * お客様がチケットを自己申告で購入した際、管理者(スタッフ)に送る請求依頼の通知。
 */
function buildAdminBillingRequestMessage(customerName, duration, count) {
  return {
    type: 'text',
    text: `【チケット購入・要会計】\nお名前: ${customerName}様\n内容: ${duration}分チケット×${count}枚\n\n店頭にてお支払いのご案内をお願いします。`,
  };
}

/**
 * パッケージ選択後、どのお客様に追加するか(LINEユーザーID)を尋ねるメッセージ。
 */
function buildAdminAskCustomerIdMessage(duration, count) {
  return {
    type: 'text',
    text: `${duration}分×${count}回のチケットを追加します。\n対象のお客様のLINEユーザーIDを送ってください。\n(お客様に「ID確認」と送ってもらうと確認できます)`,
  };
}

/**
 * チケット追加が完了したことを、管理者に知らせる確認メッセージ。
 */
function buildAdminTicketAddedMessage(customerId, duration, count, newBalance) {
  return {
    type: 'text',
    text: `${duration}分チケットを${count}枚追加しました。\n対象ID: ${customerId}\n現在の${duration}分チケット残数: ${newBalance}枚`,
  };
}

/**
 * お客様自身が「チケット残数確認」と送った時に返す、残数のお知らせ。
 * balances: { "45": n, "60": m }
 */
function buildTicketBalanceMessage(balances) {
  return {
    type: 'text',
    text: `現在のチケット残数です。\n45分チケット: ${balances[45]}枚\n60分チケット: ${balances[60]}枚`,
  };
}

/**
 * チケット会員が、残数を超える新規予約をしようとした時に返す案内メッセージ。
 */
function buildTicketLimitReachedMessage(duration, balance) {
  return {
    type: 'text',
    text: `大変申し訳ございませんが、${duration}分チケットの残数(${balance}枚)を超えるご予約はできません。\nご来店・チケットのご購入後に、あらためてご予約ください。`,
  };
}

/**
 * 管理者(成田さん等)が「月会費回数設定」と送った直後、
 * 1ヶ月あたりの回数を尋ねるメッセージ。
 */
function buildAdminAskQuotaMessage() {
  return {
    type: 'text',
    text: '1ヶ月あたりの予約回数を、数字だけで送ってください。(例: 8)',
  };
}

/**
 * 回数を受け取った後、対象のお客様のLINEユーザーIDを尋ねるメッセージ。
 */
function buildAdminAskCustomerIdForQuotaMessage(quota) {
  return {
    type: 'text',
    text: `月${quota}回の月会費メンバーとして登録します。\n対象のお客様のLINEユーザーIDを送ってください。\n(お客様に「ID確認」と送ってもらうと確認できます)`,
  };
}

/**
 * 月会費回数の設定が完了したことを、管理者に知らせる確認メッセージ。
 */
function buildAdminQuotaSetMessage(customerId, quota, duration = null) {
  return {
    type: 'text',
    text: `月会費メンバーとして登録しました。\n対象ID: ${customerId}${duration ? `\nコース: ${duration}分×月${quota}回` : `\n月あたりの予約回数: ${quota}回`}`,
  };
}

/**
 * 月会費メンバーが、その月の回数上限を超える新規予約をしようとした時に返す案内メッセージ。
 */
function buildMonthlyQuotaReachedMessage(quota) {
  return {
    type: 'text',
    text: `大変申し訳ございませんが、今月分のご予約回数(月${quota}回)の上限に達しているため、これ以上のご予約はできません。\n(回数は毎月リセットされますが、繰り越しはございません)`,
  };
}

/**
 * 来店確認(チケット消費)完了後、スタッフに返す確認メッセージ。
 */
function buildAttendanceConfirmedMessage(customerName, duration, remainingBalance) {
  return {
    type: 'text',
    text: `来店確認しました。\nお名前: ${customerName}様\n${duration}分チケット残数: ${remainingBalance}枚`,
  };
}

/**
 * 「会員種別」メニュー。現在の種別・チケット残数を表示し、
 * 顧客紐付け・会員種別の変更をボタンで選べるようにする。
 * currentTypeLabel: "月会費メンバー" / "チケット会員" / "ビジター" のいずれか
 * ticketBalances: チケット会員の場合の残数 { "45": n, "60": m }。それ以外はnull。
 */
function buildMemberMenuMessage(currentTypeLabel, ticketBalances) {
  const balanceLines = ticketBalances
    ? `\n45分チケット: ${ticketBalances[45]}枚\n60分チケット: ${ticketBalances[60]}枚`
    : '';

  return {
    type: 'text',
    text: `現在のご利用種別: ${currentTypeLabel}${balanceLines}`,
    quickReply: {
      items: [
        {
          type: 'action',
          action: {
            type: 'postback',
            label: 'チケット購入及び残数確認',
            data: 'action=ticket_menu',
            displayText: 'チケットの購入・残数確認',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '月会費メンバー確認',
            data: 'action=select_monthly_package',
            displayText: '月会費メンバーに登録',
          },
        },
        {
          type: 'action',
          action: {
            type: 'postback',
            label: '顧客紐付け',
            data: 'action=link_customer_self',
            displayText: '顧客紐付け',
          },
        },
      ],
    },
  };
}

/**
 * 会員種別の変更が完了したことを知らせるメッセージ。
 */
function buildMemberTypeChangedMessage(newTypeLabel) {
  return {
    type: 'text',
    text: `「${newTypeLabel}」に登録しました。\n(チケット会員の方は、ご来店時にチケットのご購入をお願いします)`,
  };
}

/**
 * 「月会費メンバーになる」を選んだ後、コース(45分/60分 × 月4回/6回)を選ばせるメッセージ。
 */
function buildMonthlyPackageSelectionMessage() {
  const durations = [45, 60];
  const quotas = [4, 6];
  const items = [];
  for (const duration of durations) {
    for (const quota of quotas) {
      items.push({
        type: 'action',
        action: {
          type: 'postback',
          label: `${duration}分×月${quota}回`,
          data: `action=become_member_type&type=monthly&duration=${duration}&quota=${quota}`,
          displayText: `${duration}分×月${quota}回コースに登録`,
        },
      });
    }
  }
  return {
    type: 'text',
    text: 'ご希望のコースを選んでください。',
    quickReply: { items },
  };
}

/**
 * 会員種別の登録が完了したことを知らせるメッセージ(コース内容付き)。
 */
function buildMemberTypeChangedWithPlanMessage(duration, quota) {
  return {
    type: 'text',
    text: `月会費メンバー(${duration}分×月${quota}回コース)に登録しました。`,
  };
}

/**
 * 既に月会費メンバーとして登録済みのお客様が「月会費メンバー確認」を押した時に表示する、
 * 現在のコース内容。お客様自身はここから変更できない(変更は店舗側で行う)。
 */
function buildMonthlyMemberStatusMessage(duration, quota) {
  const durationLabel = duration ? `${duration}分` : '(未設定)';
  return {
    type: 'text',
    text: `現在の月会費コース\n時間: ${durationLabel}\n月あたりの回数: ${quota}回\n\nコースの変更をご希望の場合は、店舗までお問い合わせください。`,
  };
}

/**
 * リッチメニューの「メニュー」ボタンから出す3択メッセージ。
 * postbackアクションにdisplayTextを付けていないため、
 * タップしてもトーク画面にお客様側の発言として文字が表示されない。
 */
function buildMainMenuMessage(bookingUrl = null) {
  const reservationAction = bookingUrl
    ? { type: 'uri', label: '予約する', uri: bookingUrl }
    : { type: 'postback', label: '予約する', data: 'action=menu_reservation' };
  return {
    type: 'text',
    text: 'ご希望のメニューを選んでください。',
    quickReply: {
      items: [
        { type: 'action', action: reservationAction },
        { type: 'action', action: { type: 'postback', label: '予約確認・変更', data: 'action=menu_check_bookings' } },
        { type: 'action', action: { type: 'postback', label: '会員種別', data: 'action=menu_member_menu' } },
      ],
    },
  };
}

module.exports = {
  buildStoreSelectionMessage,
  buildDatePickerMessage,
  buildClosedMessage,
  buildStaffSelectionMessage,
  buildAvailabilityMessage,
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
  buildCurrentBookingsSummaryMessage,
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
};

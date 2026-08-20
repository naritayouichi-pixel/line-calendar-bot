require('dotenv').config();

/**
 * すべての設定値をここに集約する。
 * 環境変数が未設定の場合は分かりやすいエラーで落とす。
 */
function required(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`環境変数 ${name} が設定されていません。.env を確認してください。`);
  }
  return value;
}

/**
 * STAFF_LIST の形式:
 * "id1:表示名1:calendarId1:lineUserId1,id2:表示名2:calendarId2:lineUserId2"
 * 例: "narita:成田:narita.youichi@gmail.com:U1234...,tanaka:田中:tanaka@example.com:"
 *
 * idには英数字のみ使うこと(LINEのpostback dataに使うため、日本語や記号は避ける)。
 * lineUserIdは省略可(空にしておくと、そのスタッフへのLINE通知は行われない)。
 * lineUserIdの取得方法はREADMEを参照。
 */
function parseStaffList(raw) {
  return raw.split(',').map((entry) => {
    const [id, name, calendarId, lineUserId] = entry.split(':').map((s) => (s || '').trim());
    if (!id || !name || !calendarId) {
      throw new Error(
        `STAFF_LIST の形式が不正です: "${entry}" (id:表示名:calendarId:lineUserId(任意) の形式で指定してください)`
      );
    }
    return { id, name, calendarId, lineUserId: lineUserId || null };
  });
}

/**
 * MEMBER_LIST の形式:
 * "表示名1:lineUserId1,表示名2:lineUserId2"
 * 例: "山田太郎:U1234...,鈴木花子:U5678..."
 *
 * 月会費メンバーの一覧。「ID確認」でお客様自身に確認してもらったLINEユーザーIDを、
 * ここに追加することでメンバー登録する(お客様のLINE友だち追加自体は自動では検知できないため)。
 * 設定しない場合(MEMBER_LISTが空)は、誰も月会費メンバー扱いにならない
 * (=誰でも今まで通りの予約可能期間になる)。
 */
function parseMemberList(raw) {
  if (!raw) return [];
  return raw
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const [name, lineUserId] = entry.split(':').map((s) => (s || '').trim());
      return { name, lineUserId };
    });
}

module.exports = {
  line: {
    channelAccessToken: required('LINE_CHANNEL_ACCESS_TOKEN'),
    channelSecret: required('LINE_CHANNEL_SECRET'),
  },
  google: {
    // サービスアカウントの鍵JSONを1行のBase64文字列にして環境変数に入れる想定
    serviceAccountKeyBase64: required('GOOGLE_SERVICE_ACCOUNT_KEY_BASE64'),
  },
  staff: parseStaffList(required('STAFF_LIST')),
  members: parseMemberList(process.env.MEMBER_LIST || ''),
  // チケットの付与(「チケット追加」コマンド)を実行できる管理者のLINEユーザーID一覧
  // 例: ADMIN_USER_IDS=U1234...,U5678...
  adminUserIds: (process.env.ADMIN_USER_IDS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  // チケット購入時の会計通知先LINEグループID。未設定時は管理者へ個別通知する。
  adminNotificationGroupId: process.env.ADMIN_NOTIFICATION_GROUP_ID || null,
  // Cloud Schedulerからチケット自動消費処理を呼び出すための共有シークレット
  automationTaskSecret: process.env.AUTOMATION_TASK_SECRET || null,
  publicBaseUrl: process.env.PUBLIC_BASE_URL || 'https://line-calendar-bot-752329396862.asia-northeast1.run.app',
  square: {
    accessToken: process.env.SQUARE_ACCESS_TOKEN || null,
    locationId: process.env.SQUARE_LOCATION_ID || null,
    webhookSignatureKey: process.env.SQUARE_WEBHOOK_SIGNATURE_KEY || null,
    webhookUrl: process.env.SQUARE_WEBHOOK_URL || 'https://line-calendar-bot-752329396862.asia-northeast1.run.app/webhooks/square',
    trialAmountYen: Number(process.env.TRIAL_AMOUNT_YEN || 6000),
  },
  business: {
    // 営業時間(24時間表記)。空き状況判定の対象となる時間帯
    startHour: Number(process.env.BUSINESS_HOUR_START || 9),
    endHour: Number(process.env.BUSINESS_HOUR_END || 18),
    // 予定を確認する対象日数(今日から何日先まで選択できるようにするか)
    maxDaysAhead: Number(process.env.MAX_DAYS_AHEAD || 30),
    // チケット会員は日付の制限を実質なくすため、代わりにこの日数(長め)を使う
    // ※ 日付選択は「選べる日をボタンで全部並べる」形式のため、あまり大きくしすぎると
    //    1つのメッセージにボタンが並びすぎて表示が崩れる可能性があります
    ticketMaxDaysAhead: Number(process.env.TICKET_MAX_DAYS_AHEAD || 90),
    timezone: process.env.TIMEZONE || 'Asia/Tokyo',
  },
  booking: {
    // 1回の予約の長さ(分)
    durationMinutes: Number(process.env.BOOKING_DURATION_MINUTES || 60),
    // 予約開始時刻の間隔(分)。省略時はdurationMinutesと同じ(枠が重ならない)
    intervalMinutes: process.env.BOOKING_INTERVAL_MINUTES
      ? Number(process.env.BOOKING_INTERVAL_MINUTES)
      : null,
    // この文字列を含む終日予定がカレンダーにある日は、そのスタッフの予約を丸ごと受け付けない
    // (イレギュラーな休みのため。例: "NG"という終日予定を1つ入れるだけで、その日は予約不可になる)
    fullDayBlockKeyword: process.env.FULL_DAY_BLOCK_KEYWORD || 'NG',
    // 月会費メンバーが「来月分」を予約できるようになる、今月の日(デフォルト25日)
    memberNextMonthOpenDay: Number(process.env.MEMBER_NEXT_MONTH_OPEN_DAY || 25),
    // プラチナ会員は通常会員より1週間早く、毎月18日から翌月分を予約できる
    platinumNextMonthOpenDay: Number(process.env.PLATINUM_NEXT_MONTH_OPEN_DAY || 18),
    // 18日・25日とも、翌月分の予約受付を開始する時刻
    memberNextMonthOpenHour: Number(process.env.MEMBER_NEXT_MONTH_OPEN_HOUR || 10),
  },
  port: Number(process.env.PORT || 8080),
};

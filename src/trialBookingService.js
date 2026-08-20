const dayjs = require('dayjs');
const line = require('@line/bot-sdk');
const config = require('./config');
const { STORES, STAFF_PHOTOS, getStore, getShiftsForDate, groupShiftsByStaff } = require('./shiftSchedule');
const { getAvailableSlots, getBookableStartTimes, createBooking, deleteBooking, updateCalendarBooking, hasFullDayBlock } = require('./calendarService');
const bookingStore = require('./bookingStore');
const trialStore = require('./trialBookingStore');
const square = require('./squareService');

const lineClient = new line.messagingApi.MessagingApiClient({
  channelAccessToken: config.line.channelAccessToken,
});

async function notifyCompanyGroup(trial) {
  if (!config.adminNotificationGroupId) {
    console.log('(通知スキップ) 体験予約の会社LINEグループIDが未設定です。');
    return;
  }
  const text = [
    '【体験予約・決済完了】',
    `お名前：${trial.name}様`,
    `店舗：${trial.storeName}`,
    `日時：${trial.dateStr} ${trial.startTime}〜${trial.endTime}`,
    `担当：${trial.staffName}トレーナー`,
    `電話：${trial.phone}`,
    `メール：${trial.email || '未入力'}`,
    `料金：${config.square.trialAmountYen.toLocaleString('ja-JP')}円（税込・Square決済済み）`,
  ].join('\n');
  try {
    await lineClient.pushMessage({
      to: config.adminNotificationGroupId,
      messages: [{ type:'text', text }],
    });
  } catch (error) {
    // 予約確定を優先し、LINE通知の失敗でSquare Webhookを再試行させない。
    console.error('体験予約の会社LINE通知でエラー:', error);
  }
}

function staff(id) { return config.staff.find((s) => s.id === id); }
function calendarIds(storeId, dateStr) { return [...new Set(getShiftsForDate(storeId, dateStr).shifts.map((s) => staff(s.staffId)?.calendarId).filter(Boolean))]; }
function bootstrap() {
  return { stores:STORES, minDate:dayjs().tz(config.business.timezone).add(1,'day').format('YYYY-MM-DD'), maxDate:dayjs().tz(config.business.timezone).add(config.business.maxDaysAhead,'day').format('YYYY-MM-DD'), durationMinutes:60, amountYen:config.square.trialAmountYen, businessHours:{ start:config.business.startHour, end:config.business.endHour } };
}
async function availability(storeId, dateStr) {
  const info = bootstrap();
  if (dateStr < info.minDate || dateStr > info.maxDate) throw new Error('この日付は予約できません。');
  const store = getStore(storeId); if (!store) throw new Error('店舗が見つかりません。');
  const { closed, shifts } = getShiftsForDate(storeId, dateStr); if (closed) return { closed:true, staff:[] };
  const ids = calendarIds(storeId, dateStr); const rows = [];
  for (const group of groupShiftsByStaff(shifts)) {
    const person = staff(group.staffId); if (!person || await hasFullDayBlock(person.calendarId,dateStr,config.booking.fullDayBlockKeyword)) continue;
    let slots=[];
    for (const block of group.blocks) {
      const free=await getAvailableSlots(dateStr,person.calendarId,block.start,block.end,{ allCalendarIds:[person.calendarId], pairCalendarIds:ids });
      slots.push(...getBookableStartTimes(free,60));
    }
    rows.push({ id:person.id,name:person.name,photoUrl:STAFF_PHOTOS[person.id]||null,slots:[...new Map(slots.map((s)=>[s.start.format('HH:mm'),{start:s.start.format('HH:mm'),end:s.end.format('HH:mm')}])).values()] });
  }
  return { closed:false,staff:rows };
}
async function week(storeId,start) {
  const dates=[...Array(7)].map((_,i)=>dayjs(start).add(i,'day').format('YYYY-MM-DD'));
  return { dates:await Promise.all(dates.map(async(dateStr)=>{ try{return{dateStr,...await availability(storeId,dateStr)}}catch(e){return{dateStr,closed:true,staff:[],error:e.message}} })) };
}
function validateContact(input) {
  const name=String(input.name||'').replace(/様$/,'').trim();
  const phone=String(input.phone||'').replace(/[\s-]/g,''); const email=String(input.email||'').trim();
  if (name.length<2 || name.length>40 || /[\r\n]/.test(name)) throw new Error('氏名を正しく入力してください。');
  if (!/^0\d{9,10}$/.test(phone)) throw new Error('電話番号を正しく入力してください。');
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error('メールアドレスを正しく入力してください。');
  return {name,phone,email};
}
async function checkout(input) {
  const contact=validateContact(input); const store=getStore(input.storeId); const person=staff(input.staffId);
  if(!store||!person) throw new Error('店舗またはトレーナーが見つかりません。');
  const current=await availability(input.storeId,input.dateStr); const row=current.staff.find((s)=>s.id===input.staffId);
  const slot=row?.slots.find((s)=>s.start===input.startTime&&s.end===input.endTime); if(!slot) throw new Error('選択中にこの時間が埋まりました。');
  const hold=await createBooking({ dateStr:input.dateStr,startTime:input.startTime,endTime:input.endTime,calendarId:person.calendarId,summary:`【決済待ち】体験 ${contact.name}様`,description:'体験予約のSquare決済待ち（10分間仮押さえ）' });
  let trial;
  try {
    trial=await trialStore.create({...contact,storeId:store.id,storeName:store.name,staffId:person.id,staffName:person.name,calendarId:person.calendarId,eventId:hold.id,dateStr:input.dateStr,startTime:input.startTime,endTime:input.endTime,expiresAt:dayjs().add(10,'minute').toISOString()});
    const payment=await square.createTrialPaymentLink(trial); await trialStore.patch(trial.trialId,{squareOrderId:payment.orderId,squarePaymentLinkId:payment.paymentLinkId});
    return {trialId:trial.trialId,paymentUrl:payment.url};
  } catch(e) { await deleteBooking(person.calendarId,hold.id).catch(()=>{}); if(trial) await trialStore.patch(trial.trialId,{status:'failed'}); throw e; }
}
async function finalize(orderId,paymentId) {
  const trial=await trialStore.findByOrderId(orderId); if(!trial||trial.status==='confirmed') return trial;
  if(trial.status!=='awaiting_payment') return trial;
  await updateCalendarBooking(trial.calendarId,trial.eventId,{summary:`${trial.name}様（体験）`,description:`HP体験予約・Square決済済み\n電話: ${trial.phone}\nメール: ${trial.email||'未入力'}\n\n【当日のご案内】\n持ち物はウェア（動きやすい格好）のみです。シューズは必要ありません。\n飲み物やタオルはこちらでご用意しています。\n予約時間の5分前までにご来店ください。\n睡眠を十分にとって、当日お越しください。\n\nPayment ID: ${paymentId}`});
  const bookingId=await bookingStore.addBooking({userId:`trial:${trial.trialId}`,storeId:trial.storeId,storeName:trial.storeName,staffId:trial.staffId,staffName:trial.staffName,calendarId:trial.calendarId,eventId:trial.eventId,dateStr:trial.dateStr,startTime:trial.startTime,endTime:trial.endTime,durationMinutes:60,customerName:`${trial.name}（体験）`,phone:trial.phone,email:trial.email||null,paymentId});
  const confirmed = await trialStore.patch(trial.trialId,{status:'confirmed',paymentId,bookingId,confirmedAt:new Date().toISOString()});
  await notifyCompanyGroup(confirmed);
  return confirmed;
}
async function status(id){const trial=await trialStore.get(id);if(!trial)return null;return{status:trial.status,name:trial.name,dateStr:trial.dateStr,startTime:trial.startTime,endTime:trial.endTime,storeName:trial.storeName,staffName:trial.staffName};}
async function cleanupExpired(){const rows=await trialStore.listExpired(new Date().toISOString());for(const row of rows){await deleteBooking(row.calendarId,row.eventId).catch(()=>{});await square.disablePaymentLink(row.squarePaymentLinkId).catch(()=>{});await trialStore.patch(row.trialId,{status:'expired',expiredAt:new Date().toISOString()});}return rows.length;}
module.exports={bootstrap,week,checkout,finalize,status,cleanupExpired};

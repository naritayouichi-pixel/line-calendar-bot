const crypto = require('crypto');
const config = require('./config');

function configured() { return Boolean(config.square.accessToken && config.square.locationId && config.square.webhookSignatureKey); }

function squarePhoneNumber(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return undefined;
  if (digits.startsWith('81')) return `+${digits}`;
  if (digits.startsWith('0')) return `+81${digits.slice(1)}`;
  return `+${digits}`;
}

async function createTrialPaymentLink(trial) {
  if (!config.square.accessToken || !config.square.locationId) throw new Error('Square本番設定がまだ完了していません。');
  const response = await fetch('https://connect.squareup.com/v2/online-checkout/payment-links', {
    method: 'POST',
    headers: { Authorization:`Bearer ${config.square.accessToken}`, 'Content-Type':'application/json', 'Square-Version':'2026-07-15' },
    body: JSON.stringify({
      idempotency_key: trial.trialId,
      description: `PLAYGRAND体験予約 ${trial.name}様 ${trial.dateStr} ${trial.startTime}`,
      quick_pay: { name:'体験トレーニング', price_money:{ amount:config.square.trialAmountYen, currency:'JPY' }, location_id:config.square.locationId },
      checkout_options: { redirect_url:`${config.publicBaseUrl}/trial/?complete=${encodeURIComponent(trial.trialId)}`, ask_for_shipping_address:false },
      pre_populated_data: {
        buyer_email: trial.email || undefined,
        buyer_phone_number: squarePhoneNumber(trial.phone),
      },
      payment_note: `trial:${trial.trialId}`,
    }),
  });
  const json = await response.json();
  if (!response.ok) throw new Error(json.errors?.[0]?.detail || 'Square決済画面を作成できませんでした。');
  return { url:json.payment_link.url, orderId:json.payment_link.order_id, paymentLinkId:json.payment_link.id };
}

function validWebhook(rawBody, signature) {
  if (!config.square.webhookSignatureKey || !signature) return false;
  const expected = crypto.createHmac('sha256', config.square.webhookSignatureKey).update(config.square.webhookUrl + rawBody).digest('base64');
  const a = Buffer.from(expected); const b = Buffer.from(signature);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
async function disablePaymentLink(id) {
  if (!id || !config.square.accessToken) return;
  await fetch(`https://connect.squareup.com/v2/online-checkout/payment-links/${encodeURIComponent(id)}`, { method:'DELETE', headers:{ Authorization:`Bearer ${config.square.accessToken}`, 'Square-Version':'2026-07-15' } });
}
module.exports = { configured, createTrialPaymentLink, validWebhook, disablePaymentLink };

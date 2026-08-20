const crypto = require('crypto');
const config = require('./config');

function signature(payload) {
  return crypto.createHmac('sha256', config.line.channelSecret).update(payload).digest('base64url');
}

function createWebBookingToken(userId, lifetimeSeconds = 60 * 60) {
  const payload = Buffer.from(JSON.stringify({ userId, exp: Math.floor(Date.now() / 1000) + lifetimeSeconds }))
    .toString('base64url');
  return `${payload}.${signature(payload)}`;
}

function verifyWebBookingToken(token) {
  if (!token || !token.includes('.')) return null;
  const [payload, supplied] = token.split('.');
  const expected = signature(payload);
  const a = Buffer.from(supplied || '');
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!data.userId || data.exp < Math.floor(Date.now() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}

module.exports = { createWebBookingToken, verifyWebBookingToken };

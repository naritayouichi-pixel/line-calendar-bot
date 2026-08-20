require('dotenv').config();
const dayjs = require('dayjs');
const utc = require('dayjs/plugin/utc');
const timezone = require('dayjs/plugin/timezone');
const config = require('../src/config');
const { getAvailableSlots } = require('../src/calendarService');

dayjs.extend(utc);
dayjs.extend(timezone);

async function main() {
  const response = await fetch('https://api.line.me/v2/bot/info', {
    headers: { Authorization: `Bearer ${config.line.channelAccessToken}` },
  });
  if (!response.ok) throw new Error(`LINE bot info failed: HTTP ${response.status}`);
  const bot = await response.json();
  console.log(`LINE API: OK (${bot.displayName || 'name unavailable'})`);

  const date = dayjs().tz(config.business.timezone).add(1, 'day').format('YYYY-MM-DD');
  let failed = false;
  for (const staff of config.staff) {
    try {
      const slots = await getAvailableSlots(date, staff.calendarId);
      console.log(`Google Calendar: OK (${staff.id}, ${date}, free ranges: ${slots.length})`);
    } catch (error) {
      failed = true;
      console.error(`Google Calendar: FAILED (${staff.id}): ${error.message}`);
    }
  }
  if (failed) process.exitCode = 1;
}

main().catch((error) => {
  console.error(`Connectivity check failed: ${error.message}`);
  process.exit(1);
});

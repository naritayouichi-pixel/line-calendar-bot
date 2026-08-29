function isMonthlyBookingReleased(now, openDay, openHour) {
  if (now.date() !== openDay) return now.date() > openDay;
  return now.hour() >= openHour;
}

function bookingCalendarMaxDate(now) {
  return now.add(1, 'month').endOf('month').format('YYYY-MM-DD');
}

function ticketBookingMaxDate(now, maxDaysAhead = 90) {
  return now.add(maxDaysAhead, 'day').format('YYYY-MM-DD');
}

function monthlyBookingMaxDate(now, openDay, openHour, normalMaxDate) {
  if (!isMonthlyBookingReleased(now, openDay, openHour)) {
    const currentMonthEnd = now.endOf('month').format('YYYY-MM-DD');
    return currentMonthEnd < normalMaxDate ? currentMonthEnd : normalMaxDate;
  }

  // 解禁後は「今日から30日先」ではなく、翌月末まで必ず予約できるようにする。
  const nextMonthEnd = now.add(1, 'month').endOf('month').format('YYYY-MM-DD');
  return nextMonthEnd > normalMaxDate ? nextMonthEnd : normalMaxDate;
}

module.exports = { isMonthlyBookingReleased, monthlyBookingMaxDate, bookingCalendarMaxDate, ticketBookingMaxDate };

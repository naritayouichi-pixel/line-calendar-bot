const config = require('./config');
const memberStore = require('./memberStore');
const ticketStore = require('./ticketStore');
const bookingStore = require('./bookingStore');

async function isMonthlyMember(userId) {
  return config.members.some((member) => member.lineUserId === userId) || memberStore.isMember(userId);
}

function selectUsage({ monthlyMember, monthlyQuota, monthlyUsed, ticketCustomer, ticketBalance, ticketOutstanding }) {
  if (!monthlyMember && !ticketCustomer) {
    return { available: true, usageType: null };
  }
  if (monthlyMember && monthlyUsed < monthlyQuota) {
    return { available: true, usageType: 'membership' };
  }
  if (ticketCustomer && ticketOutstanding < ticketBalance) {
    return { available: true, usageType: 'ticket' };
  }
  return { available: false, usageType: null };
}

async function resolveBookingUsage(userId, dateStr, duration, excludeBookingId = null) {
  const monthlyMember = await isMonthlyMember(userId);
  const ticketCustomer = await ticketStore.isTicketCustomer(userId);
  const month = dateStr.slice(0, 7);
  const monthlyQuota = monthlyMember ? await memberStore.getMonthlyQuota(userId) : 0;
  const monthlyUsed = monthlyMember
    ? await bookingStore.getMonthlyMembershipBookingCount(userId, month, excludeBookingId)
    : 0;
  const ticketBalance = ticketCustomer ? await ticketStore.getBalance(userId, duration) : 0;
  const ticketOutstanding = ticketCustomer
    ? await bookingStore.getOutstandingTicketBookingCount(userId, duration, excludeBookingId, !monthlyMember)
    : 0;
  return {
    ...selectUsage({ monthlyMember, monthlyQuota, monthlyUsed, ticketCustomer, ticketBalance, ticketOutstanding }),
    monthlyMember,
    monthlyQuota,
    monthlyUsed,
    ticketCustomer,
    ticketBalance,
    ticketOutstanding,
  };
}

async function prepareDueBookingUsage(booking) {
  const monthlyMember = await isMonthlyMember(booking.userId);
  if (booking.usageType === 'membership' || (!booking.usageType && monthlyMember)) {
    return { consumeTicket: false, usageType: 'membership' };
  }
  if (booking.usageType === 'ticket' && monthlyMember) {
    const month = booking.dateStr.slice(0, 7);
    const quota = await memberStore.getMonthlyQuota(booking.userId);
    const monthlyUsed = await bookingStore.getMonthlyMembershipBookingCount(booking.userId, month);
    if (monthlyUsed < quota) {
      await bookingStore.updateBooking(booking.bookingId, { usageType: 'membership' });
      return { consumeTicket: false, usageType: 'membership', promoted: true };
    }
  }
  return { consumeTicket: true, usageType: 'ticket' };
}

module.exports = { isMonthlyMember, selectUsage, resolveBookingUsage, prepareDueBookingUsage };

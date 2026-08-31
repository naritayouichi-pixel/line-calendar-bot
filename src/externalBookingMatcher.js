function normalizeMatchText(value) {
  return String(value || '')
    .replace(/様\s*$/, '')
    .replace(/[\s　]+/g, '')
    .toLowerCase();
}

function eventMatchesCustomerName(event, customerName) {
  if (!event?.start?.dateTime || !event?.end?.dateTime) return false;
  const normalizedName = normalizeMatchText(customerName);
  if (!normalizedName || normalizedName === '(名前未登録)') return false;
  const eventText = normalizeMatchText([
    event.summary,
    event.description,
    event.location,
  ].filter(Boolean).join('\n'));
  return eventText.includes(normalizedName);
}

module.exports = { normalizeMatchText, eventMatchesCustomerName };

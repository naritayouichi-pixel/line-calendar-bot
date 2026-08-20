const PLATINUM_MEMBER_NAMES = [
  '吉原教一郎',
  '増田麻梨子',
  '田胡三代子',
  '佐野伸子',
  '阿部成人',
  '田胡治之',
  '平松知江子',
  '渡辺怜',
  '西木俊一',
  '松元文佳',
  '伊藤佐知子',
  '野中絋誠',
  '青木明美',
  '本田泰教',
  '増田啓示',
  '水越崇博',
  '頼宏幸',
  '石井純子',
  '伊藤京子',
  '高橋宇多子',
  '宮上景子',
  '篠田ルーク',
  '長川佳代子',
  '土田美幸',
  '吉野礼子',
  '勝間幸子',
  '広瀬悠里歌',
  '中野志保',
  '福島昌恵',
  '鷹木ねね',
  '作野尚美',
  '吉井陽子',
];

function normalizeMemberName(name) {
  return String(name || '')
    .replace(/[\s　]+/g, '')
    .replace(/様$/, '')
    .replace(/ペア$/, '');
}

const normalizedPlatinumNames = new Set(PLATINUM_MEMBER_NAMES.map(normalizeMemberName));

function isPlatinumMemberName(name) {
  return normalizedPlatinumNames.has(normalizeMemberName(name));
}

module.exports = { PLATINUM_MEMBER_NAMES, normalizeMemberName, isPlatinumMemberName };

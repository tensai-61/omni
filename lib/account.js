function canonicalEmail(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC')
    .replace(/\p{Cc}|\p{Cf}|\p{Default_Ignorable_Code_Point}|[\u115F\u1160\u2800\u3164\uFFA0]/gu, '')
    .trim()
    .toLowerCase()
    .replace(/i\u0307/g, 'i');
}

function isAdminAccount(user, adminEmail) {
  const admin = canonicalEmail(adminEmail);
  if (!admin) return false;
  return canonicalEmail(user?.email || '') === admin;
}

module.exports = { canonicalEmail, isAdminAccount };

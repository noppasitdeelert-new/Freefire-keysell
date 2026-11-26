/**
 * VEXIS — Translation Dictionary กลาง (TH/EN)
 * - ห้ามแปลชื่อแบรนด์ VEXIS, Product Key และรหัสคูปอง
 * - เพิ่มภาษาใหม่ได้โดยเพิ่มคีย์ใน DICT + แถวใน translation_settings
 */

export const DICT = {
  th: {
    'nav.store': 'ร้านค้า',
    'nav.topup': 'เติมเงิน',
    'nav.account': 'บัญชีของฉัน',
    'nav.wallet': 'กระเป๋าเงิน',
    'nav.orders': 'คำสั่งซื้อ',
    'nav.wishlist': 'รายการที่สนใจ',
    'nav.referral': 'เชิญเพื่อน',
    'nav.reseller': 'ตัวแทน/API',
    'nav.support': 'ซัพพอร์ต',
    'nav.admin': 'หลังบ้าน',
    'nav.status': 'สถานะระบบ',
    'common.login': 'เข้าสู่ระบบ',
    'common.register': 'สมัครสมาชิก',
    'common.logout': 'ออก',
    'common.copy': 'คัดลอก',
    'common.copied': 'คัดลอกแล้ว',
    'common.loading': 'กำลังโหลด…',
    'common.save': 'บันทึก',
    'common.cancel': 'ยกเลิก',
    'common.close': 'ปิด',
    'common.search': 'ค้นหา',
    'common.buy': 'ซื้อเลย',
    'common.none': 'ยังไม่มีข้อมูล',
    'common.language': 'ภาษา',
    'referral.title': 'เชิญเพื่อนรับรางวัล',
    'referral.subtitle': 'แชร์ลิงก์ของคุณ เพื่อนสมัครและซื้อครั้งแรก คุณได้รางวัล',
    'referral.code': 'รหัสเชิญของคุณ',
    'referral.link': 'ลิงก์เชิญเพื่อน',
    'referral.signups': 'ผู้สมัครผ่านลิงก์',
    'referral.friends': 'เพื่อนที่ซื้อสำเร็จ',
    'referral.earned': 'ยอดรางวัลสะสม',
    'referral.history': 'ประวัติรางวัล',
    'referral.campaign': 'แคมเปญปัจจุบัน',
    'referral.closed': 'แคมเปญปิดอยู่',
    'referral.signupReward': 'รางวัลเมื่อเพื่อนสมัคร',
    'referral.purchaseReward': 'รางวัลเมื่อเพื่อนซื้อครั้งแรก',
    'referral.maxRewards': 'จำนวนครั้งสูงสุด',
    'referral.period': 'ช่วงแคมเปญ',
    'wishlist.title': 'รายการที่สนใจ',
    'wishlist.subtitle': 'ติดตามราคาและสต็อกของสินค้าที่คุณสนใจ',
    'wishlist.empty': 'ยังไม่มีสินค้าในรายการที่สนใจ',
    'wishlist.inStock': 'พร้อมขาย',
    'wishlist.outStock': 'สินค้าหมด',
    'wishlist.priceChanged': 'ราคาเปลี่ยน',
    'wishlist.remove': 'ลบ',
    'orders.title': 'คำสั่งซื้อของฉัน',
    'orders.subtitle': 'ติดตามสถานะคำสั่งซื้อแบบเรียลไทม์',
    'orders.timeline': 'ติดตามสถานะ',
    'orders.orderId': 'รหัสคำสั่งซื้อ',
    'orders.payment': 'สถานะการชำระเงิน',
    'orders.delivery': 'สถานะการส่งมอบ',
    'status.title': 'สถานะระบบ',
    'status.subtitle': 'สถานะนี้มาจากการตรวจสอบระบบจริง',
    'status.overall': 'สถานะรวม',
    'status.updated': 'ตรวจล่าสุด',
    'status.incidents': 'ประวัติเหตุการณ์',
    'status.noIncidents': 'ไม่มีเหตุการณ์ขัดข้อง',
    'status.maintenance': 'ปิดปรับปรุง',
    'status.unknown': 'ตรวจสอบไม่ได้',
    'status.latency': 'เวลาตอบสนอง',
  },
  en: {
    'nav.store': 'Store',
    'nav.topup': 'Top up',
    'nav.account': 'My account',
    'nav.wallet': 'Wallet',
    'nav.orders': 'Orders',
    'nav.wishlist': 'Wishlist',
    'nav.referral': 'Refer friends',
    'nav.reseller': 'Reseller/API',
    'nav.support': 'Support',
    'nav.admin': 'Admin',
    'nav.status': 'System status',
    'common.login': 'Sign in',
    'common.register': 'Sign up',
    'common.logout': 'Sign out',
    'common.copy': 'Copy',
    'common.copied': 'Copied',
    'common.loading': 'Loading…',
    'common.save': 'Save',
    'common.cancel': 'Cancel',
    'common.close': 'Close',
    'common.search': 'Search',
    'common.buy': 'Buy now',
    'common.none': 'No data yet',
    'common.language': 'Language',
    'referral.title': 'Refer friends, earn rewards',
    'referral.subtitle': 'Share your link — when a friend signs up and buys, you get rewarded.',
    'referral.code': 'Your referral code',
    'referral.link': 'Referral link',
    'referral.signups': 'Signups via link',
    'referral.friends': 'Friends who purchased',
    'referral.earned': 'Total rewards',
    'referral.history': 'Reward history',
    'referral.campaign': 'Current campaign',
    'referral.closed': 'Campaign is closed',
    'referral.signupReward': 'Reward per signup',
    'referral.purchaseReward': 'Reward on first purchase',
    'referral.maxRewards': 'Maximum rewards',
    'referral.period': 'Campaign period',
    'wishlist.title': 'Wishlist',
    'wishlist.subtitle': 'Track price and stock of products you like.',
    'wishlist.empty': 'Your wishlist is empty',
    'wishlist.inStock': 'In stock',
    'wishlist.outStock': 'Out of stock',
    'wishlist.priceChanged': 'Price changed',
    'wishlist.remove': 'Remove',
    'orders.title': 'My orders',
    'orders.subtitle': 'Track every order in real time.',
    'orders.timeline': 'Track order',
    'orders.orderId': 'Order ID',
    'orders.payment': 'Payment status',
    'orders.delivery': 'Delivery status',
    'status.title': 'System status',
    'status.subtitle': 'Every status comes from a real health check.',
    'status.overall': 'Overall status',
    'status.updated': 'Last checked',
    'status.incidents': 'Incident history',
    'status.noIncidents': 'No incidents reported',
    'status.maintenance': 'Maintenance',
    'status.unknown': 'Unknown',
    'status.latency': 'Latency',
  },
};

const STORAGE_KEY = 'vexis_locale';

let locale = 'th';
let overrides = {};
let locales = [
  { code: 'th', label: 'Thai', nativeLabel: 'ไทย' },
  { code: 'en', label: 'English', nativeLabel: 'English' },
];

export function currentLocale() {
  return locale;
}

export function availableLocales() {
  return locales;
}

export function t(key, fallback = '') {
  const dict = DICT[locale] || {};
  const over = (overrides[locale] || {})[key];
  return over || dict[key] || (DICT.th || {})[key] || fallback || key;
}

export async function initI18n() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && DICT[stored]) locale = stored;
  } catch {
    /* localStorage ปิดอยู่ */
  }
  try {
    const res = await fetch('/api/i18n', { headers: { accept: 'application/json' } });
    if (!res.ok) return;
    const data = await res.json();
    if (Array.isArray(data.locales) && data.locales.length) {
      locales = data.locales.map((row) => ({
        code: row.code,
        label: row.label,
        nativeLabel: row.nativeLabel || row.label,
      }));
    }
    overrides = data.overrides || {};
    if (data.viewerLocale && DICT[data.viewerLocale]) locale = data.viewerLocale;
    else if (!DICT[locale]) locale = data.defaultLocale || 'th';
  } catch {
    /* ใช้ค่าเริ่มต้น th */
  }
}

export async function setLocale(code, { persist = true } = {}) {
  if (!DICT[code]) return;
  locale = code;
  try {
    localStorage.setItem(STORAGE_KEY, code);
  } catch {
    /* ignore */
  }
  if (persist) {
    try {
      await fetch('/api/i18n/preference', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify({ locale: code }),
      });
    } catch {
      /* ผู้เยี่ยมชมที่ยังไม่ล็อกอินเก็บได้แค่ในเบราว์เซอร์ */
    }
  }
  document.documentElement.lang = code;
}

export function languageSwitcher() {
  const options = locales
    .map(
      (row) =>
        `<button class="btn btn-sm ${row.code === locale ? 'btn-primary' : 'btn-ghost'}" data-lang="${row.code}" title="${row.label}">${
          row.code === 'th' ? 'ไทย' : row.code === 'en' ? 'EN' : row.code.toUpperCase()
        }</button>`,
    )
    .join('');
  return `<span class="lang-switch" role="group" aria-label="Language">${options}</span>`;
}

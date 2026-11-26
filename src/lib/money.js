/**
 * เงินแบบแม่นยำ — คำนวณเป็นจำนวนเต็ม "สตางค์" (satang) ทั้งหมด
 * หลีกเลี่ยง floating-point drift เช่น 0.1 + 0.2 ≠ 0.3
 */

const SATANG = 100;

export function toSatang(value) {
  const text = String(value ?? '').replace(/,/g, '').trim();
  if (!text) return 0;
  const num = Number(text);
  if (!Number.isFinite(num)) return 0;
  // ปัดที่ทศนิยม 2 ตำแหน่งก่อนแปลงเป็นสตางค์ แล้วคูณด้วยจำนวนเต็ม
  return Math.round(num * SATANG);
}

export function fromSatang(satang) {
  const value = Math.round(Number(satang) || 0);
  return value / SATANG;
}

/** ค่าธรรมเนียมเป็นสตางค์ (ปัดครึ่งขึ้น) */
export function feeSatang(amountSatang, percent) {
  const pct = Math.round(Number(percent) * 100); // 3 → 300 (basis points * 100)
  return Math.round((Math.round(Number(amountSatang) || 0) * pct) / 10000);
}

/**
 * คิดยอดจากราคาที่ได้รับจริง
 * คืนค่า { amount, fee, net } เป็นตัวเลขทศนิยม 2 ตำแหน่งที่แน่นอน
 */
export function splitFee(amountValue, percent = 3) {
  const amount = Math.max(0, toSatang(amountValue));
  const fee = feeSatang(amount, percent);
  const net = Math.max(0, amount - fee);
  return {
    amountSatang: amount,
    feeSatang: fee,
    netSatang: net,
    amount: fromSatang(amount),
    fee: fromSatang(fee),
    net: fromSatang(net),
  };
}

/** รูปแบบเงินไทยแบบกำหนดทศนิยมเองได้ */
export function thb(value, digits = 2) {
  const num = fromSatang(toSatang(value));
  return num.toLocaleString('th-TH', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

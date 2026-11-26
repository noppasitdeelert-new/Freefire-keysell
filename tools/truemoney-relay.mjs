#!/usr/bin/env node
/**
 * VEXIS — TrueMoney envelope relay
 * ------------------------------------------------------------------
 * ทำไมต้องมีไฟล์นี้: ตัวเว็บรันบน Cloudflare Workers ซึ่ง WAF ของ
 * gift.truemoney.com บล็อก (HTTP 403) จึงรับซองอัตโนมัติจากฝั่งเว็บไม่ได้
 * สคริปต์นี้รันบนเครื่อง/VPS ของร้าน (เน็ตบ้าน/เน็ตไทย) แล้วให้เว็บเรียกผ่าน
 *
 * วิธีใช้:
 *   RELAY_TOKEN=<รหัสลับยาวๆ> node tools/truemoney-relay.mjs
 *
 * แล้วเปิดให้เว็บเข้าถึงได้ด้วย https บนพอร์ต 443 (Workers เรียกพอร์ตอื่นไม่ได้)
 * เช่นใช้ tunnel:
 *   cloudflared tunnel --url http://localhost:8787
 *   # ได้ URL เช่น https://xxx.trycloudflare.com
 *
 * จากนั้นตั้งค่าใน Sites → Secrets ของเว็บ:
 *   TRUEMONEY_RELAY_URL   = https://xxx.trycloudflare.com/redeem
 *   TRUEMONEY_RELAY_TOKEN = รหัสเดียวกับ RELAY_TOKEN
 *
 * ตัวแปรอื่น: PORT (ค่าเริ่มต้น 8787), TM_PHONE (ค่าเริ่มต้น 0805894742)
 */
import http from 'node:http';

const PORT = Number(process.env.PORT || 8787);
const TOKEN = process.env.RELAY_TOKEN || '';
const PHONE = String(process.env.TM_PHONE || '0805894742').replace(/\D/g, '');

if (!TOKEN) {
  console.error('ต้องตั้งค่า RELAY_TOKEN ก่อนรัน (เช่น RELAY_TOKEN=รหัสลับยาวๆ node tools/truemoney-relay.mjs)');
  process.exit(1);
}

const FAIL_MESSAGES = {
  VOUCHER_NOT_FOUND: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  VOUCHER_OUT_OF_STOCK: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  VOUCHER_ALREADY_USED: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  INTERNAL_ERROR: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  BAD_PARAM: 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว',
  TARGET_USER_REDEEMED: 'ซองนี้ถูกรับเงินไปแล้ว ไม่สามารถรับซ้ำได้',
  VOUCHER_EXPIRED: 'ซองนี้หมดอายุแล้ว (เกิน 72 ชั่วโมง)',
  CANNOT_GET_OWN_VOUCHER: 'รับซองที่ตัวเองสร้างไม่ได้',
  TARGET_USER_NOT_FOUND: 'เบอร์รับเงินยังไม่ผูกวอลเล็ต',
};

async function redeem(voucher) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(
      `https://gift.truemoney.com/campaign/vouchers/${encodeURIComponent(voucher)}/redeem`,
      {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/plain, */*',
          'Accept-Language': 'th-TH,th;q=0.9,en;q=0.8',
          Origin: 'https://gift.truemoney.com',
          Referer: `https://gift.truemoney.com/campaign/?v=${encodeURIComponent(voucher)}`,
          'User-Agent':
            'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1',
        },
        body: JSON.stringify({ mobile: PHONE, voucher_hash: voucher }),
      },
    );
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = null;
    }
    if (!payload || !payload.status) {
      return { ok: false, unreachable: true, message: `ทรูมันนี่ตอบกลับผิดรูปแบบ (HTTP ${response.status})` };
    }
    const code = String(payload.status.code || '');
    if (code !== 'SUCCESS') {
      return {
        ok: false,
        code,
        message: FAIL_MESSAGES[code] || String(payload.status.message || 'ลิ้งซองไม่ถูกต้องหรือมีคนใช้ไปแล้ว'),
      };
    }
    const data = payload.data || {};
    const raw = data.my_ticket?.amount_baht || data.voucher?.redeemed_amount_baht || data.voucher?.amount_baht || '0';
    const amount = Math.round((Number(String(raw).replace(/,/g, '')) || 0) * 100) / 100;
    if (!(amount > 0)) return { ok: false, unreachable: true, message: 'รับเงินแล้วแต่ไม่มียอดส่งกลับมา' };
    return {
      ok: true,
      amount,
      sender: String(data.owner_profile?.full_name || ''),
      message: String(payload.status.message || 'Voucher redeemed successfully!'),
    };
  } catch (error) {
    return { ok: false, unreachable: true, message: `เชื่อมต่อทรูมันนี่ไม่ได้ (${error.message})` };
  } finally {
    clearTimeout(timer);
  }
}

const server = http.createServer((req, res) => {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
  };

  if (req.method === 'GET' && req.url === '/health') return send(200, { ok: true, phone: PHONE });
  if (req.method !== 'POST' || !String(req.url).startsWith('/redeem')) return send(404, { ok: false, message: 'not found' });
  if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(401, { ok: false, message: 'unauthorized' });

  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
    if (body.length > 4096) req.destroy();
  });
  req.on('end', async () => {
    let voucher = '';
    try {
      voucher = String(JSON.parse(body).voucher || '');
    } catch {
      return send(400, { ok: false, message: 'invalid json' });
    }
    if (!/^[A-Za-z0-9_-]{6,}$/.test(voucher)) return send(400, { ok: false, message: 'invalid voucher' });
    const result = await redeem(voucher);
    console.log(new Date().toISOString(), voucher, result.ok ? `ok ${result.amount}` : result.code || result.message);
    send(200, result);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`TrueMoney relay พร้อมใช้งานที่พอร์ต ${PORT} (เบอร์รับเงิน ${PHONE})`);
});

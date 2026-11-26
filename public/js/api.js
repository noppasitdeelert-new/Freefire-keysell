const MAX_BODY = 40960;
let unauthorizedHandler = null;

export function onUnauthorized(fn) {
  unauthorizedHandler = fn;
}

export async function api(path, { method = 'GET', body, timeout = 20000 } = {}) {
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    if (payload.length > MAX_BODY) throw new Error('ข้อมูลที่ส่งมีขนาดใหญ่เกินกำหนด');
  }
  for (let attempt = 0; ; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const res = await fetch(`/api${path}`, {
        method,
        credentials: 'same-origin',
        headers: payload === undefined ? { accept: 'application/json' } : { 'content-type': 'application/json', accept: 'application/json' },
        body: payload,
        signal: controller.signal,
      });
      let data = null;
      try {
        data = await res.json();
      } catch {
        data = null;
      }
      if (!res.ok) {
        // คำขออ่านข้อมูลที่ถูกจำกัดความถี่ชั่วคราว → รอตามเวลาที่เซิร์ฟเวอร์บอกแล้วลองใหม่หนึ่งครั้ง
        if (res.status === 429 && method === 'GET' && attempt < 1) {
          const retryAfter = Number(res.headers.get('retry-after') || 0);
          const waitMs = Math.min(5000, (retryAfter > 0 ? retryAfter : 2) * 1000);
          clearTimeout(timer);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }
        if (res.status === 401 && unauthorizedHandler) unauthorizedHandler();
        const error = new Error((data && data.error) || `เกิดข้อผิดพลาด (${res.status})`);
        error.status = res.status;
        error.data = data;
        throw error;
      }
      return data;
    } catch (err) {
      if (err.name === 'AbortError') throw new Error('การเชื่อมต่อใช้เวลานานเกินไป กรุณาลองใหม่');
      if (err instanceof TypeError) throw new Error('เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ กรุณาตรวจสอบอินเทอร์เน็ต');
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function money(value) {
  const n = Number(value) || 0;
  const abs = Math.abs(n);
  const text = abs.toLocaleString('th-TH', { minimumFractionDigits: abs % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 });
  return (n < 0 ? '-฿' : '฿') + text;
}

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function toast(message, type = 'info', timeout = 4200) {
  const root = document.getElementById('toast-root');
  if (!root) return;
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  root.appendChild(node);
  setTimeout(() => {
    node.style.transition = 'opacity .25s, transform .25s';
    node.style.opacity = '0';
    node.style.transform = 'translateX(16px)';
    setTimeout(() => node.remove(), 260);
  }, timeout);
}

export function openModal(innerHtml) {
  const root = document.getElementById('modal-root');
  if (!root) return { close() {} };
  root.innerHTML = `<div class="modal-overlay"><div class="modal">${innerHtml}</div></div>`;
  const overlay = root.firstElementChild;
  const close = () => {
    root.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => {
    if (e.key === 'Escape') close();
  };
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) close();
  });
  document.addEventListener('keydown', onKey);
  return { close, overlay };
}

export function confirmModal({ title, message, confirmText = 'ยืนยัน', danger = false }) {
  return new Promise((resolve) => {
    const modal = openModal(`
      <h3>${escapeHtml(title)}</h3>
      <p class="modal-sub">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn btn-ghost" data-modal-cancel>ยกเลิก</button>
        <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-modal-ok>${escapeHtml(confirmText)}</button>
      </div>
    `);
    modal.overlay.querySelector('[data-modal-cancel]').addEventListener('click', () => {
      modal.close();
      resolve(false);
    });
    modal.overlay.querySelector('[data-modal-ok]').addEventListener('click', () => {
      modal.close();
      resolve(true);
    });
  });
}

export function statusPill(status) {
  const map = {
    pending: ['รอตรวจสอบ', 'pill-pending'],
    approved: ['อนุมัติแล้ว', 'pill-approved'],
    rejected: ['ปฏิเสธ', 'pill-rejected'],
    open: ['รอตอบ', 'pill-open'],
    answered: ['ตอบแล้ว', 'pill-answered'],
    completed: ['สำเร็จ', 'pill-approved'],
    active: ['เปิดใช้งาน', 'pill-approved'],
    suspended: ['ระงับ/ค้างชำระ', 'pill-pending'],
    revoked: ['ถูกปลด', 'pill-rejected'],
    paid: ['ชำระแล้ว', 'pill-approved'],
    unpaid: ['รอชำระ', 'pill-pending'],
    delivered: ['ส่งมอบแล้ว', 'pill-approved'],
    processing: ['กำลังดำเนินการ', 'pill-pending'],
    created: ['สร้างคำสั่งซื้อ', 'pill-open'],
    key_assigned: ['มอบคีย์แล้ว', 'pill-approved'],
    refunded: ['คืนเงินแล้ว', 'pill-rejected'],
    sent: ['ส่งแล้ว', 'pill-approved'],
    failed: ['ส่งไม่สำเร็จ', 'pill-rejected'],
    not_configured: ['ยังไม่ตั้งค่า', 'pill-pending'],
    skipped: ['ข้าม', 'pill-open'],
    disabled: ['ปิดใช้งาน', 'pill-open'],
  };
  const [label, cls] = map[status] || [status, 'pill-open'];
  return `<span class="pill ${cls}">${escapeHtml(label)}</span>`;
}

export function roleBadge(role, label) {
  const cls = `badge badge-${role}`;
  return `<span class="${cls}">${escapeHtml(label || role)}</span>`;
}

export function formatDate(value) {
  if (!value) return '-';
  const iso = String(value).includes('T') ? value : `${value.replace(' ', 'T')}Z`;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return escapeHtml(value);
  return d.toLocaleString('th-TH', {
    day: '2-digit',
    month: 'short',
    year: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

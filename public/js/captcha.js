import { api, escapeHtml } from './api.js';

/**
 * แคปช่าสองโหมด:
 *  - ถ้าตั้งค่า TURNSTILE_SITE_KEY → ใช้ Cloudflare Turnstile (โหมด production)
 *  - ถ้าไม่มี → ใช้แคปช่าคณิตศาสตร์ที่ตรวจฝั่งเซิร์ฟเวอร์ (ใช้งานได้ทันทีในโหมดพรีวิว)
 */
export async function mountCaptcha(container, config) {
  if (!container) return;
  container.dataset.mode = 'pending';
  container.innerHTML = `
    <div class="captcha-box">
      <div class="captcha-head">🛡️ ตรวจสอบความปลอดภัย</div>
      <div class="muted small">กำลังโหลดแคปช่า…</div>
    </div>`;

  if (config && config.turnstileSiteKey) {
    try {
      await loadTurnstile();
      container.dataset.mode = 'turnstile';
      container.innerHTML = `
        <div class="captcha-box">
          <div class="captcha-head">🛡️ ป้องกันโดย Cloudflare Turnstile</div>
          <div class="turnstile-slot"></div>
          <div class="field-hint">ระบบจะยืนยันอัตโนมัติเมื่อผ่านการตรวจสอบ</div>
        </div>`;
      const slot = container.querySelector('.turnstile-slot');
      window.turnstile.render(slot, {
        sitekey: config.turnstileSiteKey,
        theme: 'dark',
        language: 'th',
      });
      return;
    } catch {
      // fallback ไปใช้แคปช่าปกติ
    }
  }

  await refreshMathCaptcha(container);
}

async function loadTurnstile() {
  if (window.turnstile) return;
  await new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      if (window.turnstile) return resolve();
      if (Date.now() - started > 7000) return reject(new Error('turnstile timeout'));
      setTimeout(tick, 120);
    };
    tick();
  });
}

export async function refreshMathCaptcha(container) {
  container.dataset.mode = 'math';
  container.innerHTML = `
    <div class="captcha-box">
      <div class="captcha-head">🛡️ ตรวจสอบความปลอดภัย</div>
      <div class="muted small">กำลังสร้างคำถาม…</div>
    </div>`;
  try {
    const data = await api('/captcha');
    container.dataset.token = data.token;
    container.innerHTML = `
      <div class="captcha-box">
        <div class="captcha-head">🛡️ ตรวจสอบว่าไม่ใช่บอท</div>
        <div class="captcha-question">
          <span class="q">${escapeHtml(data.question)}</span>
          <input class="input" inputmode="numeric" autocomplete="off" maxlength="4" placeholder="คำตอบ" data-captcha-answer />
          <button type="button" class="btn btn-sm btn-ghost" data-captcha-refresh>เปลี่ยน</button>
        </div>
        <div class="field-hint">ตอบคำถามเพื่อยืนยันก่อนสมัคร/เข้าสู่ระบบ</div>
      </div>`;
    container.querySelector('[data-captcha-refresh]').addEventListener('click', () => refreshMathCaptcha(container));
  } catch (err) {
    container.innerHTML = `
      <div class="captcha-box">
        <div class="captcha-head">🛡️ ตรวจสอบความปลอดภัย</div>
        <div class="form-error">${escapeHtml(err.message)}</div>
        <button type="button" class="btn btn-sm btn-ghost" data-captcha-retry>ลองใหม่</button>
      </div>`;
    container.querySelector('[data-captcha-retry]').addEventListener('click', () => refreshMathCaptcha(container));
  }
}

export function captchaPayload(container) {
  if (!container) return {};
  if (container.dataset.mode === 'turnstile') {
    const token = window.turnstile ? window.turnstile.getResponse(container.querySelector('.turnstile-slot')) : '';
    return { turnstileToken: token || '' };
  }
  const answerInput = container.querySelector('[data-captcha-answer]');
  return {
    captchaToken: container.dataset.token || '',
    captchaAnswer: answerInput ? answerInput.value.trim() : '',
  };
}

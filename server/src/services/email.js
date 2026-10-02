import { Resend } from 'resend';
import { escapeHtml } from '../lib/escapeHtml.js';

const resend = process.env.RESEND_API_KEY ? new Resend(process.env.RESEND_API_KEY) : null;

const FROM = 'BQI <onboarding@resend.dev>'; // Resend default until the domain is verified
const TO_CENTER = process.env.CENTER_EMAIL || 'info@boldkimya.com.tr';

/**
 * Sends an approval button email to the central mailbox for login approval.
 */
export async function sendApprovalEmail(userCode, approveUrl, rejectUrl) {
  if (!resend) {
    console.warn('⚠️ RESEND_API_KEY missing — approval email cannot be sent');
    return { skipped: true };
  }

  const html = `
<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><title>BQI Giriş Onayı</title></head>
<body style="margin:0;padding:0;background:#0a0e1a;font-family:'Times New Roman',serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#0a0e1a;padding:40px 20px;">
    <tr><td align="center">
      <table width="600" cellpadding="0" cellspacing="0" style="background:#11172a;border:1px solid #d4af37;border-radius:8px;overflow:hidden;">
        <tr><td style="padding:30px;text-align:center;background:linear-gradient(135deg,#1a2244,#0a0e1a);">
          <h1 style="color:#67e8f9;margin:0;font-size:24px;letter-spacing:3px;">BQI</h1>
          <p style="color:#fff;margin:8px 0 0;font-size:13px;letter-spacing:2px;">KUANTUM TABANLI ULUSAL KARAR DESTEK SİSTEMİ</p>
        </td></tr>
        <tr><td style="padding:40px 30px;color:#e8e8e8;">
          <h2 style="color:#d4af37;font-size:18px;margin:0 0 16px;">GİRİŞ ONAYI TALEBİ</h2>
          <p style="font-size:15px;line-height:1.6;margin:0 0 12px;">
            <strong>Kullanıcı Kodu:</strong> ${escapeHtml(userCode)}<br>
            <strong>Tarih/Saat:</strong> ${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}<br>
            <strong>Talep:</strong> Sisteme giriş için merkez onayı bekleniyor.
          </p>
          <p style="font-size:14px;color:#aaa;margin:20px 0;">Onay süresi: <strong style="color:#d4af37;">10 dakika</strong></p>
          <table width="100%" cellpadding="0" cellspacing="0" style="margin-top:30px;">
            <tr>
              <td align="center" style="padding:0 8px;">
                <a href="${approveUrl}" style="display:inline-block;padding:14px 32px;background:#1a7a3e;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">✓ ONAYLA</a>
              </td>
              <td align="center" style="padding:0 8px;">
                <a href="${rejectUrl}" style="display:inline-block;padding:14px 32px;background:#7a1a1a;color:#fff;text-decoration:none;border-radius:4px;font-weight:bold;letter-spacing:1px;">✗ REDDET</a>
              </td>
            </tr>
          </table>
        </td></tr>
        <tr><td style="padding:20px 30px;background:#080c18;text-align:center;color:#666;font-size:11px;border-top:1px solid #2a3050;">
          Bold Askeri Teknoloji ve Savunma Sanayi A.Ş. — Tüm Hakları Saklıdır<br>
          GİZLİLİK DERECESİ: GİZLİ
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;

  return resend.emails.send({
    from: FROM,
    to: TO_CENTER,
    subject: `[BQI] Giriş Onayı — ${userCode}`,
    html
  });
}

/**
 * Sends the generated analysis report to the central mailbox as a .docx attachment.
 */
export async function sendAnalysisReport(userCode, category, title, docxBuffer) {
  if (!resend) return { skipped: true };

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;">
  <div style="max-width:600px;margin:40px auto;background:#11172a;border:1px solid #d4af37;border-radius:8px;padding:30px;">
    <h2 style="color:#67e8f9;margin-top:0;border-bottom:1px solid #67e8f9;padding-bottom:10px;">BQI ANALİZ ÇIKTISI</h2>
    <table style="width:100%;font-size:14px;line-height:1.8;">
      <tr><td><strong>Kullanıcı:</strong></td><td>${escapeHtml(userCode)}</td></tr>
      <tr><td><strong>Kategori:</strong></td><td>${escapeHtml(category.toUpperCase())}</td></tr>
      <tr><td><strong>Başlık:</strong></td><td>${escapeHtml(title)}</td></tr>
      <tr><td><strong>Tarih:</strong></td><td>${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}</td></tr>
    </table>
    <p style="margin-top:20px;font-size:13px;color:#aaa;">Tam rapor ekteki .docx dosyasındadır.</p>
    <p style="margin-top:30px;font-size:11px;color:#666;border-top:1px solid #2a3050;padding-top:12px;">
      Bold Askeri Teknoloji ve Savunma Sanayi A.Ş. — GİZLİLİK DERECESİ: GİZLİ
    </p>
  </div>
</body></html>`;

  const send = () => resend.emails.send({
    from: FROM,
    to: TO_CENTER,
    subject: `[BQI] ${category.toUpperCase()} Analizi — ${title}`,
    html,
    attachments: [{
      filename: `BQI_${category}_${Date.now()}.docx`,
      content: docxBuffer.toString('base64')
    }]
  });

  // The caller (routes/analysis.js) fires this off without awaiting it, so a
  // transient Resend outage would otherwise silently drop a report meant to
  // reach the compliance mailbox with no second chance. One retry after a
  // short delay covers that without holding up the analysis response.
  try {
    return await send();
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 5000));
    return send();
  }
}

/**
 * Emergency notification (from the center or a regional pin).
 */
export async function sendEmergencyAlert(userCode, message, region = null) {
  if (!resend) return { skipped: true };

  const regionText = region ? `<tr><td><strong>Bölge:</strong></td><td style="color:#ff4444;">${escapeHtml(region)}</td></tr>` : '';

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;">
  <div style="max-width:600px;margin:40px auto;background:#1a0a0a;border:2px solid #ff4444;border-radius:8px;padding:30px;">
    <h1 style="color:#ff4444;margin:0 0 16px;text-align:center;letter-spacing:3px;">🚨 ACİL DURUM BİLDİRİMİ 🚨</h1>
    <table style="width:100%;font-size:14px;line-height:1.8;background:#11172a;padding:16px;border-radius:4px;">
      <tr><td><strong>Kullanıcı:</strong></td><td>${escapeHtml(userCode || 'ANONİM (giriş yapılmamış)')}</td></tr>
      <tr><td><strong>Tarih/Saat:</strong></td><td>${new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' })}</td></tr>
      ${regionText}
    </table>
    <div style="margin-top:20px;background:#11172a;padding:16px;border-left:4px solid #ff4444;">
      <strong style="color:#ff4444;">MESAJ:</strong>
      <p style="white-space:pre-wrap;margin:10px 0 0;font-size:15px;">${escapeHtml(message)}</p>
    </div>
    <p style="margin-top:30px;font-size:11px;color:#666;text-align:center;">
      Bold Askeri Teknoloji ve Savunma Sanayi A.Ş.
    </p>
  </div>
</body></html>`;

  return resend.emails.send({
    from: FROM,
    to: TO_CENTER,
    subject: `🚨 [ACİL] BQI ${region ? `— ${String(region).slice(0, 100)}` : ''}`,
    html
  });
}

/**
 * Emergency broadcast ("Kullanıcılara Bildir") also emailed to every
 * registered user with an email on file -- not just whoever happens to be
 * online at that moment, since an inactive user has no other way to see it.
 * Sent as individual messages (not one email with everyone in the To/Cc
 * list) so recipients don't see each other's addresses.
 */
export async function sendEmergencyBroadcastEmail(fromUserCode, message, recipients) {
  if (!resend || !recipients?.length) return { skipped: true };
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  const html = (nickname) => `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;">
  <div style="max-width:600px;margin:40px auto;background:#1a0a0a;border:2px solid #ff4444;border-radius:8px;padding:30px;">
    <h1 style="color:#ff4444;margin:0 0 16px;text-align:center;letter-spacing:3px;">🚨 ACİL DURUM BİLDİRİMİ 🚨</h1>
    <p style="font-size:14px;">Sayın ${escapeHtml(nickname || '')},</p>
    <table style="width:100%;font-size:14px;line-height:1.8;background:#11172a;padding:16px;border-radius:4px;">
      <tr><td><strong>Gönderen:</strong></td><td>${escapeHtml(fromUserCode || 'ANONİM')}</td></tr>
      <tr><td><strong>Tarih/Saat:</strong></td><td>${now}</td></tr>
    </table>
    <div style="margin-top:20px;background:#11172a;padding:16px;border-left:4px solid #ff4444;">
      <strong style="color:#ff4444;">MESAJ:</strong>
      <p style="white-space:pre-wrap;margin:10px 0 0;font-size:15px;">${escapeHtml(message)}</p>
    </div>
    <p style="margin-top:20px;font-size:12px;color:#aaa;">
      Bu bildirimi sistemde o an çevrimiçi olmasanız bile aldınız -- BQI acil durum
      bildirimlerini tüm kayıtlı kullanıcılara e-posta ile de iletir.
    </p>
    <p style="margin-top:30px;font-size:11px;color:#666;text-align:center;">
      Bold Askeri Teknoloji ve Savunma Sanayi A.Ş.
    </p>
  </div>
</body></html>`;

  return Promise.allSettled(
    recipients.map((r) => resend.emails.send({
      from: FROM,
      to: r.email,
      subject: '🚨 [ACİL] BQI — Kullanıcılara Bildirim',
      html: html(r.nickname),
    }))
  );
}

/**
 * Direct-message fallback: if the recipient isn't currently connected via
 * socket, they'd otherwise never see the message until their next login --
 * email them instead so they know to check the messaging panel.
 */
export async function sendDirectMessageEmail(toEmail, toNickname, fromNickname, message) {
  if (!resend || !toEmail) return { skipped: true };
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  const html = `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;">
  <div style="max-width:600px;margin:40px auto;background:#11172a;border:1px solid #d4af37;border-radius:8px;padding:28px;">
    <h2 style="color:#67e8f9;margin:0 0 12px;letter-spacing:1px;">BQI — YENİ MESAJ</h2>
    <p style="margin:0 0 10px;font-size:14px;">Sayın ${escapeHtml(toNickname || '')},</p>
    <p style="margin:0 0 10px;font-size:14px;"><strong>${escapeHtml(fromNickname)}</strong> size bir mesaj gönderdi:</p>
    <div style="margin-top:10px;background:#0d1424;padding:16px;border-left:4px solid #d4af37;">
      <p style="white-space:pre-wrap;margin:0;font-size:15px;">${escapeHtml(message)}</p>
    </div>
    <p style="margin-top:16px;font-size:12px;color:#aaa;">Tarih/Saat: ${now}</p>
    <p style="margin-top:20px;font-size:12px;color:#aaa;">
      Yanıtlamak için sisteme giriş yapıp Acil Merkez &gt; Mesajlaşma panelini kullanınız.
    </p>
  </div>
</body></html>`;

  return resend.emails.send({
    from: FROM,
    to: toEmail,
    subject: `[BQI] ${fromNickname} size mesaj gönderdi`,
    html,
  });
}

/**
 * Meeting-start notification to every registered user (active or not) --
 * mirrors sendVideoMeetingStartedAlert (which only goes to the center
 * mailbox) but reaches everyone who might want to join.
 */
export async function sendVideoMeetingStartedToUsers(hostNickname, recipients) {
  if (!resend || !recipients?.length) return { skipped: true };
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

  const html = (nickname) => `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;">
  <div style="max-width:600px;margin:40px auto;background:#11172a;border:1px solid #d4af37;border-radius:8px;padding:28px;">
    <h2 style="color:#67e8f9;margin:0 0 12px;letter-spacing:1px;">BQI GÖRÜNTÜLÜ TOPLANTI BİLDİRİMİ</h2>
    <p style="margin:0 0 10px;font-size:14px;">Sayın ${escapeHtml(nickname || '')},</p>
    <p style="margin:0 0 10px;font-size:14px;"><strong>${escapeHtml(hostNickname || 'BOLD')}</strong> bir görüntülü toplantı başlattı.</p>
    <p style="margin:0 0 10px;font-size:14px;"><strong>Tarih/Saat:</strong> ${now}</p>
    <p style="margin:14px 0 0;font-size:14px;color:#d7dbe6;">
      Katılmak için sisteme giriş yapıp Acil Merkez &gt; Mesajlaşma panelinden "Toplantıya Katıl" düğmesini kullanınız.
    </p>
  </div>
</body></html>`;

  return Promise.allSettled(
    recipients.map((r) => resend.emails.send({
      from: FROM,
      to: r.email,
      subject: `[BQI] Görüntülü Toplantı Başlatıldı — ${hostNickname || 'BOLD'}`,
      html: html(r.nickname),
    }))
  );
}

export async function sendVideoMeetingStartedAlert(hostUserCode) {
  if (!resend) return { skipped: true };
  const now = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });
  const html = `
<!DOCTYPE html>
<html><body style="margin:0;background:#0a0e1a;font-family:'Times New Roman',serif;color:#e8e8e8;">
  <div style="max-width:600px;margin:40px auto;background:#11172a;border:1px solid #d4af37;border-radius:8px;padding:28px;">
    <h2 style="color:#67e8f9;margin:0 0 12px;letter-spacing:1px;">BQI GÖRÜNTÜLÜ TOPLANTI BİLDİRİMİ</h2>
    <p style="margin:0 0 10px;font-size:14px;"><strong>Başlatan:</strong> ${escapeHtml(hostUserCode || 'BOLD')}</p>
    <p style="margin:0 0 10px;font-size:14px;"><strong>Tarih/Saat:</strong> ${now}</p>
    <p style="margin:14px 0 0;font-size:14px;color:#d7dbe6;">
      Görüntülü konuşma oturumu başlatıldı. Takip için Acil Merkez &gt; Mesajlaşma panelini kontrol ediniz.
    </p>
  </div>
</body></html>`;

  return resend.emails.send({
    from: FROM,
    to: TO_CENTER,
      subject: `[BQI] Görüntülü Toplantı Başlatıldı - ${hostUserCode || 'BOLD'}`,
    html
  });
}


/**
 * BFI situation report mail: short summary in the body, the full report as an HTML attachment. Recipients come from SFRE_ALERT_EMAILS
 * (comma separated), falling back to the central mailbox. Note: with the Resend test sender, only the account owner's address receives mail
 * until a domain is verified.
 */
export async function sendSfreReportEmail({ subject, text, html, attachments = [] }) {
  if (!resend) return { skipped: true, reason: 'RESEND_API_KEY not set' };
  const to = (process.env.SFRE_ALERT_EMAILS || TO_CENTER).split(',').map((x) => x.trim()).filter(Boolean);
  return resend.emails.send({ from: FROM, to, subject: String(subject).slice(0, 200), text, html, attachments });
}

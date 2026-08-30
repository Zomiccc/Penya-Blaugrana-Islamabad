// Resend transactional email helper.
// Used for membership confirmations, payment receipts, and Match Predictions
// auth codes (OTP for setting/resetting member passwords).
const { Resend } = require('resend');

const RESEND_API_KEY = process.env.RESEND_API_KEY || '';
const FROM_EMAIL = process.env.EMAIL_FROM || 'noreply@pbisb.com';
const FROM_NAME = process.env.EMAIL_FROM_NAME || 'Penya Blaugrana Islamabad';

const resend = RESEND_API_KEY ? new Resend(RESEND_API_KEY) : null;
const enabled = Boolean(resend);
if (!enabled) console.warn('[mailer] RESEND_API_KEY not set — emails will not be sent.');

// Build a membership label like "Adult" / "Kids (Under 16)"
function membershipLabel(type) {
  return type === 'kids' ? 'Kids (Under 16)' : 'Adult';
}

// Format currency nicely: PKR 3,000
function formatMoney(amount, currency) {
  return `${currency || 'PKR'} ${Number(amount || 0).toLocaleString()}`;
}

/**
 * Low-level send wrapper so every function below shares the same from/to/logic.
 */
async function send({ to, subject, text, html }) {
  if (!enabled) {
    console.warn('[mailer] send() called but Resend is not enabled');
    return;
  }
  try {
    const { data, error } = await resend.emails.send({
      from: `${FROM_NAME} <${FROM_EMAIL}>`,
      to,
      subject,
      text,
      html,
    });
    if (error) {
      console.error('[mailer] Resend API error:', error);
      throw new Error(`Resend error: ${error.message || JSON.stringify(error)}`);
    }
    console.log('[mailer] Email sent to:', to, '| id:', data?.id);
  } catch (err) {
    console.error('[mailer] Failed to send email to', to, ':', err.message);
    throw err;
  }
}

/**
 * Send a confirmation email when a membership application is submitted.
 */
async function sendJoinConfirmation(member) {
  if (!enabled) return;
  const dateStr = new Date(member.createdAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', dateStyle: 'long', timeStyle: 'short',
  });
  const text = [
    `Hola ${member.firstName},`,
    '',
    'Thank you for applying to join Penya Blaugrana Islamabad.',
    '',
    `Application reference: ${member.id}`,
    `Membership type: ${membershipLabel(member.membershipType)}`,
    `Fee: ${formatMoney(member.amount, member.currency)}`,
    `Submitted: ${dateStr}`,
    '',
    member.amount && member.status === 'pending'
      ? 'Your application has been received. You will receive a separate payment confirmation once your fee is processed.'
      : '',
    '',
    'Més que un club — Visca el Barça!',
    'Penya Blaugrana Islamabad',
  ].filter(Boolean).join('\n');

  await send({
    to: member.email,
    subject: 'Welcome to Penya Blaugrana Islamabad — application received',
    text,
  });
}

/**
 * Send a payment confirmation / receipt email once the membership is paid.
 */
async function sendPaymentReceipt(member) {
  if (!enabled) {
    console.warn('[mailer] sendPaymentReceipt called but Resend is not enabled');
    return;
  }
  console.log('[mailer] sendPaymentReceipt called for:', member.email);
  const paidDate = new Date(member.paidAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', dateStyle: 'long', timeStyle: 'short',
  });
  const text = [
    `Hola ${member.firstName},`,
    '',
    'Great news — your membership payment has been confirmed!',
    '',
    `Application reference: ${member.id}`,
    `Membership type: ${membershipLabel(member.membershipType)}`,
    `Amount paid: ${formatMoney(member.amount, member.currency)}`,
    `Paid on: ${paidDate}`,
    '',
    'You are now part of the Penya Blaugrana Islamabad family. Watch this space for match-day screening details and events.',
    '',
    'Més que un club — Visca el Barça!',
    'Penya Blaugrana Islamabad',
  ].join('\n');

  await send({
    to: member.email,
    subject: 'Payment confirmed — you are a member of Penya Blaugrana Islamabad!',
    text,
  });
}

/**
 * Send a member the 6-digit code they need to set (or reset) their Match
 * Predictions password. Short-lived and single-use — see server.js.
 */
async function sendMemberAuthCode(member, code, minutes) {
  if (!enabled) {
    console.warn('[mailer] sendMemberAuthCode called but Resend is not enabled');
    return;
  }
  const text = [
    `Hola ${member.firstName},`,
    '',
    'Use this code to set your password for the Penya Blaugrana Islamabad Match Predictions:',
    '',
    `    ${code}`,
    '',
    `The code expires in ${minutes} minutes and can only be used once.`,
    '',
    'If you did not request this, you can safely ignore this email — your account is unchanged.',
    '',
    'Més que un club — Visca el Barça!',
    'Penya Blaugrana Islamabad',
  ].join('\n');

  const html = [
    `<p>Hola ${member.firstName},</p>`,
    '<p>Use this code to set your password for the Penya Blaugrana Islamabad Match Predictions:</p>',
    `<p style="font-size:2rem;font-weight:700;letter-spacing:.3em;color:#EDBB00;background:#0A1024;padding:16px 20px;border-radius:4px;text-align:center;margin:20px 0">${code}</p>`,
    `<p>The code expires in ${minutes} minutes and can only be used once.</p>`,
    '<p>If you did not request this, you can safely ignore this email — your account is unchanged.</p>',
    '<p style="color:#888;font-size:.85rem">Més que un club — Visca el Barça!<br>Penya Blaugrana Islamabad</p>',
  ].join('');

  await send({
    to: member.email,
    subject: `Your Match Predictions code: ${code}`,
    text,
    html,
  });
  console.log('[mailer] Match Predictions code sent to:', member.email);
}

module.exports = { sendJoinConfirmation, sendPaymentReceipt, sendMemberAuthCode, enabled };

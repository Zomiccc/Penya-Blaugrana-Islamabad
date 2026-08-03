// SendGrid transactional email helper.
// Used to send membership confirmations and payment receipts so they land
// in the client's inbox (not spam) — provided the sender is verified and
// SPF/DKIM are configured on the sending domain in the SendGrid dashboard.
const sgMail = require('@sendgrid/mail');
const SENDGRID_API_KEY = process.env.SENDGRID_API_KEY || '';
// Default to the verified sender on this SendGrid account. The "from" address
// MUST be a verified sender/domain in SendGrid or the API rejects the mail.
const FROM_EMAIL = process.env.SENDGRID_FROM_EMAIL || 'norepfxons@gmail.com';
const FROM_NAME = process.env.SENDGRID_FROM_NAME || 'Penya Blaugrana Islamabad';

const enabled = Boolean(SENDGRID_API_KEY);
if (enabled) sgMail.setApiKey(SENDGRID_API_KEY);
else console.warn('[mailer] SENDGRID_API_KEY not set — emails will not be sent.');

// Build a membership label like "Adult" / "Kids (Under 16)"
function membershipLabel(type) {
  return type === 'kids' ? 'Kids (Under 16)' : 'Adult';
}

// Format currency nicely: PKR 3,000
function formatMoney(amount, currency) {
  return `${currency || 'PKR'} ${Number(amount || 0).toLocaleString()}`;
}

/**
 * Send a confirmation email when a membership application is submitted.
 * @param {object} member  The member record just saved.
 * @returns {Promise<void>}
 */
async function sendJoinConfirmation(member) {
  if (!enabled) return;
  const dateStr = new Date(member.createdAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', dateStyle: 'long', timeStyle: 'short',
  });
  const msg = {
    to: member.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Welcome to Penya Blaugrana Islamabad — application received',
    text: [
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
    ].filter(Boolean).join('\n'),
  };

  await sgMail.send(msg);
}

/**
 * Send a payment confirmation / receipt email once the membership is paid.
 * @param {object} member  The member record with status = 'paid'.
 * @returns {Promise<void>}
 */
async function sendPaymentReceipt(member) {
  if (!enabled) {
    console.warn('[mailer] sendPaymentReceipt called but SendGrid is not enabled');
    return;
  }
  console.log('[mailer] sendPaymentReceipt called for:', member.email, 'member:', member.firstName, member.lastName);

  const paidDate = new Date(member.paidAt).toLocaleString('en-GB', {
    timeZone: 'Asia/Karachi', dateStyle: 'long', timeStyle: 'short',
  });
  const msg = {
    to: member.email,
    from: { email: FROM_EMAIL, name: FROM_NAME },
    subject: 'Payment confirmed — you are a member of Penya Blaugrana Islamabad! 🎉',
    text: [
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
    ].join('\n'),
  };

  console.log('[mailer] Sending payment receipt email to:', member.email);
  await sgMail.send(msg);
  console.log('[mailer] Payment receipt email sent successfully to:', member.email);
}

module.exports = { sendJoinConfirmation, sendPaymentReceipt, enabled };
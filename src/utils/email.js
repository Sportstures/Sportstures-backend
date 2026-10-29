const nodemailer = require('nodemailer');
const { contactEmail } = require('./contacts');
const { crestAttachment } = require('../emails/layout');
const { verificationCodeEmail } = require('../emails/verificationCode');

function createTransport() {
  const host = process.env.SMTP_HOST;
  if (!host || !process.env.SMTP_FROM) {
    throw new Error('SMTP_HOST and SMTP_FROM must be configured to send verification emails');
  }

  const port = Number.parseInt(process.env.SMTP_PORT || '587', 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('SMTP_PORT must be a valid port number');
  }

  const transportOptions = {
    host,
    port,
    secure: process.env.SMTP_SECURE === 'true' || (process.env.SMTP_SECURE !== 'false' && port === 465),
  };
  if (process.env.SMTP_USER || process.env.SMTP_PASSWORD) {
    if (!process.env.SMTP_USER || !process.env.SMTP_PASSWORD) {
      throw new Error('SMTP_USER and SMTP_PASSWORD must both be configured');
    }
    transportOptions.auth = {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASSWORD,
    };
  }

  return nodemailer.createTransport(transportOptions);
}

// Sends a branded email from no-reply. Replies go to the support mailbox instead.
async function sendEmail({ to, subject, text, html }) {
  await createTransport().sendMail({
    from: process.env.SMTP_FROM,
    replyTo: contactEmail('support'),
    to,
    subject,
    text,
    html,
    attachments: [crestAttachment],
  });
}

async function sendVerificationCode(email, otp, { firstName, expiresInMinutes } = {}) {
  await sendEmail({ to: email, ...verificationCodeEmail({ otp, firstName, expiresInMinutes }) });
}

module.exports = { sendEmail, sendVerificationCode };

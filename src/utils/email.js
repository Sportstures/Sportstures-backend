const nodemailer = require('nodemailer');

async function sendVerificationCode(email, otp) {
  const host = process.env.SMTP_HOST;
  const from = process.env.SMTP_FROM;
  if (!host || !from) {
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

  const transporter = nodemailer.createTransport(transportOptions);
  await transporter.sendMail({
    from,
    to: email,
    subject: 'Your Sportstures verification code',
    text: `Your Sportstures verification code is ${otp}. It expires in 10 minutes.`,
    html: `<p>Your Sportstures verification code is:</p><p><strong>${otp}</strong></p><p>It expires in 10 minutes.</p>`,
  });
}

module.exports = { sendVerificationCode };

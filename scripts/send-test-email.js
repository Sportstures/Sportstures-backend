// Sends one test email with the SMTP settings in .env, to check the mailbox login works.
//
//   npm run email:test -- you@example.com
//
// It really sends (even in development), so use an address you can open. The password is never printed.
require('dotenv').config();
const { sendEmail } = require('../src/utils/email');

const to = process.argv[2];
if (!to || !to.includes('@')) {
  console.error('Usage: npm run email:test -- someone@example.com');
  process.exit(1);
}

const missing = ['SMTP_HOST', 'SMTP_FROM', 'SMTP_USER', 'SMTP_PASSWORD'].filter((k) => !process.env[k]);
if (missing.length) {
  console.error(`Missing in .env: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(`Sending from ${process.env.SMTP_FROM}`);
console.log(`Server: ${process.env.SMTP_HOST}:${process.env.SMTP_PORT || '587'} (secure: ${process.env.SMTP_SECURE || 'auto'}), login: ${process.env.SMTP_USER}`);

sendEmail({
  to,
  subject: 'Sportstures test email',
  text: 'If you can read this, Sportstures can send email. You can ignore this message.',
  html: '<p>If you can read this, <strong>Sportstures can send email</strong>. You can ignore this message.</p>',
})
  .then(() => console.log(`Sent. Check the inbox of ${to} (and its spam folder).`))
  .catch((err) => {
    console.error(`Failed: ${err.message}`);
    console.error('Check SMTP_HOST, SMTP_PORT (465 with SMTP_SECURE=true, or 587 with SMTP_SECURE=false), SMTP_USER (the full address) and the password.');
    process.exit(1);
  });

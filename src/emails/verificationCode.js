const { COLORS, escapeHtml, renderLayout, textFooter } = require('./layout');

// The wording for each kind of code. `signup` is sent after learner or coach signup and on resend.
const PURPOSES = {
  signup: {
    subject: (otp) => `${otp} is your Sportstures verification code`,
    heading: 'Confirm your email',
    intro: 'Welcome to Sportstures. Enter this code in the app to verify your email and finish setting up your account.',
    label: 'Your verification code',
    ignore: "Didn't sign up for Sportstures? You can ignore this email. The account won't be activated without this code.",
  },
  password_reset: {
    subject: (otp) => `${otp} is your Sportstures password reset code`,
    heading: 'Reset your password',
    intro: 'We received a request to reset your Sportstures password. Enter this code in the app to choose a new one.',
    label: 'Your reset code',
    ignore: "Didn't ask to reset your password? You can ignore this email. Your password stays the same without this code.",
  },
  email_change: {
    subject: (otp) => `${otp} is your Sportstures email confirmation code`,
    heading: 'Confirm your new email',
    intro: 'Enter this code in the app to start using this address for your Sportstures account.',
    label: 'Your confirmation code',
    ignore: "Didn't ask to change your email? You can ignore this email. Nothing changes without this code.",
  },
};

function verificationCodeEmail({ otp, firstName, expiresInMinutes = 10, purpose = 'signup', crestSrc }) {
  const copy = PURPOSES[purpose] || PURPOSES.signup;
  const name = firstName && firstName.trim() ? firstName.trim() : null;
  const greeting = name ? `Hi ${escapeHtml(name)},` : 'Hi there,';
  const subject = copy.subject(otp);

  const content = `
            <h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:800;color:${COLORS.darkGreen};">${copy.heading}</h1>
            <p style="margin:0 0 8px;font-size:16px;line-height:24px;">${greeting}</p>
            <p style="margin:0 0 24px;font-size:16px;line-height:24px;color:${COLORS.textSecondary};">
              ${copy.intro}
            </p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td align="center" bgcolor="${COLORS.cream}" style="background-color:${COLORS.cream};border:1px solid ${COLORS.border};border-radius:12px;padding:24px 16px;">
                  <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${COLORS.textSecondary};">${copy.label}</p>
                  <p class="otp" style="margin:0;padding-left:12px;font-size:40px;line-height:48px;font-weight:800;letter-spacing:12px;color:${COLORS.green};font-variant-numeric:tabular-nums;">${escapeHtml(otp)}</p>
                  <p style="margin:12px 0 0;font-size:13px;line-height:20px;color:${COLORS.textSecondary};">
                    Expires in <strong style="color:${COLORS.text};">${expiresInMinutes} minutes</strong>
                  </p>
                </td>
              </tr>
            </table>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top:24px;">
              <tr>
                <td bgcolor="#FFF6E0" style="background-color:#FFF6E0;border-left:4px solid ${COLORS.gold};border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;line-height:21px;color:${COLORS.text};">
                  <strong>Keep this code private.</strong> Sportstures will never ask you for it by phone, message or email.
                </td>
              </tr>
            </table>
            <p style="margin:24px 0 0;font-size:14px;line-height:21px;color:${COLORS.textSecondary};">
              ${copy.ignore}
            </p>`;

  const text = `${name ? `Hi ${name},` : 'Hi there,'}

${copy.intro}

    ${otp}

It expires in ${expiresInMinutes} minutes.

Keep this code private. Sportstures will never ask you for it by phone, message or email.

${copy.ignore}${textFooter()}`;

  const html = renderLayout({
    title: subject,
    preheader: `Your code is ${otp}. It expires in ${expiresInMinutes} minutes.`,
    content,
    crestSrc,
  });

  return { subject, text, html };
}

module.exports = { verificationCodeEmail };

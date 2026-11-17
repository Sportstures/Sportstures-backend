const { COLORS, escapeHtml, renderLayout, textFooter } = require('./layout');
const { contactEmail } = require('../utils/contacts');

// Security notices after an account change, so the owner hears about a change they did not make.
function accountNoticeEmail({ kind, firstName, newEmail, crestSrc }) {
  const name = firstName && firstName.trim() ? firstName.trim() : null;
  const support = contactEmail('support');

  const notices = {
    password_changed: {
      subject: 'Your Sportstures password was changed',
      heading: 'Password changed',
      body: 'The password for your Sportstures account was just changed, and you were signed out on your other devices.',
    },
    email_changed: {
      subject: 'Your Sportstures email address was changed',
      heading: 'Email address changed',
      body: `Your Sportstures account now signs in with ${newEmail}. This address will no longer receive emails about the account.`,
    },
  };
  const notice = notices[kind];
  if (!notice) throw new Error(`Unknown account notice: ${kind}`);

  const warning = `If you didn't make this change, contact ${support} straight away so we can secure your account.`;

  const content = `
            <h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:800;color:${COLORS.darkGreen};">${notice.heading}</h1>
            <p style="margin:0 0 8px;font-size:16px;line-height:24px;">${name ? `Hi ${escapeHtml(name)},` : 'Hi there,'}</p>
            <p style="margin:0 0 24px;font-size:16px;line-height:24px;color:${COLORS.textSecondary};">${escapeHtml(notice.body)}</p>
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td bgcolor="#FFF6E0" style="background-color:#FFF6E0;border-left:4px solid ${COLORS.gold};border-radius:0 8px 8px 0;padding:14px 16px;font-size:14px;line-height:21px;color:${COLORS.text};">
                  ${escapeHtml(warning)}
                </td>
              </tr>
            </table>`;

  const text = `${name ? `Hi ${name},` : 'Hi there,'}

${notice.body}

${warning}${textFooter()}`;

  const html = renderLayout({ title: notice.subject, preheader: notice.body, content, crestSrc });
  return { subject: notice.subject, text, html };
}

module.exports = { accountNoticeEmail };

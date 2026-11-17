const { COLORS, escapeHtml, renderLayout, textFooter } = require('./layout');

// Sent when a coach invites a coach at another school by email.
function coachInvitationEmail({ inviterName, schoolName, link, expiresInDays = 14, crestSrc }) {
  const who = inviterName && inviterName.trim() ? inviterName.trim() : 'A coach';
  const from = schoolName ? `${who} from ${schoolName}` : who;
  const subject = `${from} invited you to join Sportstures`;

  const content = `
            <h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:800;color:${COLORS.darkGreen};">You're invited to Sportstures</h1>
            <p style="margin:0 0 16px;font-size:16px;line-height:24px;">Hi there,</p>
            <p style="margin:0 0 24px;font-size:16px;line-height:24px;color:${COLORS.textSecondary};">
              <strong style="color:${COLORS.text};">${escapeHtml(from)}</strong> has invited you to join Sportstures, the home of school sport in South Africa.
              Register your school's team to schedule fixtures, record results and appear in the standings.
            </p>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto 24px;">
              <tr>
                <td align="center" bgcolor="${COLORS.green}" style="background-color:${COLORS.green};border-radius:10px;">
                  <a href="${escapeHtml(link)}" style="display:inline-block;padding:14px 32px;font-size:16px;font-weight:700;color:#FFFFFF;text-decoration:none;">Register as a coach</a>
                </td>
              </tr>
            </table>
            <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${COLORS.textSecondary};">If the button doesn't work, copy this link into your browser:</p>
            <p style="margin:0 0 24px;font-size:13px;line-height:20px;word-break:break-all;"><a href="${escapeHtml(link)}" style="color:${COLORS.green};">${escapeHtml(link)}</a></p>
            <p style="margin:0;font-size:14px;line-height:21px;color:${COLORS.textSecondary};">
              This invitation expires in ${expiresInDays} days. Not expecting it? You can ignore this email. Nothing happens unless you register.
            </p>`;

  const text = `Hi there,

${from} has invited you to join Sportstures, the home of school sport in South Africa. Register your school's team to schedule fixtures, record results and appear in the standings.

Register as a coach: ${link}

This invitation expires in ${expiresInDays} days. Not expecting it? You can ignore this email. Nothing happens unless you register.${textFooter()}`;

  const html = renderLayout({ title: subject, preheader: `${from} invited you to join Sportstures.`, content, crestSrc });
  return { subject, text, html };
}

module.exports = { coachInvitationEmail };

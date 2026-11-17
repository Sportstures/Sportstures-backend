const { COLORS, escapeHtml, renderLayout, textFooter } = require('./layout');

const TOPIC_LABELS = { account: 'Account', matches: 'Matches', teams: 'Teams', other: 'Other' };

// Paragraphs of user text, escaped, with line breaks kept.
function htmlText(value) {
  return escapeHtml(value).replace(/\r?\n/g, '<br>');
}

function detailRows(rows) {
  return rows.map(([label, value]) => `
              <tr>
                <td style="padding:6px 12px 6px 0;font-size:13px;color:${COLORS.textSecondary};white-space:nowrap;vertical-align:top;">${escapeHtml(label)}</td>
                <td style="padding:6px 0;font-size:14px;color:${COLORS.text};">${escapeHtml(value)}</td>
              </tr>`).join('');
}

// The message as support receives it. Replying goes to the sender (Reply-To is set by the caller).
function supportMessageEmail({ id, topic, subject, message, email, name, user, app, crestSrc }) {
  const topicLabel = TOPIC_LABELS[topic] || topic;
  const emailSubject = `[Support #${id} · ${topicLabel}] ${subject}`;

  const details = [
    ['From', name ? `${name} <${email}>` : email],
    ['Topic', topicLabel],
    ['Signed in', user ? 'Yes' : 'No'],
  ];
  if (user) {
    details.push(['User id', String(user.id)], ['Role', user.role]);
    if (user.school) details.push(['School', user.school]);
  }
  if (app && app.platform) details.push(['Platform', app.platform]);
  if (app && app.version) details.push(['App version', app.version]);
  details.push(['Reference', `#${id}`]);

  const content = `
            <h1 style="margin:0 0 16px;font-size:22px;line-height:30px;font-weight:800;color:${COLORS.darkGreen};">${escapeHtml(subject)}</h1>
            <div style="margin:0 0 24px;padding:16px;border:1px solid ${COLORS.border};border-radius:12px;background-color:${COLORS.cream};font-size:15px;line-height:23px;color:${COLORS.text};">${htmlText(message)}</div>
            <table role="presentation" cellpadding="0" cellspacing="0" border="0">${detailRows(details)}
            </table>
            <p style="margin:24px 0 0;font-size:13px;line-height:20px;color:${COLORS.textSecondary};">Reply to this email to answer ${escapeHtml(name || email)} directly.</p>`;

  const text = `${subject}

${message}

${details.map(([label, value]) => `${label}: ${value}`).join('\n')}

Reply to this email to answer ${name || email} directly.`;

  const html = renderLayout({ title: emailSubject, preheader: message.slice(0, 120), content, crestSrc });
  return { subject: emailSubject, text, html };
}

// The short "we got your message" email to the sender.
function supportReceiptEmail({ id, subject, message, name, crestSrc }) {
  const emailSubject = `We got your message (#${id})`;
  const greeting = name ? `Hi ${name},` : 'Hi there,';
  const intro = "Thanks for contacting Sportstures support. We've received your message and will reply to this address, usually within two working days.";

  const content = `
            <h1 style="margin:0 0 16px;font-size:24px;line-height:32px;font-weight:800;color:${COLORS.darkGreen};">We got your message</h1>
            <p style="margin:0 0 8px;font-size:16px;line-height:24px;">${escapeHtml(greeting)}</p>
            <p style="margin:0 0 24px;font-size:16px;line-height:24px;color:${COLORS.textSecondary};">${escapeHtml(intro)}</p>
            <p style="margin:0 0 8px;font-size:11px;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:${COLORS.textSecondary};">Your message (#${id})</p>
            <div style="padding:16px;border:1px solid ${COLORS.border};border-radius:12px;background-color:${COLORS.cream};font-size:15px;line-height:23px;color:${COLORS.text};">
              <strong>${escapeHtml(subject)}</strong><br><br>${htmlText(message)}
            </div>`;

  const text = `${greeting}

${intro}

Your message (#${id}):
${subject}

${message}${textFooter()}`;

  const html = renderLayout({ title: emailSubject, preheader: intro, content, crestSrc });
  return { subject: emailSubject, text, html };
}

module.exports = { supportMessageEmail, supportReceiptEmail, TOPIC_LABELS };

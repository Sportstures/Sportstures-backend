const path = require('path');
const { contactEmail } = require('../utils/contacts');

// Brand colours from the mobile app (lib/core/constants/app_colors.dart).
const COLORS = {
  green: '#005F29',
  darkGreen: '#0C2414',
  gold: '#FFB000',
  cream: '#F7F4EE',
  border: '#E4E0D8',
  text: '#111418',
  textSecondary: '#5F6670',
  textMuted: '#8A8F98',
};

const FONT = "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// Embedded with the email (cid:) so it shows without loading remote images.
const CREST_CID = 'crest@sportstures';
const crestAttachment = {
  filename: 'sportstures.png',
  path: path.join(__dirname, 'assets', 'crest.png'),
  cid: CREST_CID,
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Shared shell for every Sportstures email: green header with the crest, white card, footer.
// `content` is trusted HTML; escape any user data before passing it in.
function renderLayout({ title, preheader, content, crestSrc = `cid:${CREST_CID}` }) {
  const support = contactEmail('support');
  const privacy = contactEmail('privacy');
  const year = new Date().getFullYear();
  const link = `color:${COLORS.green};text-decoration:underline;`;

  return `<!DOCTYPE html>
<html lang="en" xmlns="http://www.w3.org/1999/xhtml" xmlns:o="urn:schemas-microsoft-com:office:office">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="x-apple-disable-message-reformatting">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(title)}</title>
<!--[if mso]><noscript><xml><o:OfficeDocumentSettings><o:PixelsPerInch>96</o:PixelsPerInch></o:OfficeDocumentSettings></xml></noscript><![endif]-->
<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
<style>
  body { margin:0; padding:0; width:100% !important; -webkit-text-size-adjust:100%; }
  a[x-apple-data-detectors] { color:inherit !important; text-decoration:none !important; }
  @media (max-width:600px) {
    .card-pad { padding:32px 24px !important; }
    .otp { font-size:32px !important; letter-spacing:8px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background-color:${COLORS.cream};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;font-size:1px;line-height:1px;color:${COLORS.cream};">${escapeHtml(preheader)}&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;&#8199;&#65279;&#847;</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${COLORS.cream}" style="background-color:${COLORS.cream};">
  <tr>
    <td align="center" style="padding:32px 16px;">
      <!--[if mso]><table role="presentation" width="560" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:560px;">
        <tr>
          <td align="center" bgcolor="${COLORS.green}" style="background-color:${COLORS.green};background-image:linear-gradient(160deg,#1A7A42 0%,${COLORS.green} 55%,#00451E 100%);border-radius:16px 16px 0 0;padding:32px 24px 28px;">
            <img src="${crestSrc}" width="120" height="98" alt="Sportstures" style="display:block;border:0;outline:none;width:120px;height:auto;">
          </td>
        </tr>
        <tr>
          <td bgcolor="${COLORS.gold}" style="background-color:${COLORS.gold};height:4px;line-height:4px;font-size:0;">&nbsp;</td>
        </tr>
        <tr>
          <td class="card-pad" bgcolor="#FFFFFF" style="background-color:#FFFFFF;border:1px solid ${COLORS.border};border-top:0;border-radius:0 0 16px 16px;padding:36px 40px 40px;font-family:${FONT};color:${COLORS.text};">
            ${content}
          </td>
        </tr>
        <tr>
          <td align="center" style="padding:28px 24px 0;font-family:${FONT};">
            <p style="margin:0 0 12px;font-size:11px;font-weight:800;letter-spacing:3px;text-transform:uppercase;color:${COLORS.green};">Khayalemi Dlalo</p>
            <p style="margin:0 0 8px;font-size:13px;line-height:20px;color:${COLORS.textSecondary};">
              Questions? Reply to this email or contact <a href="mailto:${support}" style="${link}">${support}</a>.
            </p>
            <p style="margin:0 0 8px;font-size:12px;line-height:18px;color:${COLORS.textMuted};">
              Privacy requests: <a href="mailto:${privacy}" style="${link}">${privacy}</a>
            </p>
            <p style="margin:0;font-size:12px;line-height:18px;color:${COLORS.textMuted};">&copy; ${year} Sportstures. South Africa.</p>
          </td>
        </tr>
      </table>
      <!--[if mso]></td></tr></table><![endif]-->
    </td>
  </tr>
</table>
</body>
</html>`;
}

// Plain-text footer that matches the HTML one.
function textFooter() {
  return `\n\n--\nSportstures · Khayalemi Dlalo\nQuestions? Reply to this email or contact ${contactEmail('support')}.`;
}

module.exports = { COLORS, FONT, crestAttachment, escapeHtml, renderLayout, textFooter };

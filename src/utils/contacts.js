// Public Sportstures addresses, one per purpose. Override any of them in .env.
const DEFAULTS = {
  support: 'support@sportstures.co.za',
  info: 'info@sportstures.co.za',
  hello: 'hello@sportstures.co.za',
  partnerships: 'partnerships@sportstures.co.za',
  privacy: 'privacy@sportstures.co.za',
  security: 'security@sportstures.co.za',
  billing: 'billing@sportstures.co.za',
};

function contactEmail(purpose) {
  if (!(purpose in DEFAULTS)) throw new Error(`Unknown contact purpose: ${purpose}`);
  return process.env[`CONTACT_EMAIL_${purpose.toUpperCase()}`] || DEFAULTS[purpose];
}

// What the website and app show: the address and when to use it.
function publicContacts() {
  return {
    support: { email: contactEmail('support'), use: 'Help with your account or the app' },
    info: { email: contactEmail('info'), use: 'General enquiries' },
    hello: { email: contactEmail('hello'), use: 'Say hello or get in touch' },
    partnerships: { email: contactEmail('partnerships'), use: 'Schools and businesses' },
    privacy: { email: contactEmail('privacy'), use: 'Privacy and personal information requests' },
    security: { email: contactEmail('security'), use: 'Report a security issue' },
    billing: { email: contactEmail('billing'), use: 'Billing questions' },
  };
}

module.exports = { contactEmail, publicContacts };

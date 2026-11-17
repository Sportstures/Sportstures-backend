// How many proxies sit in front of the app, for Express's "trust proxy" setting. Behind a proxy, req.ip is
// otherwise the proxy's address, so the rate limits would count every visitor as one.
//
// TRUST_PROXY wins when set: a number of hops (1 on Render), or any value Express accepts, such as
// "loopback". On Render (which sets RENDER=true on every service) it defaults to 1, so a service created by
// hand in the dashboard, without render.yaml's TRUST_PROXY, still works. Otherwise proxies are not trusted.
function trustProxySetting(env = process.env) {
  const value = env.TRUST_PROXY;
  if (value !== undefined && value !== '') {
    const hops = Number(value);
    return Number.isInteger(hops) ? hops : value;
  }
  if (env.RENDER === 'true') return 1;
  return undefined;
}

module.exports = { trustProxySetting };

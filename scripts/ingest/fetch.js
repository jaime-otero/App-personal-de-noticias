const USER_AGENT = 'Mozilla/5.0 (compatible; MiDiarioBot/0.1; lector RSS personal)';

// Only a plain 200 counts: res.ok also lets through 2xx like the empty 202 some CDNs send when their
// anti-bot layer wants a challenge solved, and that used to pass as a feed with 0 items.
export async function fetchText(url, fetchImpl = fetch) {
  const res = await fetchImpl(url, {
    headers: { 'user-agent': USER_AGENT, accept: 'application/rss+xml, application/atom+xml, application/xml, text/xml, */*' },
    redirect: 'follow',
    signal: AbortSignal.timeout(20_000),
  });
  if (res.status !== 200) {
    const waf = res.headers.get('x-amzn-waf-action');
    throw new Error(`HTTP ${res.status}${waf ? ` (WAF: ${waf})` : ''}`);
  }
  return res.text();
}

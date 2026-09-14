/* global window, document, location, URLSearchParams */
const params = new URLSearchParams(location.search);
const contentOrigin = params.get('game');
const frame = document.getElementById('game');
const log = document.getElementById('log');
const returnUrl = location.origin + location.pathname;
const hello = {
  type: 'crowdyjs:host-hello',
  version: 1,
  returnUrl,
  authorizeOrigin: 'https://studio.example.test',
  slug: 'fixture-game',
};
const sayHello = () => frame.contentWindow?.postMessage(hello, contentOrigin);
frame.addEventListener('load', sayHello);
window.addEventListener('message', (event) => {
  if (event.origin !== contentOrigin || event.source !== frame.contentWindow) return;
  const d = event.data;
  if (d && d.type === 'crowdyjs:host-hello-request') sayHello();
  if (d && d.type === 'crowdyjs:navigate') {
    window.__navigateRequests = (window.__navigateRequests ?? []).concat([d.url]);
    log.textContent += `navigate ${d.url}\n`;
  }
});
const src = new URL(params.get('path') ?? '/', contentOrigin);
for (const [k, v] of params) if (k !== 'game' && k !== 'path') src.searchParams.set(k, v);
frame.src = src.toString();

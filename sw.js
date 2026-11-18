/* Bancada — abre sem internet (v18, 18/11/2026: toque no alerta abre o aplicativo na pendência).
   Página e cadastro da empresa: busca na internet primeiro (versão nova chega na hora); sem internet, usa a cópia guardada.
   Programas do Firebase e bibliotecas (endereços com versão fixa): cópia guardada primeiro.
   Conferência de versão (?vchk, ?_v) e tudo do Firebase/Google (dados, login, IA, ponte) passam direto, sem cópia. */
const CACHE = 'bancada-casca-v1';
const TEMPO = 4000;
self.addEventListener('install', e => { self.skipWaiting(); });
self.addEventListener('activate', e => { e.waitUntil(self.clients.claim()); });
const semBusca = u => { const x = new URL(u); x.search = ''; return x.toString(); };
async function redePrimeiro(req) {
  const c = await caches.open(CACHE), chave = semBusca(req.url);
  const rede = fetch(req).then(r => { if (r && r.ok) c.put(chave, r.clone()); return r; });
  try { return await Promise.race([rede, new Promise((_, no) => setTimeout(() => no(new Error('lento')), TEMPO))]); }
  catch (e) { const g = await c.match(chave); if (g) return g; return rede; } /* b389: sem cópia guardada, espera a internet lenta em vez de falhar em 4 s */
}
async function guardadoPrimeiro(req) {
  const c = await caches.open(CACHE), g = await c.match(req.url); if (g) return g;
  const r = await fetch(req); if (r && (r.ok || r.type === 'opaque')) c.put(req.url, r.clone()); return r;
}
self.addEventListener('fetch', e => {
  const req = e.request; if (req.method !== 'GET') return;
  const u = new URL(req.url);
  if (/[?&](vchk|_v)=/.test(u.search)) return;
  if (u.origin === self.location.origin) {
    if (req.mode === 'navigate' || /\/(index\.html)?$/.test(u.pathname) || /\/empresas\/[^/]+\.(json|webmanifest)$/.test(u.pathname) || /manifest\.webmanifest$/.test(u.pathname) || /\/icones\//.test(u.pathname)) { e.respondWith(redePrimeiro(req)); return; }
    return;
  }
  if (/^https:\/\/www\.gstatic\.com\/firebasejs\/\d/.test(req.url) || /^https:\/\/(cdnjs\.cloudflare\.com|cdn\.jsdelivr\.net|unpkg\.com)\/.*\d+\.\d+/.test(req.url) || /^https:\/\/fonts\.(googleapis|gstatic)\.com\//.test(req.url)) { e.respondWith(guardadoPrimeiro(req)); return; }
});

/* v18: alerta do aplicativo (pendência nova) — tocar abre o aplicativo já aberto (ou abre de novo) e vai direto para a pendência */
self.addEventListener('notificationclick', e => {
  e.notification.close(); const k = (e.notification.data || {}).k || '';
  e.waitUntil((async () => {
    const L = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const c = L.find(x => x.url.startsWith(self.registration.scope)) || L[0];
    if (c) { try { await c.focus(); } catch (er) { } c.postMessage({ tipo: 'bancada-notif', k }); return; }
    await self.clients.openWindow(self.registration.scope);
  })());
});

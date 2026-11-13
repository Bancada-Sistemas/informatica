/* Bancada — PONTE DE BUSCA (pesquisa de produtos SEM IA) — versão 1.0
   Cloudflare Worker. Rotas:
     POST /busca  { q }            → pesquisa na web (DuckDuckGo, sem chave; ou Brave, se houver BRAVE_KEY),
                                     abre as primeiras páginas de lojas/fabricantes e lê os dados do produto
                                     (nome, marca, modelo, código de barras, fotos e preços) direto das páginas.
     POST /lens   { imagem }       → (opcional) Google Cloud Vision "Web Detection" — o Lens automático.
                                     Só funciona com a variável VISION_KEY (1.000 consultas grátis por mês no Google Cloud).
   Segurança: o aplicativo manda o cabeçalho X-Chave; ele tem que ser igual à variável CHAVE da ponte.
   Variáveis (Settings → Variables and Secrets): CHAVE (obrigatória), BRAVE_KEY (opcional), VISION_KEY (opcional). */
const VER = '1.0';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Chave' };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const PULA = /(google\.|youtube\.|facebook\.|instagram\.|twitter\.|x\.com|tiktok\.|wikipedia\.|reddit\.|pinterest\.|duckduckgo\.)/i;

async function pegar(url, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9' }, signal: ac.signal, redirect: 'follow' }); if (!r.ok) return ''; const tp = r.headers.get('content-type') || ''; if (!/html|json|text/.test(tp)) return ''; const tx = await r.text(); return tx.slice(0, 900000); }
  catch { return ''; } finally { clearTimeout(t); }
}
const desHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

async function buscarLinks(q, env) {
  if (env.BRAVE_KEY) {
    try { const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=10&country=BR&search_lang=pt-br&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json', 'X-Subscription-Token': env.BRAVE_KEY } });
      if (r.ok) { const j = await r.json(); const L = ((j.web || {}).results || []).map(x => ({ url: x.url, titulo: desHtml(x.title), resumo: desHtml(x.description) })); if (L.length) return { fonte: 'brave', L }; } } catch { }
  }
  const h = await pegar('https://html.duckduckgo.com/html/?kl=br-pt&q=' + encodeURIComponent(q), 9000);
  const L = []; const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g; let m;
  while ((m = re.exec(h)) && L.length < 10) { let u = m[1]; const k = /[?&]uddg=([^&]+)/.exec(u); if (k) u = decodeURIComponent(k[1]); if (u.startsWith('//')) u = 'https:' + u; if (!/^https?:\/\//.test(u)) continue; L.push({ url: u, titulo: desHtml(m[2]), resumo: desHtml(m[3] || '') }); }
  return { fonte: 'duckduckgo', L };
}
function produtoDaPagina(html, url) {
  const out = { url }; let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { }
  out.loja = host;
  const blocos = [...html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
  const achar = o => { if (!o || typeof o !== 'object') return null; if (Array.isArray(o)) { for (const x of o) { const r = achar(x); if (r) return r; } return null; } const t = [].concat(o['@type'] || []).join(' '); if (/Product/i.test(t)) return o; if (o['@graph']) return achar(o['@graph']); return null; };
  for (const b of blocos) { try { const p = achar(JSON.parse(b.trim())); if (!p) continue;
      out.nome = out.nome || desHtml(p.name); out.marca = out.marca || desHtml(typeof p.brand === 'object' ? (p.brand && p.brand.name) : p.brand); out.modelo = out.modelo || desHtml(p.model && (p.model.name || p.model)) || desHtml(p.mpn);
      out.ean = out.ean || String(p.gtin13 || p.gtin || p.gtin14 || p.gtin12 || p.gtin8 || '').replace(/\D/g, ''); out.descricao = out.descricao || desHtml(p.description).slice(0, 600);
      const im = [].concat(p.image || []).map(x => typeof x === 'object' ? x.url || x.contentUrl : x).filter(x => /^https:\/\//.test(x || '')); out.imagens = [...(out.imagens || []), ...im].slice(0, 6);
      const of = [].concat(p.offers || []).flatMap(x => x && x['@type'] === 'AggregateOffer' ? [{ price: x.lowPrice }, ...[].concat(x.offers || [])] : [x]); for (const o of of) { const v = parseFloat(String((o && (o.price || o.lowPrice)) || '').replace(',', '.')); if (v > 0.5 && v < 1e6 && !out.preco) out.preco = v; }
    } catch { } }
  const meta = n => { const m = new RegExp('<meta[^>]+(?:property|name)=["\']' + n + '["\'][^>]+content=["\']([^"\']+)', 'i').exec(html) || new RegExp('<meta[^>]+content=["\']([^"\']+)["\'][^>]+(?:property|name)=["\']' + n + '["\']', 'i').exec(html); return m ? desHtml(m[1]) : ''; };
  if (!out.nome) out.nome = meta('og:title') || desHtml((/<title[^>]*>([\s\S]*?)<\/title>/i.exec(html) || [])[1] || '');
  if (!out.preco) { const v = parseFloat((meta('product:price:amount') || meta('og:price:amount')).replace(',', '.')); if (v > 0.5) out.preco = v; }
  const oi = meta('og:image'); if (/^https:\/\//.test(oi)) out.imagens = [...(out.imagens || []), oi].slice(0, 6);
  if (!out.ean) { const m = /\b(?:EAN|GTIN|C[óo]digo de barras)\D{0,20}(\d{12,14})\b/i.exec(desHtml(html).slice(0, 200000)); if (m) out.ean = m[1]; }
  return out;
}
async function pesquisar(q, env, extraPags = []) {
  const { fonte, L } = await buscarLinks(q, env);
  const urls = [...extraPags, ...L.map(x => x.url)].filter((u, i, a) => u && !PULA.test(u) && a.indexOf(u) === i).slice(0, 5);
  const pags = await Promise.all(urls.map(async u => { const h = await pegar(u); return h ? produtoDaPagina(h, u) : null; }));
  const P = pags.filter(x => x && x.nome);
  const best = P.find(x => x.ean || x.marca) || P[0] || null;
  const precos = P.filter(x => x.preco).map(x => ({ loja: x.loja, preco: x.preco, url: x.url }));
  const imagens = [...new Set(P.flatMap(x => x.imagens || []))].slice(0, 8);
  return { ok: true, ver: VER, fonte, q, produto: best ? { nome: best.nome, marca: best.marca || '', modelo: best.modelo || '', codigo_barras: best.ean || '', caracteristicas: best.descricao || '', fonte_url: best.url } : null, precos, imagens, paginas: P.map(x => ({ url: x.url, loja: x.loja, nome: x.nome })), resultados: L.slice(0, 8) };
}
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '/versao') return json({ ok: true, ponte: 'bancada-busca', ver: VER, brave: !!env.BRAVE_KEY, lens: !!env.VISION_KEY });
    if (!env.CHAVE || req.headers.get('X-Chave') !== env.CHAVE) return json({ ok: false, erro: 'chave' }, 401);
    let b = {}; try { b = await req.json(); } catch { }
    if (u.pathname === '/busca') { const q = String(b.q || '').trim().slice(0, 200); if (q.length < 3) return json({ ok: false, erro: 'q' }, 400); return json(await pesquisar(q, env)); }
    if (u.pathname === '/lens') {
      if (!env.VISION_KEY) return json({ ok: false, erro: 'sem_vision' }, 404);
      const img = String(b.imagem || '').replace(/^data:[^,]+,/, ''); if (img.length < 100) return json({ ok: false, erro: 'imagem' }, 400);
      const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + env.VISION_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ image: { content: img }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }], imageContext: { webDetectionParams: { includeGeoResults: true } } }] }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) return json({ ok: false, erro: 'vision', status: r.status, msg: (j.error || {}).message || '' }, 502);
      const w = ((j.responses || [])[0] || {}).webDetection || {}; const rot = ((w.bestGuessLabels || [])[0] || {}).label || ((w.webEntities || [])[0] || {}).description || '';
      const pags = (w.pagesWithMatchingImages || []).map(x => x.url).filter(Boolean).slice(0, 4);
      const res = rot ? await pesquisar(rot, env, pags) : { ok: true, produto: null, precos: [], imagens: [] };
      return json({ ...res, lens: { rotulo: rot, entidades: (w.webEntities || []).map(x => x.description).filter(Boolean).slice(0, 6) } });
    }
    return json({ ok: false, erro: 'rota' }, 404);
  }
};

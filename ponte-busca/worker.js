/* Bancada — PONTE DE BUSCA (pesquisa de produtos SEM IA) — versão 1.4
   Cloudflare Worker. Rotas:
     POST /busca  { q }            → pesquisa na web (Brave, se houver BRAVE_KEY; Firecrawl, se houver FIRECRAWL_KEY; depois DuckDuckGo, DuckDuckGo Lite, Bing e Mojeek,
                                     um depois do outro até achar resultados) e devolve o diagnóstico de cada fonte (diag),
                                     abre as primeiras páginas de lojas/fabricantes e lê os dados do produto
                                     (nome, marca, modelo, código de barras, fotos e preços) direto das páginas.
     POST /nfce   { url }          → (v1.4) abre a consulta da NFC-e na SEFAZ (o link do QR code) e devolve emitente, CNPJ e os itens
                                     (descrição, código, quantidade, unidade, valor unitário e total). Se a página tiver outro formato,
                                     devolve o texto da página para o aplicativo ler. Só aceita endereços .gov.br (SEFAZ).
     POST /cnpj   { cnpj }         → (v1.4) dados públicos da empresa pelo CNPJ (BrasilAPI; se falhar, CNPJ.ws): razão social, fantasia, endereço, telefone.
     POST /creditos {}             → (v1.3) créditos do Firecrawl: restantes, do plano e o período do mês.
     POST /lens   { imagem }       → (opcional) Google Cloud Vision "Web Detection" — o Lens automático.
                                     Só funciona com a variável VISION_KEY (1.000 consultas grátis por mês no Google Cloud).
   Segurança: o aplicativo manda o cabeçalho X-Chave; ele tem que ser igual à variável CHAVE da ponte.
   Variáveis (Settings → Variables and Secrets): CHAVE (obrigatória), FIRECRAWL_KEY (opcional, recomendada: firecrawl.dev, plano grátis sem cartão),
   BRAVE_KEY (opcional, pago), VISION_KEY (opcional). */
const VER = '1.4';
const UA = 'Mozilla/5.0 (Linux; Android 13; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Mobile Safari/537.36';
const CORS = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-Chave' };
const json = (o, st = 200) => new Response(JSON.stringify(o), { status: st, headers: { ...CORS, 'Content-Type': 'application/json; charset=utf-8' } });
const PULA = /(google\.|youtube\.|facebook\.|instagram\.|twitter\.|x\.com|tiktok\.|wikipedia\.|reddit\.|pinterest\.|duckduckgo\.)/i;

/* v1.1: devolve também a situação (código HTTP, tempo esgotado ou erro) para o diagnóstico */
async function pegarSt(url, ms = 8000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'pt-BR,pt;q=0.9' }, signal: ac.signal, redirect: 'follow' }); const tp = r.headers.get('content-type') || ''; const tx = /html|json|text/.test(tp) ? (await r.text()).slice(0, 900000) : ''; return { st: r.status, ok: r.ok, tx }; }
  catch (e) { return { st: e && e.name === 'AbortError' ? 'tempo' : 'erro', ok: false, tx: '' }; } finally { clearTimeout(t); }
}
async function pegar(url, ms = 8000) { const r = await pegarSt(url, ms); return r.ok ? r.tx : ''; }
const desHtml = s => String(s || '').replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();

/* v1.1: várias fontes gratuitas, uma depois da outra; cada uma deixa o seu diagnóstico (resultados, bloqueio, código HTTP) */
const BLOQ = /anomaly|captcha|unusual traffic|are you a robot|verify you are human|access denied|challenge-platform|cf-chl/i;
const limpaUrl = u => { u = String(u || '').replace(/&amp;/g, '&'); const k = /[?&]uddg=([^&]+)/.exec(u); if (k) u = decodeURIComponent(k[1]); const b = /bing\.com\/ck\/a\?[^"]*?[?&]u=a1([^&]+)/.exec(u); if (b) { try { u = atob(b[1].replace(/-/g, '+').replace(/_/g, '/')); } catch { } } if (u.startsWith('//')) u = 'https:' + u; return u; };
const FONTES = [
  { nome: 'duckduckgo', url: q => 'https://html.duckduckgo.com/html/?kl=br-pt&q=' + encodeURIComponent(q), re: /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g },
  { nome: 'duckduckgo-lite', url: q => 'https://lite.duckduckgo.com/lite/?kl=br-pt&q=' + encodeURIComponent(q), re: /<a[^>]+href="([^"]+)"[^>]+class=['"]result-link['"][^>]*>([\s\S]*?)<\/a>|<a[^>]+class=['"]result-link['"][^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g },
  { nome: 'bing', url: q => 'https://www.bing.com/search?setlang=pt-br&cc=BR&q=' + encodeURIComponent(q), re: /<li class="b_algo"[\s\S]*?<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g },
  { nome: 'mojeek', url: q => 'https://www.mojeek.com/search?lb=pt&arc=br&q=' + encodeURIComponent(q), re: /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g }
];
async function buscarLinks(q, env, diag) {
  const L = [], usou = [], junta = (url, titulo, resumo = '') => { url = limpaUrl(url); if (!/^https?:\/\//.test(url) || PULA.test(url) || /bing\.com|mojeek\.com|duckduckgo\.com/.test(url) || L.some(x => x.url === url)) return; L.push({ url, titulo: desHtml(titulo), resumo: desHtml(resumo) }); };
  if (env.BRAVE_KEY) {
    try { const r = await fetch('https://api.search.brave.com/res/v1/web/search?count=10&country=BR&search_lang=pt-br&q=' + encodeURIComponent(q), { headers: { 'Accept': 'application/json', 'X-Subscription-Token': env.BRAVE_KEY } });
      let n = 0; if (r.ok) { const j = await r.json(); ((j.web || {}).results || []).forEach(x => { junta(x.url, x.title, x.description); n++; }); }
      diag.fontes.push({ fonte: 'brave', status: r.status, resultados: n, bloqueou: r.status === 401 || r.status === 403 || r.status === 429 }); if (n) usou.push('brave'); } catch { diag.fontes.push({ fonte: 'brave', status: 'erro', resultados: 0, bloqueou: false }); }
  }
  /* v1.2: Firecrawl — serviço de pesquisa feito para servidores (não bloqueia a nuvem). 2 créditos a cada 10 resultados. */
  if (env.FIRECRAWL_KEY && L.length < 5) {
    try { const r = await fetch('https://api.firecrawl.dev/v2/search', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.FIRECRAWL_KEY }, body: JSON.stringify({ query: q, limit: 8, country: 'BR', location: 'Brazil', timeout: 20000 }) });
      const j = await r.json().catch(() => ({})); let n = 0; const web = (j.data && (j.data.web || (Array.isArray(j.data) ? j.data : []))) || []; web.forEach(x => { const a = L.length; junta(x.url, x.title, x.description); if (L.length > a) n++; });
      diag.fontes.push({ fonte: 'firecrawl', status: r.status, resultados: n, bloqueou: r.status === 401 || r.status === 402 || r.status === 403 || r.status === 429, creditos: j.creditsUsed || 0, msg: r.ok ? '' : String(j.error || '').slice(0, 160) }); if (n) usou.push('firecrawl'); }
    catch { diag.fontes.push({ fonte: 'firecrawl', status: 'erro', resultados: 0, bloqueou: false }); }
  }
  for (const F of FONTES) {
    if (L.length >= 5 || usou.includes('firecrawl')) break; /* com o Firecrawl respondendo, não perde tempo nas fontes que bloqueiam */
    const r = await pegarSt(F.url(q), 9000); let n = 0, m; F.re.lastIndex = 0;
    while ((m = F.re.exec(r.tx)) && n < 10) { const u = m[1] || m[3], t = m[2] || m[4] || ''; const antes = L.length; junta(u, t); if (L.length > antes) n++; }
    const bloqueou = !n && (r.st === 202 || r.st === 403 || r.st === 429 || BLOQ.test(r.tx.slice(0, 20000)));
    diag.fontes.push({ fonte: F.nome, status: r.st, resultados: n, bloqueou });
    if (n) usou.push(F.nome);
  }
  return { fonte: usou.join('+') || 'nenhuma', L: L.slice(0, 10) };
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
/* v1.3: créditos do Firecrawl (consultar não gasta crédito) */
async function creditosFc(env) {
  if (!env.FIRECRAWL_KEY) return null;
  try { const r = await fetch('https://api.firecrawl.dev/v2/team/credit-usage', { headers: { 'Authorization': 'Bearer ' + env.FIRECRAWL_KEY } }); const j = await r.json().catch(() => ({})); const d = j.data || {};
    if (!r.ok || d.remainingCredits == null) return { ok: false, status: r.status };
    return { ok: true, restantes: d.remainingCredits, plano: d.planCredits || 0, inicio: d.billingPeriodStart || '', fim: d.billingPeriodEnd || '', em: Date.now() }; }
  catch { return { ok: false, status: 'erro' }; }
}
async function pesquisar(q, env, extraPags = []) {
  const diag = { fontes: [], paginas_tentadas: 0, paginas_lidas: 0, paginas_com_produto: 0, lojas_recusaram: [] };
  const { fonte, L } = await buscarLinks(q, env, diag); const usou = fonte.split('+');
  const urls = [...extraPags, ...L.map(x => x.url)].filter((u, i, a) => u && !PULA.test(u) && a.indexOf(u) === i).slice(0, 6);
  diag.paginas_tentadas = urls.length;
  const pags = await Promise.all(urls.map(async u => { const r = await pegarSt(u); if (!r.ok || !r.tx) { try { diag.lojas_recusaram.push(new URL(u).hostname.replace(/^www\./, '') + ' (' + r.st + ')'); } catch { } return null; } diag.paginas_lidas++; return produtoDaPagina(r.tx, u); }));
  /* v1.2: loja que recusou abrir a página para a ponte → o Firecrawl abre por ela (até 2 páginas, 1 crédito cada) */
  if (env.FIRECRAWL_KEY && !pags.some(x => x && x.nome)) {
    const rec = urls.filter((u, i) => !pags.at(i)).slice(0, 2); diag.firecrawl_paginas = 0;
    for (const u of rec) { try { const r = await fetch('https://api.firecrawl.dev/v2/scrape', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + env.FIRECRAWL_KEY }, body: JSON.stringify({ url: u, formats: ['rawHtml'], onlyMainContent: false, timeout: 20000 }) });
        const j = await r.json().catch(() => ({})); const h = j.data && (j.data.rawHtml || j.data.html); if (r.ok && h) { const pr = produtoDaPagina(h, u); pags.push(pr); diag.paginas_lidas++; diag.firecrawl_paginas++; } } catch { } }
  }
  const P = pags.filter(x => x && x.nome); diag.paginas_com_produto = P.length;
  const best = P.find(x => x.ean || x.marca) || P[0] || null;
  const precos = P.filter(x => x.preco).map(x => ({ loja: x.loja, preco: x.preco, url: x.url }));
  const imagens = [...new Set(P.flatMap(x => x.imagens || []))].slice(0, 8);
  const creditos = usou.includes('firecrawl') || diag.firecrawl_paginas ? await creditosFc(env) : null;
  return { ok: true, ver: VER, fonte, q, diag, creditos, produto: best ? { nome: best.nome, marca: best.marca || '', modelo: best.modelo || '', codigo_barras: best.ean || '', caracteristicas: best.descricao || '', fonte_url: best.url } : null, precos, imagens, paginas: P.map(x => ({ url: x.url, loja: x.loja, nome: x.nome })), resultados: L.slice(0, 8) };
}
/* v1.4: NFC-e pelo QR code — a página de consulta da SEFAZ (layout nacional: tabResult / txtTit / Rqtd / RUN / RvlUnit / valor) */
const numBR = s => { s = String(s || '').replace(/[^\d,.-]/g, ''); if (s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); const n = parseFloat(s); return isFinite(n) ? n : 0; };
function nfceItens(h) {
  const it = []; const linhas = h.split(/<tr[^>]*id=["']?Item/i).slice(1);
  const blocos = linhas.length ? linhas : h.split(/<span[^>]+class=["']txtTit2?["']/i).slice(1).map(x => '<span class="txtTit">' + x);
  for (const b0 of blocos) { const b = b0.split(/<\/tr>/i)[0] || b0;
    const g = re => { const m = re.exec(b); return m ? desHtml(m[1]) : ''; };
    const descricao = g(/class=["']txtTit2?["'][^>]*>([\s\S]*?)<\/span>/i); if (!descricao) continue;
    const codigo = (g(/class=["']RCod["'][^>]*>([\s\S]*?)<\/span>/i).match(/[\w.-]+(?=\s*\)?\s*$)/) || [''])[0];
    const qtd = numBR(g(/class=["']Rqtd["'][^>]*>([\s\S]*?)<\/span>/i).replace(/qtde\.?:?/i, ''));
    const un = g(/class=["']RUN["'][^>]*>([\s\S]*?)<\/span>/i).replace(/UN:?/i, '').trim();
    const vu = numBR(g(/class=["']RvlUnit["'][^>]*>([\s\S]*?)<\/span>/i).replace(/vl\.?\s*unit\.?:?/i, ''));
    const vt = numBR(g(/class=["']valor["'][^>]*>([\s\S]*?)<\/span>/i));
    it.push({ descricao, codigo, ean: '', qtd: qtd || 1, unidade: un, valor_unit: vu || (vt && qtd ? vt / qtd : 0), valor_total: vt || vu * (qtd || 1) }); }
  return it;
}
async function nfce(url) {
  let u; try { u = new URL(String(url || '')); } catch { return { ok: false, erro: 'url' }; }
  if (!/^https?:$/.test(u.protocol) || !/(^|\.)gov\.br$/i.test(u.hostname)) return { ok: false, erro: 'url_nao_sefaz' };
  const r = await pegarSt(u.href, 15000); if (!r.ok || !r.tx) return { ok: false, erro: 'sefaz', st: r.st };
  if (/captcha|recaptcha|hcaptcha/i.test(r.tx) && !/txtTit/i.test(r.tx)) return { ok: false, erro: 'captcha' };
  const h = r.tx, itens = nfceItens(h);
  const emitente = desHtml((/id=["']u20["'][^>]*>([\s\S]*?)<\/div>/i.exec(h) || /class=["']txtTopo["'][^>]*>([\s\S]*?)<\/div>/i.exec(h) || [])[1] || '');
  const cnpj = ((/CNPJ:?\s*([\d./-]{14,18})/i.exec(desHtml(h)) || [])[1] || '').replace(/\D/g, '');
  const total = numBR((/Valor\s+a\s+pagar\s*R\$:?[\s\S]{0,80}?class=["']totalNumb[^"']*["'][^>]*>([\d.,]+)/i.exec(h) || [])[1]);
  const texto = itens.length ? '' : desHtml(h.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ')).slice(0, 12000);
  return { ok: true, ver: VER, emitente, cnpj, total, itens, texto };
}
async function cnpjDados(cnpj) {
  cnpj = String(cnpj || '').replace(/\D/g, ''); if (cnpj.length !== 14) return { ok: false, erro: 'cnpj' };
  const a = await pegarSt('https://brasilapi.com.br/api/cnpj/v1/' + cnpj, 10000);
  if (a.ok) { try { const d = JSON.parse(a.tx); return { ok: true, fonte: 'brasilapi', nome: d.razao_social || '', fantasia: d.nome_fantasia || '', cep: String(d.cep || ''), logradouro: [d.descricao_tipo_de_logradouro, d.logradouro].filter(Boolean).join(' '), numero: d.numero || '', complemento: d.complemento || '', bairro: d.bairro || '', cidade: d.municipio || '', uf: d.uf || '', tel: String(d.ddd_telefone_1 || '').replace(/\D/g, ''), email: d.email || '' }; } catch { } }
  const b = await pegarSt('https://publica.cnpj.ws/cnpj/' + cnpj, 10000);
  if (b.ok) { try { const d = JSON.parse(b.tx), e = d.estabelecimento || {}; return { ok: true, fonte: 'cnpj.ws', nome: d.razao_social || '', fantasia: e.nome_fantasia || '', cep: String(e.cep || ''), logradouro: [e.tipo_logradouro, e.logradouro].filter(Boolean).join(' '), numero: e.numero || '', complemento: e.complemento || '', bairro: e.bairro || '', cidade: (e.cidade || {}).nome || '', uf: (e.estado || {}).sigla || '', tel: String((e.ddd1 || '') + (e.telefone1 || '')).replace(/\D/g, ''), email: e.email || '' }; } catch { } }
  return { ok: false, erro: 'cnpj_fonte', st: [a.st, b.st] };
}
export default {
  async fetch(req, env) {
    if (req.method === 'OPTIONS') return new Response(null, { headers: CORS });
    const u = new URL(req.url);
    if (u.pathname === '/' || u.pathname === '/versao') return json({ ok: true, ponte: 'bancada-busca', ver: VER, brave: !!env.BRAVE_KEY, lens: !!env.VISION_KEY, firecrawl: !!env.FIRECRAWL_KEY, fontes: [...(env.BRAVE_KEY ? ['brave'] : []), ...(env.FIRECRAWL_KEY ? ['firecrawl'] : []), ...FONTES.map(f => f.nome)] });
    if (!env.CHAVE || req.headers.get('X-Chave') !== env.CHAVE) return json({ ok: false, erro: 'chave' }, 401);
    let b = {}; try { b = await req.json(); } catch { }
    if (u.pathname === '/busca') { const q = String(b.q || '').trim().slice(0, 200); if (q.length < 3) return json({ ok: false, erro: 'q' }, 400); return json(await pesquisar(q, env)); }
    if (u.pathname === '/nfce') return json(await nfce(b.url));
    if (u.pathname === '/cnpj') return json(await cnpjDados(b.cnpj));
    if (u.pathname === '/creditos') return json({ ok: true, ver: VER, firecrawl: !!env.FIRECRAWL_KEY, creditos: await creditosFc(env) });
    if (u.pathname === '/lens') {
      if (!env.VISION_KEY) return json({ ok: false, erro: 'sem_vision' }, 404);
      const img = String(b.imagem || '').replace(/^data:[^,]+,/, ''); if (img.length < 100) return json({ ok: false, erro: 'imagem' }, 400);
      const r = await fetch('https://vision.googleapis.com/v1/images:annotate?key=' + env.VISION_KEY, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requests: [{ image: { content: img }, features: [{ type: 'WEB_DETECTION', maxResults: 10 }], imageContext: { webDetectionParams: { includeGeoResults: true } } }] }) });
      const j = await r.json().catch(() => ({})); if (!r.ok) return json({ ok: false, erro: 'vision', status: r.status, msg: (j.error || {}).message || '' }, 502);
      const w = ((j.responses || [])[0] || {}).webDetection || {}; const rot = ((w.bestGuessLabels || [])[0] || {}).label || ((w.webEntities || [])[0] || {}).description || '';
      const pags = (w.pagesWithMatchingImages || []).map(x => x.url).filter(Boolean).slice(0, 4);
      const res = rot ? await pesquisar(rot, env, pags) : { ok: true, ver: VER, produto: null, precos: [], imagens: [] };
      return json({ ...res, lens: { rotulo: rot, entidades: (w.webEntities || []).map(x => x.description).filter(Boolean).slice(0, 6) } });
    }
    return json({ ok: false, erro: 'rota' }, 404);
  }
};

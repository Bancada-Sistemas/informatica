// Ponte única da Bancada Sistemas (IA, senha mestre e agenda Google das empresas).
// Atende todos os sistemas e todas as empresas: cada empresa tem a sua chave
// guardada como segredo KEY_<CODIGO> (ex.: KEY_RKINFORMATICA).
// A senha mestre do desenvolvedor fica no segredo MESTRE (vale para todas as empresas).
// Agenda Google: segredos GOOGLE_ID e GOOGLE_SECRET (cliente OAuth do Google Cloud da Bancada)
// e o armazenamento KV ligado com o nome AGENDA (guarda, embaralhada, a autorização de cada empresa).
// Documentos por link (27/10/2026): o mesmo KV AGENDA guarda os PDFs enviados pelo WhatsApp por 90 dias,
// com código aleatório no link (só quem recebe o link abre).
// Boleto bancário (30/10/2026, v6): as chaves de cada banco/serviço ficam guardadas embaralhadas no KV AGENDA
// (segredo BANCO_SEGREDO; se não existir, usa MESTRE). Só usuários logados da empresa usam; o aplicativo nunca recebe as chaves de volta.
// Prontos para usar: Asaas e Mercado Pago (só a chave). Bancos que exigem certificado digital (BB, Itaú, Bradesco, Santander,
// Caixa, Inter, Sicoob, Sicredi, Efí) ficam cadastrados e são ativados quando o certificado for instalado nesta ponte.
// Modelo da IA (03/11/2026, v7): usa a variável MODELO (se não existir, "gemini-flash-latest", que o Google aponta
// sempre para o Flash mais novo). Se o Google responder que o modelo não existe mais ou não está liberado para a chave,
// a ponte pergunta ao Google quais modelos a chave da empresa pode usar, escolhe o Flash mais novo, guarda a escolha
// por 7 dias no KV AGENDA (depois tenta de novo o da variável) e responde normalmente. Ninguém precisa mexer em nada.
// v7.1 (03/11/2026): se o modelo estiver sobrecarregado no Google (erro 503) ou o limite grátis dele acabar (erro 429),
// a ponte tenta na hora outro modelo Flash da mesma chave (cada modelo tem o seu limite) e usa esse por 1 hora.
// v7.2 (03/11/2026): se o limite grátis diário de leituras do Firebase da empresa acabar (erro 429), a ponte não
// bloqueia mais quem já entrou antes: confere a assinatura do login (chaves públicas do Google) e se esse usuário já
// foi aprovado pelo Firebase nos últimos 30 dias (anotado no KV AGENDA). Assim o link do PDF e a agenda continuam funcionando.
const ORIGENS = ['https://bancada-sistemas.github.io'];
const PONTE_VERSAO = '7.8';
/* v7.8 (20/11/2026): pesquisa em segundo plano. O aplicativo manda ?job=<código> (resumo do pedido). Mesmo que o celular feche o
   aplicativo no meio da pesquisa, a ponte termina a pergunta à IA e guarda a resposta por 1 hora no KV AGENDA ('job:EMPRESA:código').
   Ao refazer a mesma pesquisa, o aplicativo pergunta antes em /job/ver e usa a resposta guardada, sem gastar a IA de novo.
   Só guarda resposta que deu certo; não guarda nada além do que a própria IA respondeu. */
/* v7.4 (06/11/2026): três níveis de pesquisa pedidos pelo aplicativo (bancadaNivel): 1 = o Gemini pensa pouco (rápido), 2 = pensa mais,
   3 = pensa o máximo (e o aplicativo também pede a pesquisa no Google). Se o modelo não aceitar o ajuste de “pensar”, repete sem ele. */
/* v7.3 (06/11/2026): a ponte responde sempre em até ~85 s. A Cloudflare corta respostas que passam de 100 s sem a
   autorização do navegador, e o aplicativo achava que estava sem internet. Cada chamada ao Gemini tem prazo de 40 s. */
const IA_PRAZO_TOTAL = 85000, IA_PRAZO_CHAMADA = 40000;
let ENV_ATUAL = null;
/* confere a assinatura do login do Firebase (sem gastar leitura do banco da empresa) */
let JWK_CACHE = null;
const b64uDec = t => Uint8Array.from(atob(t.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((t.length + 3) % 4)), c => c.charCodeAt(0));
async function tokenValido(idToken, pid) {
  try {
    const [h, p, sig] = idToken.split('.'); const H = JSON.parse(new TextDecoder().decode(b64uDec(h))), P = JSON.parse(new TextDecoder().decode(b64uDec(p)));
    const agora = Date.now() / 1000; if (P.aud !== pid || P.iss !== 'https://securetoken.google.com/' + pid || !P.sub || !(P.exp > agora) || !(P.iat < agora + 300)) return null;
    if (!JWK_CACHE || Date.now() - JWK_CACHE.t > 3600e3) { const r = await fetch('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'); JWK_CACHE = { t: Date.now(), k: (await r.json()).keys || [] }; }
    const jwk = JWK_CACHE.k.find(k => k.kid === H.kid); if (!jwk || H.alg !== 'RS256') return null;
    const key = await crypto.subtle.importKey('jwk', jwk, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    return (await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64uDec(sig), new TextEncoder().encode(h + '.' + p))) ? P.sub : null;
  } catch { return null; }
}
const MODELO_PADRAO = 'gemini-flash-latest';
const MODELO_RESERVA = ['gemini-3.8-flash', 'gemini-3.6-flash', 'gemini-3.5-flash-lite', 'gemini-2.5-flash'];
const GEMINI = 'https://generativelanguage.googleapis.com/v1beta/models';
const MODELO_OCUPADO = (st, t) => st === 503 || st === 429 || st === 500 || /UNAVAILABLE|RESOURCE_EXHAUSTED|high demand|overloaded/i.test(st >= 400 ? t : '');
const MODELO_SUMIU = (st, t) => st === 404 || (st === 400 && /not.found|no longer available|is not supported|unknown model|invalid model/i.test(t));
/* modelos Flash que a chave da empresa pode usar, do mais novo para o mais antigo (primeiro os normais, depois os "lite") */
async function modelosDaChave(chave) {
  try {
    const r = await fetch(GEMINI + '?pageSize=1000', { headers: { 'x-goog-api-key': chave } }); if (!r.ok) return [];
    const L = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent')).map(m => String(m.name || '').replace(/^models\//, ''));
    const ver = n => parseFloat((n.match(/^gemini-(\d+(?:\.\d+)?)/) || [])[1] || '0');
    const ord = a => a.sort((x, y) => ver(y) - ver(x));
    return [...ord(L.filter(n => /^gemini-\d+(\.\d+)?-flash$/.test(n))), ...ord(L.filter(n => /^gemini-\d+(\.\d+)?-flash-lite$/.test(n)))];
  } catch { return []; }
}
/* chama o Gemini; se o modelo sumiu, troca sozinho pelo mais novo disponível para a chave */
async function chamarIA(env, empresa, chave, corpo) {
  const principal = String(env.MODELO || MODELO_PADRAO).trim(), kk = 'modelo:' + empresa, kt = 'modelo-tmp:' + empresa;
  let auto = null; try { auto = env.AGENDA ? JSON.parse((await env.AGENDA.get(kk)) || 'null') : null; } catch { }
  if (auto && auto.de !== principal) auto = null; /* a variável MODELO mudou: volta a tentar a escolhida */
  let tmp = null; try { tmp = env.AGENDA ? JSON.parse((await env.AGENDA.get(kt)) || 'null') : null; } catch { }
  if (tmp && tmp.de !== principal) tmp = null; if (tmp) auto = tmp;
  const nivel = Math.max(1, Math.min(3, +corpo.bancadaNivel || 1)); delete corpo.bancadaNivel;
  const ini = Date.now(), resta = () => IA_PRAZO_TOTAL - (Date.now() - ini);
  const tenta = async m => { const ac = new AbortController(), to = setTimeout(() => ac.abort(), Math.max(3000, Math.min(nivel > 1 ? 75000 : IA_PRAZO_CHAMADA, resta() - 3000)));
    try {
      const gc = corpo.generationConfig || {}, rapido = gc.thinkingConfig ? corpo : { ...corpo, generationConfig: { ...gc, thinkingConfig: /gemini-2\.5/.test(m) ? { thinkingBudget: nivel === 1 ? (/pro/.test(m) ? 128 : 0) : nivel === 2 ? 4096 : -1 } : { thinkingLevel: nivel === 1 ? 'low' : 'high' } } };
      const r1 = await fetch(GEMINI + '/' + m + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave }, body: JSON.stringify(rapido), signal: ac.signal });
      if (r1.status !== 400 || rapido === corpo) return r1;
      const t1 = await r1.clone().text(); if (!/thinking/i.test(t1)) return r1;
      return await fetch(GEMINI + '/' + m + ':generateContent', { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': chave }, body: JSON.stringify(corpo), signal: ac.signal });
    }
    catch { return new Response(JSON.stringify({ error: { code: 504, status: 'DEADLINE_EXCEEDED', message: 'O modelo ' + m + ' demorou mais de ' + Math.round(IA_PRAZO_CHAMADA / 1000) + ' s para responder.' } }), { status: 503 }); }
    finally { clearTimeout(to); } };
  let modelo = auto ? auto.nome : principal, r = await tenta(modelo), t = await r.text();
  const sumiu = MODELO_SUMIU(r.status, t), ocupado = !sumiu && MODELO_OCUPADO(r.status, t);
  if (!sumiu && !ocupado) return { r, t, modelo, auto: !!auto };
  const tentados = new Set([modelo]), lista = [...(await modelosDaChave(chave)), ...MODELO_RESERVA];
  for (const m of lista) {
    if (tentados.has(m)) continue; tentados.add(m); if (tentados.size > 5 || resta() < 12000) break;
    const r2 = await tenta(m), t2 = await r2.text();
    if (MODELO_SUMIU(r2.status, t2) || MODELO_OCUPADO(r2.status, t2)) continue;
    if (r2.ok && env.AGENDA) { try { await env.AGENDA.put(sumiu ? kk : kt, JSON.stringify({ nome: m, de: principal, em: Date.now(), motivo: sumiu ? 'desligado' : 'ocupado' }), { expirationTtl: sumiu ? 7 * 24 * 3600 : 3600 }); } catch { } }
    return { r: r2, t: t2, modelo: m, auto: true };
  }
  return { r, t, modelo, auto: false };
}

async function iguais(a, b) {
  const h = async t => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(t))));
  const x = await h(a), y = await h(b);
  let d = 0; for (let i = 0; i < x.length; i++) d |= x[i] ^ y[i];
  return d === 0;
}

const b64u = b => btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const de64u = s => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), c => c.charCodeAt(0));
async function assinar(txt, segredo) { const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(segredo), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']); return b64u(await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(txt))); }
async function chaveCofre(segredo) { const h = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(segredo + ':agenda')); return crypto.subtle.importKey('raw', h, 'AES-GCM', false, ['encrypt', 'decrypt']); }
async function cifrar(txt, segredo) { const iv = crypto.getRandomValues(new Uint8Array(12)); const c = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await chaveCofre(segredo), new TextEncoder().encode(txt)); return b64u(iv) + '.' + b64u(c); }
async function decifrar(s, segredo) { const [iv, c] = s.split('.'); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: de64u(iv) }, await chaveCofre(segredo), de64u(c))); }
// Quem chama precisa estar logado no sistema da empresa: a ponte tenta ler um documento do Firebase da
// empresa com o login de quem chamou; as regras do Firebase decidem (login da empresa, suporte ou aparelho autorizado).
const CACHE_USU = new Map(), CACHE_TOK = new Map(), CACHE_EMP = new Map();
async function empresaCfg(cod, sistema) {
  const k = sistema + '/' + cod; const c = CACHE_EMP.get(k); if (c && Date.now() - c.t < 10 * 60e3) return c.v;
  const r = await fetch('https://bancada-sistemas.github.io/' + sistema + '/empresas/' + cod.toLowerCase() + '.json?v=' + Date.now());
  if (!r.ok) throw new Error('empresa não encontrada'); const v = await r.json(); CACHE_EMP.set(k, { v, t: Date.now() }); return v;
}
// v5 (30/10/2026): quando nega, guarda o MOTIVO (aparece no aplicativo) para achar o problema sem adivinhar
let MOTIVO_USU = '';
async function usuarioOk(cod, sistema, idToken) {
  MOTIVO_USU = '';
  if (!idToken) { MOTIVO_USU = 'o aplicativo não mandou o login (entre de novo no sistema)'; return false; }
  const k = cod + ':' + idToken.slice(-24); const c = CACHE_USU.get(k); if (c && Date.now() - c < 5 * 60e3) return true;
  let e; try { e = await empresaCfg(cod, sistema); } catch (x) { MOTIVO_USU = 'a ponte não conseguiu ler o cadastro da empresa ' + cod.toLowerCase() + ' no GitHub (' + (x.message || x) + ')'; return false; }
  const pid = e.firebaseConfig && e.firebaseConfig.projectId; if (!pid) { MOTIVO_USU = 'o cadastro da empresa no GitHub está sem o projectId do Firebase'; return false; }
  let r; try { r = await fetch('https://firestore.googleapis.com/v1/projects/' + pid + '/databases/(default)/documents/config/empresa', { headers: { Authorization: 'Bearer ' + idToken } }); } catch (x) { MOTIVO_USU = 'a ponte não conseguiu falar com o Firebase (' + (x.message || x) + ')'; return false; }
  const ok = r.status === 200 || r.status === 404;
  if (ok) { CACHE_USU.set(k, Date.now()); try { const uid = await tokenValido(idToken, pid); if (uid && ENV_ATUAL && ENV_ATUAL.AGENDA) await ENV_ATUAL.AGENDA.put('usu:' + cod + ':' + uid, String(Date.now()), { expirationTtl: 30 * 24 * 3600 }); } catch { } return true; }
  /* limite do Firebase esgotado ou Firebase fora do ar: vale quem já foi aprovado antes, com login de assinatura válida */
  if ((r.status === 429 || r.status >= 500) && ENV_ATUAL && ENV_ATUAL.AGENDA) { const uid = await tokenValido(idToken, pid); if (uid && await ENV_ATUAL.AGENDA.get('usu:' + cod + ':' + uid)) { CACHE_USU.set(k, Date.now()); return true; } }
  let m = ''; try { const j = await r.json(); m = (j.error && (j.error.status + ' ' + (j.error.message || ''))) || ''; } catch { }
  MOTIVO_USU = 'o Firebase recusou o login (' + r.status + (m ? ' ' + m.slice(0, 160) : '') + ')' + (r.status === 429 ? ' — acabou o limite grátis de leituras do dia no Firebase da empresa (volta por volta das 5h)' : '') + (r.status === 401 ? ' — o login venceu: saia e entre de novo no sistema' : r.status === 403 ? ' — confira as regras do Firestore ou se este aparelho/usuário ainda está autorizado' : '');
  return false;
}
async function tokenGoogle(env, cod) {
  const c = CACHE_TOK.get(cod); if (c && c.exp > Date.now() + 60e3) return c.tok;
  const guardado = await env.AGENDA.get('rt:' + cod); if (!guardado) return null;
  const rt = await decifrar(JSON.parse(guardado).rt, env.GOOGLE_SECRET);
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_ID, client_secret: env.GOOGLE_SECRET, refresh_token: rt, grant_type: 'refresh_token' }) });
  const j = await r.json(); if (!j.access_token) return null;
  CACHE_TOK.set(cod, { tok: j.access_token, exp: Date.now() + (j.expires_in || 3000) * 1000 }); return j.access_token;
}
const CORPO_CONTATO = d => {
  const o = {};
  if (d.nome != null) o.names = [{ givenName: String(d.nome || '').slice(0, 120) }];
  if (d.tels) o.phoneNumbers = d.tels.slice(0, 6).map(v => ({ value: String(v), type: 'mobile' }));
  if (d.email != null && d.email) o.emailAddresses = [{ value: String(d.email).slice(0, 200) }];
  if (d.endereco && (d.endereco.rua || d.endereco.cidade)) o.addresses = [{ streetAddress: String(d.endereco.rua || '').slice(0, 300), extendedAddress: String(d.endereco.bairro || '').slice(0, 120), city: String(d.endereco.cidade || '').slice(0, 120), region: String(d.endereco.uf || '').slice(0, 40), postalCode: String(d.endereco.cep || '').slice(0, 20), country: 'Brasil', type: 'home' }];
  if (d.nota) o.biographies = [{ value: String(d.nota).slice(0, 1000), contentType: 'TEXT_PLAIN' }];
  if (d.empresa) o.organizations = [{ name: String(d.empresa).slice(0, 200) }];
  if (/^\d{4}-\d{2}-\d{2}$/.test(d.nasc || '')) { const [y, m, dd] = d.nasc.split('-').map(Number); o.birthdays = [{ date: { year: y, month: m, day: dd } }]; }
  return o;
};
const CAMPOS_PF = { names: 'names', phoneNumbers: 'phoneNumbers', emailAddresses: 'emailAddresses', addresses: 'addresses', biographies: 'biographies', organizations: 'organizations', birthdays: 'birthdays' };
/* 7.5: a lista também traz endereço e aniversário (para o Bancada trazer de volta o que foi mudado direto na agenda do Google) */
const PESSOA = p => { const a = (p.addresses || [])[0], b = ((p.birthdays || [])[0] || {}).date, o = { id: p.resourceName, etag: p.etag, nome: ((p.names || [])[0] || {}).displayName || '', tels: (p.phoneNumbers || []).map(t => t.value).filter(Boolean), email: ((p.emailAddresses || [])[0] || {}).value || '' }; if (p.addresses) o.end = a ? { rua: a.streetAddress || '', bairro: a.extendedAddress || '', cidade: a.city || '', uf: a.region || '', cep: a.postalCode || '' } : null; if (p.birthdays) o.nasc = b && b.year && b.month && b.day ? `${b.year}-${String(b.month).padStart(2, '0')}-${String(b.day).padStart(2, '0')}` : ''; return o; };
async function agenda(env, cod, acao, d) {
  const tok = await tokenGoogle(env, cod);
  if (acao === 'estado') { if (!tok) return { ligado: false, code: 'desligada', erro: 'A agenda do Google ainda não foi ligada nesta empresa.' }; const g = JSON.parse(await env.AGENDA.get('rt:' + cod)); return { ligado: true, email: g.email || '' }; }
  if (!tok) return { erro: 'A agenda do Google não está ligada. Toque em Ligar agenda do Google.', code: 'desligada' };
  const G = (u, o = {}) => fetch('https://people.googleapis.com/v1/' + u, { ...o, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' } }).then(async r => { const j = await r.json().catch(() => ({})); if (!r.ok) throw new Error((j.error && j.error.message) || 'Google ' + r.status); return j; });
  if (acao === 'listar') { const L = []; let pt = ''; do { const j = await G('people/me/connections?personFields=names,phoneNumbers,emailAddresses,addresses,birthdays&pageSize=1000' + (pt ? '&pageToken=' + pt : '')); (j.connections || []).forEach(p => L.push(PESSOA(p))); pt = j.nextPageToken || ''; } while (pt); return { contatos: L }; }
  if (acao === 'criar') { const p = await G('people:createContact?personFields=names,phoneNumbers,emailAddresses', { method: 'POST', body: JSON.stringify(CORPO_CONTATO({ ...d, tels: d.tels || [] })) }); return { contato: PESSOA(p) }; }
  if (acao === 'nome' || acao === 'tels') {
    const id = String(d.id || ''); if (!/^people\/c\d+$/.test(id)) return { erro: 'contato inválido' };
    const atual = await G(id + '?personFields=names,phoneNumbers,emailAddresses');
    const corpo = acao === 'nome' ? { etag: atual.etag, names: [{ givenName: String(d.nome || '').slice(0, 120) }] } : { etag: atual.etag, phoneNumbers: (d.tels || []).slice(0, 5).map(v => ({ value: String(v), type: 'mobile' })) };
    const p = await G(id + ':updateContact?updatePersonFields=' + (acao === 'nome' ? 'names' : 'phoneNumbers') + '&personFields=names,phoneNumbers,emailAddresses', { method: 'PATCH', body: JSON.stringify(corpo) });
    await env.AGENDA.put('log:' + cod + ':' + Date.now(), JSON.stringify({ acao, id, por: d.autorizadoPor || '' }), { expirationTtl: 60 * 60 * 24 * 365 });
    return { contato: PESSOA(p) };
  }
  /* cria vários contatos de uma vez (até 200), para enviar os clientes antigos rápido */
  if (acao === 'criarLote') {
    const L = (d.contatos || []).slice(0, 200); if (!L.length) return { contatos: [] };
    const j = await G('people:batchCreateContacts', { method: 'POST', body: JSON.stringify({ contacts: L.map(x => ({ contactPerson: CORPO_CONTATO({ ...x, tels: x.tels || [] }) })), readMask: 'names,phoneNumbers,emailAddresses' }) });
    return { contatos: (j.createdPeople || []).map(r => r && r.person ? PESSOA(r.person) : null) };
  }
  /* atualiza os dados do contato (nome, telefones, e-mail, endereço, empresa, observação, aniversário) — só os campos enviados */
  if (acao === 'atualizar') {
    const id = String(d.id || ''); if (!/^people\/c\d+$/.test(id)) return { erro: 'contato inválido' };
    const atual = await G(id + '?personFields=names,phoneNumbers,emailAddresses');
    const corpo = CORPO_CONTATO(d), campos = Object.keys(corpo).map(k => CAMPOS_PF[k]).filter(Boolean); if (!campos.length) return { contato: PESSOA(atual) };
    const p = await G(id + ':updateContact?updatePersonFields=' + campos.join(',') + '&personFields=names,phoneNumbers,emailAddresses', { method: 'PATCH', body: JSON.stringify({ etag: atual.etag, ...corpo }) });
    if (d.tels) await env.AGENDA.put('log:' + cod + ':' + Date.now(), JSON.stringify({ acao, id, por: d.autorizadoPor || '' }), { expirationTtl: 60 * 60 * 24 * 365 });
    return { contato: PESSOA(p) };
  }
  if (acao === 'desligar') { const g = JSON.parse(await env.AGENDA.get('rt:' + cod)); try { await fetch('https://oauth2.googleapis.com/revoke?token=' + encodeURIComponent(await decifrar(g.rt, env.GOOGLE_SECRET)), { method: 'POST' }); } catch { } await env.AGENDA.delete('rt:' + cod); CACHE_TOK.delete(cod); return { ok: true }; }
  return { erro: 'ação desconhecida' };
}

const BANCO_SEM_CERT = ['asaas', 'mercadopago'];
const segBanco = env => env.BANCO_SEGREDO || env.MESTRE || '';
async function credBanco(env, cod, conta) { const g = await env.AGENDA.get('banco:' + cod + ':' + conta); if (!g) return null; const x = JSON.parse(g); return { ...x, cred: JSON.parse(await decifrar(x.cred, segBanco(env))) }; }
const soDig = v => String(v || '').replace(/\D/g, '');
async function asaas(C, metodo, caminho, corpo) {
  const base = C.modo === 'producao' ? 'https://api.asaas.com/v3' : 'https://sandbox.asaas.com/api/v3';
  const r = await fetch(base + caminho, { method: metodo, headers: { 'Content-Type': 'application/json', 'access_token': C.cred.chave, 'User-Agent': 'BancadaSistemas' }, body: corpo ? JSON.stringify(corpo) : undefined });
  let j = null; try { j = await r.json(); } catch { } if (!r.ok) throw new Error('Asaas: ' + ((j && j.errors && j.errors.map(e => e.description).join('; ')) || r.status)); return j;
}
async function mpago(C, metodo, caminho, corpo, idem) {
  const r = await fetch('https://api.mercadopago.com' + caminho, { method: metodo, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + C.cred.chave, ...(idem ? { 'X-Idempotency-Key': idem } : {}) }, body: corpo ? JSON.stringify(corpo) : undefined });
  let j = null; try { j = await r.json(); } catch { } if (!r.ok) throw new Error('Mercado Pago: ' + ((j && (j.message || (j.cause && j.cause[0] && j.cause[0].description))) || r.status)); return j;
}
async function banco(env, cod, acao, d, origem) {
  if (!env.AGENDA) throw new Error('Falta ligar o KV AGENDA nesta ponte.');
  if (acao === 'eventos') { const L = await env.AGENDA.list({ prefix: 'bev:' + cod + ':' }); const out = []; for (const k of L.keys) { const v = await env.AGENDA.get(k.name); if (v) out.push(JSON.parse(v)); await env.AGENDA.delete(k.name); } return { eventos: out }; }
  const conta = String(d.conta || '').replace(/[^\w-]/g, '').slice(0, 40); if (!conta) throw new Error('Conta bancária não informada.');
  if (acao === 'salvarCred') { if (!segBanco(env)) throw new Error('Falta o segredo BANCO_SEGREDO (ou MESTRE) nesta ponte.'); const tok = crypto.randomUUID().replace(/-/g, '');
    await env.AGENDA.put('banco:' + cod + ':' + conta, JSON.stringify({ provedor: d.provedor, modo: d.modo === 'producao' ? 'producao' : 'teste', cred: await cifrar(JSON.stringify(d.cred || {}), segBanco(env)), tok, em: Date.now(), por: d.por || '' }));
    return { ok: true, webhook: origem + '/banco/webhook/' + cod + '/' + conta + '?t=' + tok }; }
  if (acao === 'apagarCred') { await env.AGENDA.delete('banco:' + cod + ':' + conta); return { ok: true }; }
  const C = await credBanco(env, cod, conta);
  if (acao === 'temCred') return C ? { tem: true, provedor: C.provedor, modo: C.modo, em: C.em, webhook: origem + '/banco/webhook/' + cod + '/' + conta + '?t=' + C.tok } : { tem: false };
  if (!C) throw new Error('Esta conta ainda não tem as chaves do banco guardadas na ponte.');
  if (!BANCO_SEM_CERT.includes(C.provedor)) throw new Error('Integração com este banco precisa do certificado digital instalado na ponte (Cloudflare → mTLS). As chaves já estão guardadas; o resto é ativado no primeiro teste com o banco.');
  if (C.provedor === 'asaas') {
    if (acao === 'testar') { const b = await asaas(C, 'GET', '/finance/balance'); return { ok: true, msg: 'Conectado ao Asaas (' + (C.modo === 'producao' ? 'produção' : 'teste') + '). Saldo: R$ ' + Number(b.balance || 0).toFixed(2).replace('.', ',') }; }
    if (acao === 'emitir') { const p = d.pagador || {}, doc = soDig(p.doc); if (!doc) throw new Error('O cliente precisa ter CPF ou CNPJ para gerar boleto.');
      let cli = (await asaas(C, 'GET', '/customers?cpfCnpj=' + doc)).data?.[0]; if (!cli) cli = await asaas(C, 'POST', '/customers', { name: p.nome, cpfCnpj: doc, email: p.email || undefined, mobilePhone: soDig(p.tel) || undefined, postalCode: soDig(p.cep) || undefined, address: p.rua || undefined, addressNumber: p.numero || undefined, province: p.bairro || undefined, notificationDisabled: true });
      const pg = await asaas(C, 'POST', '/payments', { customer: cli.id, billingType: 'BOLETO', value: Number(d.valor), dueDate: d.venc, description: String(d.desc || '').slice(0, 500), externalReference: d.ref || undefined, fine: { value: Number(d.multa || 0) }, interest: { value: Number(d.mora || 0) } });
      let lin = {}; try { lin = await asaas(C, 'GET', '/payments/' + pg.id + '/identificationField'); } catch { } let pix = {}; try { pix = await asaas(C, 'GET', '/payments/' + pg.id + '/pixQrCode'); } catch { }
      return { boleto: { id: pg.id, provedor: 'asaas', linha: lin.identificationField || '', codigo: lin.barCode || '', nosso: lin.nossoNumero || pg.nossoNumero || '', pdf: pg.bankSlipUrl || '', link: pg.invoiceUrl || '', pix: pix.payload || '', status: pg.status } }; }
    if (acao === 'consultar') { const pg = await asaas(C, 'GET', '/payments/' + encodeURIComponent(d.id)); return { status: pg.status, pago: ['RECEIVED', 'CONFIRMED', 'RECEIVED_IN_CASH'].includes(pg.status), valorPago: pg.value, data: pg.paymentDate || pg.clientPaymentDate || '' }; }
    if (acao === 'cancelar') { await asaas(C, 'DELETE', '/payments/' + encodeURIComponent(d.id)); return { ok: true }; }
  }
  if (C.provedor === 'mercadopago') {
    if (acao === 'testar') { const u = await mpago(C, 'GET', '/users/me'); return { ok: true, msg: 'Conectado ao Mercado Pago: ' + (u.nickname || u.email || u.id) }; }
    if (acao === 'emitir') { const p = d.pagador || {}, doc = soDig(p.doc); if (!doc) throw new Error('O cliente precisa ter CPF ou CNPJ para gerar boleto.'); const nm = String(p.nome || '').trim().split(/\s+/);
      const pg = await mpago(C, 'POST', '/v1/payments', { transaction_amount: Number(d.valor), description: String(d.desc || 'Cobrança').slice(0, 200), payment_method_id: 'bolbradesco', date_of_expiration: d.venc + 'T23:59:59.000-03:00', external_reference: d.ref || undefined,
        payer: { email: p.email || ('cliente' + doc + '@sememail.com.br'), first_name: nm[0] || 'Cliente', last_name: nm.slice(1).join(' ') || '-', identification: { type: doc.length > 11 ? 'CNPJ' : 'CPF', number: doc }, address: { zip_code: soDig(p.cep) || '00000000', street_name: p.rua || '-', street_number: p.numero || 's/n', neighborhood: p.bairro || '-', city: p.cidade || '-', federal_unit: p.uf || 'PE' } } }, crypto.randomUUID());
      return { boleto: { id: String(pg.id), provedor: 'mercadopago', linha: (pg.transaction_details && pg.transaction_details.digitable_line) || '', codigo: (pg.barcode && pg.barcode.content) || '', pdf: (pg.transaction_details && pg.transaction_details.external_resource_url) || '', status: pg.status } }; }
    if (acao === 'consultar') { const pg = await mpago(C, 'GET', '/v1/payments/' + encodeURIComponent(d.id)); return { status: pg.status, pago: pg.status === 'approved', valorPago: pg.transaction_amount, data: (pg.date_approved || '').slice(0, 10) }; }
    if (acao === 'cancelar') { await mpago(C, 'PUT', '/v1/payments/' + encodeURIComponent(d.id), { status: 'cancelled' }); return { ok: true }; }
  }
  throw new Error('Ação desconhecida: ' + acao);
}

export default {
  async fetch(req, env, ctx) {
    ENV_ATUAL = env;
    const url = new URL(req.url);
    const empresa = (url.searchParams.get('empresa') || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const chave = empresa ? env['KEY_' + empresa] : '';
    const origem = req.headers.get('Origin') || '';
    const liberada = ORIGENS.includes(origem);
    const cors = {
      'Access-Control-Allow-Origin': liberada ? origem : ORIGENS[0],
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Expose-Headers': 'X-Bancada-Modelo, X-Bancada-Modelo-Auto',
      'Vary': 'Origin'
    };
    const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

    const rota = url.pathname.replace(/\/+$/, '');

    // Boleto bancário: chaves guardadas na ponte; o banco avisa o pagamento pelo webhook
    if (rota.startsWith('/banco/')) {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      const wh = /^\/banco\/webhook\/([A-Z0-9]+)\/([\w-]+)$/.exec(rota);
      if (wh && req.method === 'POST') {
        if (!env.AGENDA) return new Response('sem KV', { status: 500 });
        const g = await env.AGENDA.get('banco:' + wh[1] + ':' + wh[2]); if (!g || JSON.parse(g).tok !== url.searchParams.get('t')) return new Response('negado', { status: 403 });
        let b = {}; try { b = await req.json(); } catch { } const pay = b.payment || b.data || {};
        await env.AGENDA.put('bev:' + wh[1] + ':' + Date.now() + ':' + Math.random().toString(36).slice(2, 8), JSON.stringify({ conta: wh[2], evento: b.event || b.action || b.type || '', id: String(pay.id || b.id || ''), status: pay.status || '', valor: pay.value || pay.transaction_amount || 0, data: pay.paymentDate || pay.clientPaymentDate || '', em: Date.now() }), { expirationTtl: 60 * 60 * 24 * 60 });
        return new Response('ok');
      }
      if (rota === '/banco/api' && req.method === 'POST' && liberada) {
        let b = {}; try { b = await req.json(); } catch { }
        if (!empresa || !sistemaOk(b.sistema) || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ erro: 'Sem permissão: entre no sistema da empresa.', detalhe: MOTIVO_USU }, 403);
        try { return json(await banco(env, empresa, String(b.acao || ''), b.dados || {}, url.origin)); } catch (x) { return json({ erro: String(x.message || x) }, 502); }
      }
      if (rota === '/banco/ping') return json({ banco: true, versao: 6 });
      return json({ erro: 'rota inválida' }, 404);
    }

    // Documentos por link (PDF do WhatsApp): guarda 90 dias no KV AGENDA
    if (rota === '/doc/ping') return json({ doc: true, kv: !!env.AGENDA, versao: 6 });
    if (rota === '/doc') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (req.method !== 'POST' || !liberada) return json({ doc: true, erro: 'acesso negado' }, 403);
      if (!env.AGENDA) return json({ doc: true, erro: 'Falta ligar o KV AGENDA nesta ponte.' }, 500);
      let b = {}; try { b = await req.json(); } catch { }
      if (!empresa || !/^[a-z0-9-]{2,30}$/.test(b.sistema || '') || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ doc: true, erro: 'Sem permissão: entre no sistema da empresa.', detalhe: MOTIVO_USU }, 403);
      const txt = String(b.pdf || ''); if (!txt || txt.length > 12e6) return json({ doc: true, erro: 'PDF vazio ou grande demais (máximo 9 MB).' }, 400);
      let bytes; try { bytes = Uint8Array.from(atob(txt), c => c.charCodeAt(0)); } catch { return json({ doc: true, erro: 'PDF inválido' }, 400); }
      if (String.fromCharCode(...bytes.slice(0, 4)) !== '%PDF') return json({ doc: true, erro: 'O arquivo não é um PDF.' }, 400);
      const id = b64u(crypto.getRandomValues(new Uint8Array(18)));
      const nome = String(b.nome || 'documento.pdf').replace(/[^\w.\- ]+/g, '').slice(0, 80) || 'documento.pdf';
      await env.AGENDA.put('doc:' + id, bytes, { expirationTtl: 60 * 60 * 24 * 90, metadata: { nome, empresa, em: Date.now() } });
      return json({ doc: true, url: url.origin + '/d/' + id + '/' + encodeURIComponent(nome) });
    }
    if (rota.startsWith('/d/') && req.method === 'GET') {
      const id = rota.split('/')[2] || '';
      const r = /^[A-Za-z0-9_-]{20,40}$/.test(id) && env.AGENDA ? await env.AGENDA.getWithMetadata('doc:' + id, { type: 'arrayBuffer' }) : null;
      if (!r || !r.value) return new Response('Este documento não está mais disponível (o link vale por 90 dias). Peça um novo à empresa.', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
      const nome = (r.metadata && r.metadata.nome) || 'documento.pdf';
      return new Response(r.value, { headers: { 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline; filename="' + nome + '"', 'Cache-Control': 'private, max-age=3600', 'X-Robots-Tag': 'noindex' } });
    }

    // 7.5 — Resposta do cliente por link (retirada, aprovação, preventiva): página simples servida pela própria ponte; o app busca as respostas novas
    // 7.7 — Fotos do produto: acha as fotos oficiais nas páginas onde o produto foi encontrado (fabricante, lojas) e entrega a foto para o app (o navegador sozinho é bloqueado pelos sites)
    if (rota === '/img/ping') return json({ img: true, versao: 1 });
    if (rota === '/img/achar' || rota === '/img/ver') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (req.method !== 'POST' || !liberada) return json({ erro: 'acesso negado' }, 403);
      let b = {}; try { b = await req.json(); } catch { }
      if (!empresa || !/^[a-z0-9-]{2,30}$/.test(b.sistema || '') || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ erro: 'Sem permissão: entre no sistema da empresa.', detalhe: MOTIVO_USU }, 403);
      const okUrl = u => { try { const x = new URL(String(u)); return /^https?:$/.test(x.protocol) && !/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(x.hostname) ? x.href : ''; } catch { return ''; } };
      const UA = { 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130 Mobile Safari/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9' };
      const comTempo = (p, ms) => Promise.race([p, new Promise((_, r) => setTimeout(() => r(new Error('tempo')), ms))]);
      if (rota === '/img/ver') {
        const u = okUrl(b.url); if (!u) return json({ erro: 'endereço inválido' }, 400);
        try { const r = await comTempo(fetch(u, { headers: { ...UA, Accept: 'image/*,*/*;q=0.5', Referer: new URL(u).origin + '/' }, redirect: 'follow' }), 12000);
          const ct = r.headers.get('content-type') || ''; if (!r.ok || !/^image\//.test(ct)) return json({ erro: 'não é imagem' }, 415);
          const buf = await r.arrayBuffer(); if (buf.byteLength > 8e6 || buf.byteLength < 800) return json({ erro: 'tamanho' }, 413);
          return new Response(buf, { headers: { ...cors, 'Content-Type': ct, 'Cache-Control': 'private, max-age=600' } }); } catch (e) { return json({ erro: 'falhou: ' + (e && e.message || e) }, 502); }
      }
      const pags = (Array.isArray(b.paginas) ? b.paginas : []).map(okUrl).filter(Boolean).slice(0, 6), achadas = [], vistos = new Set(), precos = [];
      const preco = (v, moeda, loja, url) => { const n = typeof v === 'number' ? v : parseFloat(String(v || '').replace(/[^\d.,]/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.')); if (!(n > 0.5 && n < 1e6) || (moeda && !/BRL|R\$/i.test(moeda))) return; if (!precos.some(x => x.loja === loja)) precos.push({ loja, preco: Math.round(n * 100) / 100, url }); };
      const add = (u, base, origem) => { try { const x = new URL(String(u).replace(/&amp;/g, '&').trim(), base).href; if (!okUrl(x) || vistos.has(x) || /\.(svg|gif)(\?|$)|logo|sprite|icon|favicon|placeholder|banner/i.test(x)) return; vistos.add(x); achadas.push({ url: x, origem }); } catch { } };
      (Array.isArray(b.imagens) ? b.imagens : []).slice(0, 8).forEach(u => add(u, undefined, 'pesquisa'));
      await Promise.all(pags.map(async p => { try { const r = await comTempo(fetch(p, { headers: { ...UA, Accept: 'text/html' }, redirect: 'follow' }), 8000); if (!r.ok) return; const h = (await r.text()).slice(0, 600000), base = r.url || p, host = new URL(base).hostname.replace(/^www\./, '');
        for (const m of h.matchAll(/<meta[^>]+(?:property|name)=["'](?:og:image(?::secure_url)?|twitter:image(?::src)?)["'][^>]*>/gi)) { const c = /content=["']([^"']+)["']/i.exec(m[0]); if (c) add(c[1], base, host); }
        for (const m of h.matchAll(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:image|twitter:image)["']/gi)) add(m[1], base, host);
        for (const m of h.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) { try { const pega = o => { if (!o || typeof o !== 'object') return; if (Array.isArray(o)) return o.forEach(pega); if (/Product/i.test(String(o['@type'] || ''))) { const of = [].concat(o.offers || []); for (const f of of) { if (!f) continue; preco(f.price != null ? f.price : f.lowPrice, f.priceCurrency, host, base); } const im = o.image; (Array.isArray(im) ? im : [im]).slice(0, 6).forEach(i => add(typeof i === 'string' ? i : i && (i.url || i.contentUrl), base, host)); } if (o['@graph']) pega(o['@graph']); }; pega(JSON.parse(m[1].trim())); } catch { } }
        if (!precos.some(x => x.loja === host)) { const a = /<meta[^>]+(?:property|itemprop)=["'](?:product:price:amount|og:price:amount|price)["'][^>]*content=["']([^"']+)["']/i.exec(h) || /<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|itemprop)=["'](?:product:price:amount|og:price:amount|price)["']/i.exec(h); if (a) preco(a[1], '', host, base); }
      } catch { } }));
      return json({ imagens: achadas.slice(0, 12), precos: precos.slice(0, 8) });
    }

    // 7.6 — Laudo pela empresa parceira: link para quem vai CONSERTAR preencher diagnóstico, solução, peças/serviços com valores e prazo.
    // A página mostra só o equipamento e o nº da nossa OS (nada do cliente). O app busca os laudos preenchidos.
    if (rota === '/lp/ping') return json({ lp: true, kv: !!env.AGENDA, versao: 1 });
    if (rota === '/lp/criar' || rota === '/lp/novas' || rota === '/lp/lidas') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (req.method !== 'POST' || !liberada) return json({ erro: 'acesso negado' }, 403);
      if (!env.AGENDA) return json({ erro: 'Falta ligar o KV AGENDA nesta ponte.' }, 500);
      let b = {}; try { b = await req.json(); } catch { }
      if (!empresa || !/^[a-z0-9-]{2,30}$/.test(b.sistema || '') || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ erro: 'Sem permissão: entre no sistema da empresa.', detalhe: MOTIVO_USU }, 403);
      const cut = (v, n) => String(v || '').slice(0, n);
      if (rota === '/lp/criar') {
        const id = b64u(crypto.getRandomValues(new Uint8Array(18))), dias = Math.min(90, Math.max(1, +b.dias || 60)), e = b.equip || {};
        const r = { empresa, ref: cut(b.ref, 60), osNum: cut(b.osNum, 20), parcNome: cut(b.parcNome, 80), parcOs: cut(b.parcOs, 30), empNome: cut(b.empNome, 80), empTel: cut(b.empTel, 30),
          equip: { tipo: cut(e.tipo, 60), marca: cut(e.marca, 60), modelo: cut(e.modelo, 80), serie: cut(e.serie, 60), defeito: cut(e.defeito, 600), acessorios: cut(e.acessorios, 300), diag: cut(e.diag, 600) },
          servicos: (Array.isArray(b.servicos) ? b.servicos : []).map(x => cut(x, 120)).filter(Boolean).slice(0, 400),
          pre: (Array.isArray(b.pre) ? b.pre : []).slice(0, 40).map(i => ({ nome: cut(i.nome, 120), qtd: Math.max(1, +i.qtd || 1), valor: Math.max(0, Math.round((+i.valor || 0) * 100) / 100), ult: !!i.ult })).filter(i => i.nome),
          sug: Object.fromEntries(Object.entries(b.sug && typeof b.sug === 'object' ? b.sug : {}).slice(0, 400).map(([k, v]) => [cut(k, 120), Math.max(0, Math.round((+v || 0) * 100) / 100)]).filter(([k, v]) => k && v)), em: Date.now(), expira: Date.now() + dias * 864e5, laudo: null };
        await env.AGENDA.put('lp:' + id, JSON.stringify(r), { expirationTtl: dias * 86400 });
        return json({ id, url: url.origin + '/l/' + id });
      }
      if (rota === '/lp/novas') {
        const L = await env.AGENDA.list({ prefix: 'lpn:' + empresa + ':', limit: 100 }), out = [];
        for (const k of L.keys) { const id = k.name.split(':').pop(); const v = await env.AGENDA.get('lp:' + id); if (v) { const r = JSON.parse(v); if (r.laudo) out.push({ id, chave: k.name, ref: r.ref, laudo: r.laudo }); } else await env.AGENDA.delete(k.name); }
        return json({ laudos: out });
      }
      if (rota === '/lp/lidas') { for (const k of (b.chaves || []).slice(0, 100)) if (String(k).startsWith('lpn:' + empresa + ':')) await env.AGENDA.delete(String(k)); return json({ ok: true }); }
    }
    if (rota.startsWith('/l/')) {
      const id = rota.split('/')[2] || '', H = (t, s = 200) => new Response(t, { status: s, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
      const v = /^[A-Za-z0-9_-]{20,40}$/.test(id) && env.AGENDA ? await env.AGENDA.get('lp:' + id) : null;
      const esc = t => String(t ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const pagina = (tit, corpo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(tit || 'Laudo')}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#16181d;margin:0;padding:14px}main{max-width:620px;margin:0 auto;background:#fff;border-radius:14px;padding:18px;box-shadow:0 2px 10px rgba(0,0,0,.08)}h1{font-size:1.15rem;margin:0 0 4px}h2{font-size:1rem;margin:18px 0 6px}p{line-height:1.5}.m{color:#5b6270;font-size:.9rem}.box{background:#f4f6f9;border-radius:10px;padding:10px 12px;font-size:.92rem;line-height:1.5}label{display:block;font-size:.88rem;font-weight:600;margin:10px 0 4px}input,textarea,select{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #d7dbe2;border-radius:10px}.it{display:grid;grid-template-columns:minmax(0,1fr) 62px 104px 36px;gap:6px;margin-bottom:6px;align-items:center}.it button{height:40px;border:1px solid #d7dbe2;background:#fff;border-radius:10px;font-size:1.1rem}.add{margin-top:4px;padding:10px 14px;border:1px dashed #9aa3b2;background:#fff;border-radius:10px;font:inherit;width:auto}.it .ul{grid-column:1/-1;color:#5b6270;font-size:.8rem;margin:-2px 0 4px}.tot{text-align:right;font-weight:700;margin-top:6px}button.env{width:100%;margin-top:16px;padding:14px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-size:1rem;font-weight:600}.ok{background:#e8f6ee;border-radius:10px;padding:14px}@media(max-width:420px){.it{grid-template-columns:minmax(0,1fr) 52px 88px 34px}}</style></head><body><main>${corpo}</main></body></html>`;
      if (!v) return H(pagina('', '<h1>Link expirado</h1><p>Este link de laudo não vale mais. Fale com a empresa que enviou o equipamento.</p>'), 404);
      const r = JSON.parse(v), E = r.equip || {};
      if (req.method === 'POST') {
        let f; try { f = await req.formData(); } catch { f = new FormData(); }
        const g = (k, n) => String(f.get(k) || '').slice(0, n), nomes = f.getAll('in').map(x => String(x).slice(0, 120)), qs = f.getAll('iq'), vs = f.getAll('iv');
        const num = x => { const s = String(x || '').trim().replace(/[^\d,.-]/g, ''); const n = s.includes(',') ? +s.replace(/\./g, '').replace(',', '.') : +s; return isFinite(n) ? Math.round(n * 100) / 100 : 0; };
        const itens = nomes.map((n, i) => ({ nome: n.trim(), qtd: Math.max(1, num(qs[i]) || 1), valor: num(vs[i]) })).filter(i => i.nome).slice(0, 40);
        const conc = g('conclusao', 20);
        r.laudo = { diagnostico: g('diagnostico', 1500), solucao: g('solucao', 1500), conclusao: ['viavel', 'inviavel', 'semdefeito', 'aguardando'].includes(conc) ? conc : 'viavel', itens, prazo: /^\d{4}-\d{2}-\d{2}$/.test(g('prazo', 10)) ? g('prazo', 10) : '', obs: g('obs', 1000), por: g('por', 80), em: Date.now() };
        await env.AGENDA.put('lp:' + id, JSON.stringify(r), { expirationTtl: Math.max(60, Math.round((r.expira - Date.now()) / 1000)) });
        await env.AGENDA.put('lpn:' + r.empresa + ':' + Date.now() + ':' + id, '1', { expirationTtl: 60 * 60 * 24 * 30 });
        const tot = itens.reduce((s, i) => s + i.qtd * i.valor, 0);
        return H(pagina(r.empNome, `<h1>Laudo enviado. Obrigado!</h1><div class="ok"><b>${esc(r.empNome || 'A empresa')}</b> recebeu o laudo da OS nº <b>${esc(r.osNum)}</b>${itens.length ? ` · total ${tot.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' })}` : ''}.</div><p class="m">Se precisar corrigir, abra este link de novo, ajuste e envie outra vez.</p>`));
      }
      const L = r.laudo || {}, hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
      const SV = r.servicos || [], linha = (i = {}) => `<div class="it"><input name="in"${SV.length ? ' list="sv"' : ''} placeholder="${SV.length ? 'Serviço' : 'Peça ou serviço'}" value="${esc(i.nome)}"><input name="iq" inputmode="decimal" placeholder="Qtd" value="${esc(i.qtd || 1)}"><input name="iv" inputmode="decimal" placeholder="Valor R$" value="${i.valor ? esc(Number(i.valor).toFixed(2).replace('.', ',')) : ''}"><button type="button" onclick="this.parentNode.remove();t()" aria-label="Tirar">×</button>${i.ult ? '<small class="ul">Último valor cobrado</small>' : ''}</div>`;
      const eq = [E.tipo, E.marca, E.modelo].filter(Boolean).join(' ');
      return H(pagina(r.empNome, `<h1>Laudo do equipamento</h1><p class="m">${esc(r.empNome || '')} · <b>OS nº ${esc(r.osNum)}</b>${r.parcOs ? ` · sua OS nº ${esc(r.parcOs)}` : ''}</p>
        <div class="box"><b>${esc(eq || 'Equipamento')}</b>${E.serie ? `<br>Nº de série: ${esc(E.serie)}` : ''}${E.defeito ? `<br>Defeito relatado: ${esc(E.defeito)}` : ''}${E.acessorios ? `<br>Acessórios: ${esc(E.acessorios)}` : ''}${E.diag ? `<br>Nosso diagnóstico: ${esc(E.diag)}` : ''}</div>
        ${r.laudo ? '<p class="m">Você já enviou este laudo. Pode corrigir abaixo e enviar de novo.</p>' : ''}
        <form method="post"><h2>O que foi encontrado</h2><label>Diagnóstico</label><textarea name="diagnostico" rows="3" maxlength="1500">${esc(L.diagnostico)}</textarea>
        <label>Solução / serviço a fazer</label><textarea name="solucao" rows="3" maxlength="1500">${esc(L.solucao)}</textarea>
        <label>Conclusão</label><select name="conclusao">${[['viavel', 'Reparo viável'], ['inviavel', 'Reparo inviável'], ['semdefeito', 'Sem defeito encontrado'], ['aguardando', 'Aguardando peça']].map(([k, t]) => `<option value="${k}"${(L.conclusao || 'viavel') === k ? ' selected' : ''}>${t}</option>`).join('')}</select>
        <h2>Peças e serviços (seus valores)</h2>${SV.length ? `<p class="m" style="margin:0 0 8px">Toque no campo e escolha um serviço da lista; se não estiver nela, escreva o nome (entra como avulso).${Object.keys(r.sug || {}).length ? ' Os valores já preenchidos são os últimos que você nos cobrou: se não mudou, é só manter; se mudou, altere.' : ''}</p><datalist id="sv">${SV.map(n => `<option value="${esc(n)}">`).join('')}</datalist>` : ''}<div id="its">${(L.itens && L.itens.length ? L.itens : (r.pre && r.pre.length ? r.pre : [{}])).map(linha).join('')}</div><button type="button" class="add" onclick="document.getElementById('its').insertAdjacentHTML('beforeend',L1);t()">＋ Adicionar item</button><div class="tot" id="tot"></div>
        <label>Prazo para ficar pronto</label><input type="date" name="prazo" min="${hoje}" value="${esc(L.prazo)}">
        <label>Observações (opcional)</label><textarea name="obs" rows="2" maxlength="1000">${esc(L.obs)}</textarea>
        <label>Quem preencheu</label><input name="por" maxlength="80" value="${esc(L.por)}" placeholder="Seu nome">
        <button class="env" type="submit">Enviar laudo</button></form>${r.empTel ? `<p class="m">Dúvidas: ${esc(r.empTel)} · cite a OS nº ${esc(r.osNum)}</p>` : ''}
        <script>var L1=${JSON.stringify(linha())};function n(x){x=String(x||'').trim();if(x.indexOf(',')>=0)x=x.replace(/\\./g,'').replace(',','.');x=parseFloat(x);return isFinite(x)?x:0}function t(){var s=0;document.querySelectorAll('#its .it').forEach(function(d){var i=d.querySelectorAll('input');s+=(n(i[1].value)||1)*n(i[2].value)});document.getElementById('tot').textContent=s?'Total: '+s.toLocaleString('pt-BR',{style:'currency',currency:'BRL'}):''}var SUG=${JSON.stringify(r.sug || {}).replace(/</g, '\\u003c')};document.getElementById('its').addEventListener('input',t);document.getElementById('its').addEventListener('change',function(e){var x=e.target;if(x.name!=='in')return;var v=x.parentNode.querySelectorAll('input')[2];var s=SUG[x.value.trim()];if(s&&!v.value){v.value=s.toFixed(2).replace('.',',');v.title='Último valor cobrado';var u=x.parentNode.querySelector('.ul');if(!u)x.parentNode.insertAdjacentHTML('beforeend','<small class="ul">Último valor cobrado</small>');t()}});t()</script>`));
    }

    if (rota === '/resp/ping') return json({ resp: true, kv: !!env.AGENDA, versao: 1 });
    if (rota === '/resp/criar' || rota === '/resp/novas' || rota === '/resp/lidas') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (req.method !== 'POST' || !liberada) return json({ erro: 'acesso negado' }, 403);
      if (!env.AGENDA) return json({ erro: 'Falta ligar o KV AGENDA nesta ponte.' }, 500);
      let b = {}; try { b = await req.json(); } catch { }
      if (!empresa || !/^[a-z0-9-]{2,30}$/.test(b.sistema || '') || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ erro: 'Sem permissão: entre no sistema da empresa.', detalhe: MOTIVO_USU }, 403);
      if (rota === '/resp/criar') {
        const tipo = String(b.tipo || ''); if (!['retirada', 'aprovacao', 'preventiva'].includes(tipo)) return json({ erro: 'tipo inválido' }, 400);
        const id = b64u(crypto.getRandomValues(new Uint8Array(18))), dias = Math.min(60, Math.max(1, +b.dias || 30));
        const r = { empresa, tipo, ref: String(b.ref || '').slice(0, 60), col: b.col === 'orcamentos' ? 'orcamentos' : 'os', titulo: String(b.titulo || '').slice(0, 160), cliente: String(b.cliente || '').slice(0, 80), empNome: String(b.empNome || '').slice(0, 80), empTel: String(b.empTel || '').slice(0, 30), em: Date.now(), expira: Date.now() + dias * 864e5, resposta: null };
        await env.AGENDA.put('rsp:' + id, JSON.stringify(r), { expirationTtl: dias * 86400 });
        return json({ id, url: url.origin + '/r/' + id });
      }
      if (rota === '/resp/novas') {
        const L = await env.AGENDA.list({ prefix: 'rspn:' + empresa + ':', limit: 100 }), out = [];
        for (const k of L.keys) { const id = k.name.split(':').pop(); const v = await env.AGENDA.get('rsp:' + id); if (v) { const r = JSON.parse(v); if (r.resposta) out.push({ id, chave: k.name, tipo: r.tipo, ref: r.ref, col: r.col, resposta: r.resposta }); } else await env.AGENDA.delete(k.name); }
        return json({ respostas: out });
      }
      if (rota === '/resp/lidas') { for (const k of (b.chaves || []).slice(0, 100)) if (String(k).startsWith('rspn:' + empresa + ':')) await env.AGENDA.delete(String(k)); return json({ ok: true }); }
    }
    if (rota.startsWith('/r/')) {
      const id = rota.split('/')[2] || '', H = (t, s = 200) => new Response(t, { status: s, headers: { 'Content-Type': 'text/html; charset=utf-8', 'X-Robots-Tag': 'noindex', 'Cache-Control': 'no-store' } });
      const v = /^[A-Za-z0-9_-]{20,40}$/.test(id) && env.AGENDA ? await env.AGENDA.get('rsp:' + id) : null;
      const esc = t => String(t || '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const pagina = (emp, corpo) => `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(emp || 'Resposta')}</title><style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;background:#f4f5f7;color:#16181d;margin:0;padding:16px}main{max-width:460px;margin:0 auto;background:#fff;border-radius:14px;padding:20px;box-shadow:0 2px 10px rgba(0,0,0,.08)}h1{font-size:1.15rem;margin:0 0 4px}p{line-height:1.5}.m{color:#5b6270;font-size:.92rem}label{display:flex;gap:10px;align-items:center;border:1px solid #d7dbe2;border-radius:10px;padding:12px;margin:8px 0;font-size:1rem;cursor:pointer}input[type=date],textarea{width:100%;box-sizing:border-box;font:inherit;padding:10px;border:1px solid #d7dbe2;border-radius:10px;margin-top:6px}button{width:100%;margin-top:14px;padding:14px;border:0;border-radius:10px;background:#1d4ed8;color:#fff;font-size:1rem;font-weight:600}.ok{background:#e8f6ee;border-radius:10px;padding:14px}</style></head><body><main>${corpo}</main></body></html>`;
      if (!v) return H(pagina('', '<h1>Link expirado</h1><p>Este link de resposta não vale mais. Responda pelo WhatsApp da empresa, por favor.</p>'), 404);
      const r = JSON.parse(v);
      const OPC = { retirada: [['data', 'Vou buscar no dia:'], ['ja', 'Já busquei'], ['falar', 'Preciso falar com vocês']], aprovacao: [['aprova', 'Aprovo o serviço'], ['nao', 'Não aprovo'], ['duvida', 'Tenho uma dúvida']], preventiva: [['data', 'Quero agendar para o dia:'], ['nao', 'Agora não'], ['falar', 'Quero falar com vocês']] }[r.tipo] || [];
      const PERG = { retirada: 'Quando você vem buscar o seu equipamento?', aprovacao: 'Você aprova o serviço?', preventiva: 'Vamos agendar a manutenção preventiva?' }[r.tipo] || 'Sua resposta';
      if (req.method === 'POST') {
        let f; try { f = await req.formData(); } catch { f = new FormData(); }
        const esc1 = String(f.get('escolha') || ''), data = String(f.get('data') || ''), texto = String(f.get('texto') || '').slice(0, 600);
        if (!OPC.some(o => o[0] === esc1)) return H(pagina(r.empNome, '<h1>Escolha uma opção</h1><p><a href="">Voltar</a></p>'), 400);
        if (esc1 === 'data' && !/^\d{4}-\d{2}-\d{2}$/.test(data)) return H(pagina(r.empNome, '<h1>Escolha a data</h1><p>Toque em voltar e escolha o dia no calendário.</p>'), 400);
        r.resposta = { escolha: esc1, data: esc1 === 'data' ? data : '', texto, em: Date.now() };
        await env.AGENDA.put('rsp:' + id, JSON.stringify(r), { expirationTtl: Math.max(60, Math.round((r.expira - Date.now()) / 1000)) });
        await env.AGENDA.put('rspn:' + r.empresa + ':' + Date.now() + ':' + id, '1', { expirationTtl: 60 * 60 * 24 * 30 });
        const txt = OPC.find(o => o[0] === esc1)[1].replace(/:$/, '') + (esc1 === 'data' ? ' ' + data.split('-').reverse().join('/') : '');
        return H(pagina(r.empNome, `<h1>Obrigado${r.cliente ? ', ' + esc(r.cliente.split(' ')[0]) : ''}!</h1><div class="ok"><b>${esc(r.empNome || 'A empresa')}</b> recebeu a sua resposta: <b>${esc(txt)}</b>.</div><p class="m">Se mudar de ideia, abra este link de novo e responda outra vez.</p>`));
      }
      const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10), ja = r.resposta;
      return H(pagina(r.empNome, `<h1>${esc(r.empNome || 'Resposta')}</h1><p class="m">${esc(r.titulo)}</p><p><b>${esc(PERG)}</b></p>${ja ? '<p class="m">Você já respondeu. Pode mudar a resposta abaixo.</p>' : ''}<form method="post">${OPC.map(([k, t], i) => `<label><input type="radio" name="escolha" value="${k}"${i === 0 ? ' checked' : ''}> ${esc(t)}</label>${k === 'data' ? `<input type="date" name="data" min="${hoje}">` : ''}`).join('')}<p class="m" style="margin-bottom:0">Quer deixar um recado? (opcional)</p><textarea name="texto" rows="3" maxlength="600"></textarea><button type="submit">Enviar resposta</button></form>${r.empTel ? `<p class="m">Dúvidas: ${esc(r.empTel)}</p>` : ''}`));
    }

    // Agenda Google da empresa
    if (rota.startsWith('/google/')) {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (!env.GOOGLE_ID || !env.GOOGLE_SECRET || !env.AGENDA) return json({ erro: 'Falta configurar a agenda Google na ponte (segredos GOOGLE_ID e GOOGLE_SECRET e o KV AGENDA — manual da nuvem, passo A5).', code: 'sem-google' });
      const sistemaOk = s => /^[a-z0-9-]{2,30}$/.test(s || '');
      if (rota === '/google/inicio' && req.method === 'POST' && liberada) {
        let b = {}; try { b = await req.json(); } catch { }
        if (!empresa || !sistemaOk(b.sistema) || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ erro: 'Entre no sistema da empresa antes de ligar a agenda.', detalhe: MOTIVO_USU }, 403);
        const volta = String(b.volta || ''); if (!volta.startsWith(ORIGENS[0] + '/')) return json({ erro: 'endereço de volta inválido' }, 400);
        const est = b64u(new TextEncoder().encode(JSON.stringify({ e: empresa, s: b.sistema, v: volta, t: Date.now() })));
        const state = est + '.' + await assinar(est, env.GOOGLE_SECRET);
        const p = new URLSearchParams({ client_id: env.GOOGLE_ID, redirect_uri: url.origin + '/google/retorno', response_type: 'code', scope: 'https://www.googleapis.com/auth/contacts openid email', access_type: 'offline', prompt: 'consent', include_granted_scopes: 'true', state });
        const e = await empresaCfg(empresa, b.sistema); if (e.login) p.set('login_hint', e.login);
        return json({ url: 'https://accounts.google.com/o/oauth2/v2/auth?' + p });
      }
      if (rota === '/google/retorno' && req.method === 'GET') {
        const [est, sig] = String(url.searchParams.get('state') || '').split('.');
        let st = null; try { if (est && sig === await assinar(est, env.GOOGLE_SECRET)) st = JSON.parse(new TextDecoder().decode(de64u(est))); } catch { }
        if (!st || Date.now() - st.t > 15 * 60e3) return new Response('Pedido vencido. Volte ao sistema e toque de novo em Ligar agenda do Google.', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
        const volta = (ok, msg) => Response.redirect(st.v + '#google=' + (ok ? 'ok' : 'erro') + (msg ? '&msg=' + encodeURIComponent(msg) : ''), 302);
        if (!url.searchParams.get('code')) return volta(false, 'autorização cancelada');
        const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ code: url.searchParams.get('code'), client_id: env.GOOGLE_ID, client_secret: env.GOOGLE_SECRET, redirect_uri: url.origin + '/google/retorno', grant_type: 'authorization_code' }) });
        const j = await r.json(); if (!j.refresh_token) return volta(false, 'o Google não liberou o acesso permanente; tente de novo');
        let email = ''; try { email = JSON.parse(new TextDecoder().decode(de64u(j.id_token.split('.')[1]))).email || ''; } catch { }
        const e = await empresaCfg(st.e, st.s);
        if (e.login && email && email.toLowerCase() !== String(e.login).toLowerCase()) return volta(false, 'entre com o Gmail da empresa (' + e.login + '), não com ' + email);
        await env.AGENDA.put('rt:' + st.e, JSON.stringify({ rt: await cifrar(j.refresh_token, env.GOOGLE_SECRET), email, em: Date.now() }));
        CACHE_TOK.delete(st.e); return volta(true);
      }
      if (rota === '/google/api' && req.method === 'POST' && liberada) {
        let b = {}; try { b = await req.json(); } catch { }
        if (!empresa || !sistemaOk(b.sistema) || !(await usuarioOk(empresa, b.sistema, b.idToken))) return json({ erro: 'Sem permissão: entre no sistema da empresa.', detalhe: MOTIVO_USU }, 403);
        try { return json(await agenda(env, empresa, String(b.acao || ''), b.dados || {})); } catch (x) { return json({ erro: String(x.message || x) }, 502); }
      }
      return json({ erro: 'rota inválida' }, 404);
    }

    // Senha mestre do desenvolvedor: confere aqui, sem a senha ir para o código do aplicativo
    if (url.pathname.replace(/\/+$/, '') === '/mestre') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (req.method !== 'POST' || !liberada) return json({ mestre: true, ok: false }, 403);
      if (!env.MESTRE) return json({ mestre: true, ok: false, falta: true });
      let senha = '';
      try { senha = String((await req.json()).senha || ''); } catch { }
      const ok = senha.length > 0 && await iguais(senha, env.MESTRE);
      if (!ok) await new Promise(r => setTimeout(r, 1500));
      return json({ mestre: true, ok });
    }

    // v7.8 — Pesquisa em segundo plano: o aplicativo busca a resposta que a ponte terminou e guardou
    if (rota === '/job/ping') return json({ job: true, kv: !!env.AGENDA, versao: 1 });
    if (rota === '/job/ver') {
      if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
      if (req.method !== 'POST' || !liberada || !chave || !env.AGENDA) return json({ job: true, ok: false }, 403);
      let b = {}; try { b = await req.json(); } catch { }
      const id = String(b.job || ''); if (!/^[A-Za-z0-9_-]{16,64}$/.test(id)) return json({ job: true, ok: false }, 400);
      const v = await env.AGENDA.get('job:' + empresa + ':' + id); if (!v) return json({ job: true, ok: false });
      try { return json({ job: true, ok: true, ...JSON.parse(v) }); } catch { return json({ job: true, ok: false }); }
    }

    // Teste: abra o endereço da ponte no navegador, com ?empresa=CODIGO no final
    if (req.method === 'GET') {
      const txt = (!empresa
        ? 'Ponte funcionando. Para testar uma empresa, acrescente ?empresa=CODIGO ao endereço.'
        : chave
          ? 'Ponte funcionando: chave da empresa ' + empresa + ' configurada.'
          : 'FALTA o segredo KEY_' + empresa + ' nesta ponte.')
        + '\n' + await (async () => { const p = String(env.MODELO || MODELO_PADRAO); let a = null; try { a = empresa && env.AGENDA ? JSON.parse((await env.AGENDA.get('modelo:' + empresa)) || 'null') : null; } catch { } return 'Modelo da IA: ' + p + (env.MODELO ? '' : ' (automático: sempre o Flash mais novo)') + (a && a.de === p ? ' — trocado sozinho para ' + a.nome + ' em ' + new Date(a.em).toLocaleDateString('pt-BR') : '') + await (async () => { let t = null; try { t = empresa && env.AGENDA ? JSON.parse((await env.AGENDA.get('modelo-tmp:' + empresa)) || 'null') : null; } catch { } return t && t.de === p ? ' — por 1 hora usando ' + t.nome + ' (o principal estava sobrecarregado ou sem limite)' : ''; })() + ' · ponte versão ' + PONTE_VERSAO + '.'; })()
        + '\n' + (env.MESTRE ? 'Senha mestre: configurada.' : 'Senha mestre: FALTA o segredo MESTRE.')
        + '\n' + (env.AGENDA ? 'Pesquisa em segundo plano: ok (versão 7.8).' : 'Pesquisa em segundo plano: FALTA o KV AGENDA.')
        + '\n' + (env.AGENDA ? 'Documentos por link (PDF no WhatsApp): ok.' : 'Documentos por link: FALTA o KV AGENDA.')
        + '\n' + (env.AGENDA && (env.BANCO_SEGREDO || env.MESTRE) ? 'Boleto bancário: pronto para guardar as chaves dos bancos (versão 6).' : 'Boleto bancário: FALTA o KV AGENDA ou o segredo BANCO_SEGREDO/MESTRE.')
        + '\n' + (env.GOOGLE_ID && env.GOOGLE_SECRET && env.AGENDA ? 'Agenda Google: configurada.' : 'Agenda Google: FALTA ' + [!env.GOOGLE_ID && 'GOOGLE_ID', !env.GOOGLE_SECRET && 'GOOGLE_SECRET', !env.AGENDA && 'o KV AGENDA'].filter(Boolean).join(', ') + '.');
      return new Response(txt, { headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
    if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
    if (req.method !== 'POST' || !liberada || !chave) {
      return new Response('Acesso negado', { status: 403, headers: cors });
    }

    let corpo;
    try { corpo = await req.json(); }
    catch { return new Response('Pedido inválido', { status: 400, headers: cors }); }

    /* v7.8: com ?job=, a resposta também fica guardada (1 hora) — e a ponte termina a pergunta mesmo se o aplicativo for fechado */
    const job = url.searchParams.get('job') || '', guardar = /^[A-Za-z0-9_-]{16,64}$/.test(job) && env.AGENDA;
    const pIA = chamarIA(env, empresa, chave, corpo);
    if (guardar && ctx && ctx.waitUntil) ctx.waitUntil(pIA.then(ia => ia && ia.r && ia.r.status === 200 ? env.AGENDA.put('job:' + empresa + ':' + job, JSON.stringify({ st: 200, t: ia.t, modelo: ia.modelo || '', auto: !!ia.auto, em: Date.now() }), { expirationTtl: 3600 }) : null).catch(() => { }));
    const ia = await pIA;
    return new Response(ia.t, {
      status: ia.r.status,
      headers: { ...cors, 'Content-Type': 'application/json', 'X-Bancada-Modelo': ia.modelo, 'X-Bancada-Modelo-Auto': ia.auto ? '1' : '0' }
    });
  }
};
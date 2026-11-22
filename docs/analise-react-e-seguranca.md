# Bancada Informática — Mapeamento para React e Análise de Segurança

Base analisada: versão **28.8** (build 512), branch `ccr-e8be0184-urn5qe`. Análise feita só pela leitura do código do repositório. Nada foi alterado no aplicativo.

> **O que NÃO consegui verificar** (não está no repositório): as regras do Firestore, as configurações do Cloudflare, as restrições da chave do Firebase e se o repositório é público ou privado. Os itens de segurança que dependem disso estão marcados com ⚠️ e precisam de conferência sua (instruções na Parte 3).

---

## Parte 1 — Mapa do aplicativo atual

### 1.1 Arquitetura

| Item | Situação |
|---|---|
| Arquivo principal | `index.html` — 24.029 linhas, 3,8 MB |
| CSS | linhas 1–1985 (embutido) |
| JavaScript | linhas ~1987–24028 (um único `<script>`), ~1.500 funções |
| Framework | nenhum. JavaScript puro |
| Estado | um objeto global `S` (`S.clientes`, `S.vendas`, `S.os`…) |
| Telas | funções que montam texto HTML (510 usos de `innerHTML`) e funções `esc()` (2.344 usos) para proteger o texto |
| Eventos | botões com `data-act="..."` (1.130) ligados a um dicionário `ACT['...']` (442 entradas) |
| Navegação | 18 telas (`NAV`): Início, Agenda, OS, Vendas, Caixa, Contas a receber, Contas a pagar, Faturamento, Relatórios, Orçamentos, Aluguéis, Contratos, Clientes, Fornecedores, Produtos, Empresa, Funcionários, Configurações |
| Janelas | `openModal(...)` — quase todo formulário abre numa janela |
| Dados | Firebase **Firestore** (via `fbAdapter`), com cópia local (`localStorage` + persistência offline do Firestore) |
| Login | Firebase Auth (e-mail/senha da empresa) + login de "aparelho" anônimo autorizado pelo administrador + login de operador (usuário/senha dentro do app) |
| PWA | `sw.js` (cache da casca), `manifest.webmanifest`, `empresas/<codigo>.json` com a configuração de cada empresa |
| Serviços de apoio | `ponte-ia/worker.js` (531 linhas) e `ponte-busca/worker.js` (127 linhas), Cloudflare Workers |
| Bibliotecas externas | Firebase (versão compat), html2pdf, html2canvas, xlsx, jsbarcode, qrcode-generator, zxing, tesseract.js, face-api, mammoth, pdf.js (todas por CDN) |

Coleções do banco: `clientes, fornecedores, produtos, orcamentos, vendas, alugueis, caixas, os, fotos, equipe, convites, despesas, ajustes, receber, agenda, contratos, atendimentos, lixeira, logs, checklists, autorizacoes, envios`.

### 1.2 Módulos e tamanho (linhas aproximadas) — base para a ordem da migração

**Núcleo (tem que vir primeiro, todo o resto depende dele)**

| Módulo | Linhas | Obs. |
|---|---|---|
| Utilidades (`esc`, `num`, `brl`, datas) | ~70 | fácil, vira funções TypeScript puras |
| Estado e armazenamento (`S`, `COLS`, `save`, fila offline, numeração sem repetição) | ~320 | **coração do app**; precisa de testes antes de mexer |
| Render, modais, avisos (`render`, `openModal`, `toast`) | ~350 | vira o "esqueleto" React (rotas, janelas) |
| Regras de negócio (cálculos de venda, caixa, juros) | ~160 | extrair como funções puras e **testar** |
| Conexão Firebase, login, acesso por aparelho (22531–23470) | ~900 | reescrever com cuidado (segurança) |
| Níveis de acesso e login de operador | ~300 | reescrever (ver Parte 2) |

**Telas principais (migrar uma a uma)**

| Tela / módulo | Linhas | Dificuldade |
|---|---|---|
| Clientes, Fornecedores, Produtos | ~650 | baixa — bom para começar |
| Empresa, Funcionários | ~500 | média |
| Orçamentos + linhas de itens | ~600 | média |
| Ordens de serviço (OS) | ~650 + laudo/equipamentos ~600 | **alta** (é a tela mais usada) |
| Vendas / PDV, pagamento, PIX, crediário, carnê, boleto | ~1.500 | **alta** (dinheiro) |
| Caixa (abrir/fechar, sangria, reforço) | ~500 | **alta** |
| Contas a receber / pagar, remuneração | ~1.200 | média/alta |
| Aluguéis e contratos de serviço | ~1.300 | alta |
| Relatórios e faturamento | ~900 | média |
| Agenda e aniversários | ~700 | média |
| Configurações | ~700 | média |

**Funções transversais (cada uma vira um serviço/componente)**

| Função | Linhas | Obs. |
|---|---|---|
| Ações (`ACT`) — o maior bloco | 1.109 | vira os "manipuladores" dos componentes |
| Filtros padrão de todas as listas | 1.066 | vira **um** componente de lista reutilizável (maior ganho de simplificação) |
| Impressão / PDF / Excel / etiquetas / térmica Bluetooth | ~1.800 | media; depende de APIs do navegador |
| Câmera: código de barras, OCR, fotos, assinatura, biometria, rosto | ~1.800 | média/alta; bibliotecas pesadas |
| IA, pesquisa de produtos, base própria de produtos | ~1.600 | média; fala com os workers |
| Importar/exportar dados, lixeira, log de uso | ~800 | média |
| Planos, manual embutido, modelos de texto | ~1.300 | baixa/média |
| Alertas fora do app, WhatsApp, Agenda Google | ~1.000 | média |

### 1.3 Como cada peça atual vira React

| Hoje | Em React |
|---|---|
| `S` global + `render()` completo | store (Zustand) + componentes que só redesenham o que mudou |
| Texto HTML com `${...}` e `esc()` | JSX (o React protege contra XSS por padrão; some a necessidade de `esc()`) |
| `data-act` + `ACT[...]` | `onClick` direto nos componentes |
| `openModal(...)` | componente `<Modal>` com rotas/estado |
| 22 coleções no `fbAdapter` | camada `services/db` + hooks (`useColecao('clientes')`) |
| CSS único de 2.000 linhas | manter como está no início (arquivo `.css`), depois dividir por tela |
| Bibliotecas por CDN | `npm` (versão fixa, sem depender de CDN, com cache do PWA) |

### 1.4 Riscos específicos da migração

1. **Funciona offline e com fila de gravação.** Há lógica delicada: gravar sem internet, numeração sem repetir (`0011-B`), gravações pendentes. Se isso quebrar, aparece como dado errado em loja.
2. **Código de "remendos" acumulados** (regras como `b397`, `v345`, `27.6 REGRA`): cada uma resolve um problema real visto em campo. Em reescrita, esses detalhes se perdem. Por isso o plano recomenda **migração por etapas com comparação**, não reescrita total.
3. **Monkey-patching de `MutationObserver`/`addEventListener`** (diagnóstico de travas, linhas ~1990–2010): em React deve ser removido ou virar ferramenta de desenvolvimento.
4. **Sem testes automáticos.** Antes de migrar, é preciso criar testes das regras de negócio (juros, troco, caixa, remuneração). Sem isso não dá para provar que o novo faz o mesmo que o antigo.
5. **Cliente real em produção** (RK Informática). Nada pode ir ao ar sem passar por uma versão paralela.

### 1.5 Estimativa honesta de esforço

Não consigo prometer prazo exato. Uma estimativa com base no tamanho (≈22 mil linhas de JS):

| Etapa | Conteúdo | Sessões de trabalho (estimativa) |
|---|---|---|
| 0 | Testes das regras de negócio + congelar comportamento atual | 1–2 |
| 1 | Projeto Vite + React + TS, Firebase, PWA, login, esqueleto | 1–2 |
| 2 | Telas simples (clientes, fornecedores, produtos, empresa) | 2–3 |
| 3 | Orçamentos, OS | 3–4 |
| 4 | Vendas, caixa, contas | 3–5 |
| 5 | Aluguéis, contratos, relatórios, agenda | 3–4 |
| 6 | Câmera, impressão, IA, importações | 3–4 |
| 7 | Testes finais em paralelo com o app antigo e troca | 2 |
| **Total** | | **≈ 18–26 sessões** (faixa ampla; depende do quanto o app muda no meio do caminho) |

**Ponto importante:** o app atual continua sendo atualizado (versões 28.4 → 28.8 em poucos dias). Cada mudança nova no `index.html` precisa ser repetida no React. O ideal é **congelar novas funções** durante a migração, ou migrar só módulos que você não esteja mexendo.

### 1.6 Alternativa mais barata (recomendo considerar primeiro)

Em vez de ir direto ao React: **dividir o `index.html` em módulos** (um arquivo por bloco acima, usando Vite, ainda sem React). Isso resolve ~70% da dor de manutenção (arquivo gigante, CDN sem versão fixa/SRI, sem testes) com risco bem menor, e deixa o caminho aberto para React tela por tela depois.

---

## Parte 2 — Análise de segurança

Escala: 🔴 alta · 🟠 média · 🟡 baixa. ⚠️ = depende de algo que não está no repositório.

### 🔴 S1. Permissões e login de operador só existem no navegador ⚠️

- Ao entrar com o login da empresa, o app define `S.isAdmin = true` (linha 22691) para qualquer usuário autenticado. As 24 permissões (`PERMS`: cancelar venda, ver custos, excluir, exportar…) e o login de operador (`S.op`) são **verificados em JavaScript no aparelho**.
- Quem tiver acesso aos dados pode, com o console do navegador, ignorar essas travas, **a menos que as regras do Firestore também as imponham**. As regras não estão no repositório; o app só cita o "passo B6 do manual da nuvem".
- **Impacto:** funcionário com um aparelho autorizado poderia cancelar vendas, ver custos, exportar clientes, apagar dados.

### 🔴 S2. Senhas/PINs de operador com proteção fraca

- `hashPin()` (linha 3307): SHA-256 de `'bancada:' + PIN`, **sem sal individual e sem repetição**. Em caso de falha do `crypto.subtle`, usa um hash de 32 bits (`'x'+número`), trivial de quebrar.
- Os hashes ficam no Firestore (`equipe.senhaHash`, `pinHash` das configurações) e são **baixados para todos os aparelhos** (`contasLogin()`), onde a conferência é feita.
- PIN de 4–6 dígitos = no máximo 1 milhão de tentativas; um computador comum quebra isso em menos de 1 segundo. Qualquer pessoa que consiga ler o documento da equipe descobre as senhas de todos, inclusive do administrador ("senha geral").

### 🟠 S3. `ponte-busca` aberta para a internet

- `Access-Control-Allow-Origin: *`; a proteção é só um segredo compartilhado `X-Chave`, que o aplicativo guarda em `ajustes/busca-cfg` no Firestore (legível por todo usuário da empresa) e envia do navegador.
- Sem identificação de empresa/usuário e **sem limite de uso**. Vazou a chave → qualquer um gasta seu plano do Firecrawl/Brave/Vision e usa o worker para ler páginas.
- Em comparação, o `ponte-ia` está bem feito: aceita só a origem do GitHub Pages e confere a assinatura do login do Firebase.

### 🟠 S4. Bibliotecas de terceiros sem verificação (cadeia de suprimentos)

- 12 bibliotecas carregadas de CDN **sem `integrity` (SRI)** e **sem Content-Security-Policy**. Se uma delas for comprometida, roda dentro do app com acesso a todos os dados da empresa e ao login.
- O `sw.js` guarda essas bibliotecas em cache "primeiro do cache", o que prolonga o problema se uma cópia ruim for guardada.
- Com 510 usos de `innerHTML`, qualquer `esc()` esquecido vira XSS armazenado (um cliente com nome malicioso executando código no navegador do administrador). O padrão `esc()` é bem aplicado (2.344 usos), mas depende de disciplina humana em 22 mil linhas.

### 🟠 S5. Um segredo para tudo no `ponte-ia`

- A "senha mestre" (`MESTRE`) vale para **todas as empresas** e também serve de reserva para `BANCO_SEGREDO`, que embaralha as chaves dos bancos (boletos). Vazou um, vazam os dois.
- Há também a chave de IA por empresa (`KEY_<CODIGO>`), o que é bom.

### 🟡 S6. Outros pontos

| Item | Situação | Ação |
|---|---|---|
| Configuração Firebase no repositório (`empresas/*.json`) | A `apiKey` do Firebase é pública por natureza (não é segredo), mas **sem restrição** vira porta aberta | restringir a chave por domínio, ativar App Check ⚠️ |
| E-mail de login da empresa no repositório | exposição pequena, mas é dado da empresa | verificar se o repositório é privado ⚠️ |
| Dados completos em `localStorage` (`bancada-dados-v1`) | em computador compartilhado, o próximo usuário do navegador pode ler | opção "aparelho compartilhado" que não guarda cópia local; limpar ao sair |
| Filtro anti-SSRF do `/img/ver` | bloqueia `localhost/10./192.168./169.254.`, mas não `172.16–31.`, IPv6 nem endereços numéricos; risco baixo no Cloudflare Workers (não alcança rede interna) | trocar por validação por lista de IP privados completa |
| Autenticação anônima para aparelhos | segura só se as regras exigirem que o aparelho esteja "liberado" ⚠️ | conferir nas regras |
| Código de diagnóstico em produção (remendo de `MutationObserver`) | não é falha de segurança, é risco de estabilidade | remover/condicionar a modo de desenvolvedor |

### O que está bom

- `ponte-ia` restringe a origem, valida a assinatura do token do Firebase e exige usuário aprovado.
- Chaves de IA e dos bancos ficam no servidor, nunca no navegador.
- Nenhuma chave secreta encontrada no `index.html` (a busca por padrões de chaves não achou nenhuma).
- Sem `eval`/`new Function`; `esc()` muito usado.
- Redirecionamento do Google OAuth só aceita o domínio do app.

---

## Parte 3 — Plano de ação, passo a passo (em ordem de prioridade)

### Fase 0 — Conferências sem mexer em código (você faz no console; ~1 hora)

1. **Repositório privado?** No GitHub → Settings → "Danger Zone". Se for público, os dados de `empresas/` (e-mail, IDs do Firebase) estão visíveis. Repositório privado não impede o GitHub Pages de funcionar em plano pago; se ficar público, mantenha só o necessário.
2. **Copie as regras do Firestore** (Firebase Console → Firestore Database → Regras) e me envie. Esta é a peça mais importante: só com elas consigo dizer se S1 é real.
3. **Chave de API do Firebase:** Google Cloud Console → APIs e serviços → Credenciais → abrir a "Browser key" → "Restrições de aplicativo: sites HTTP" → permitir só `https://bancada-sistemas.github.io/*`.
4. **Alertas de orçamento** no Firebase (plano Blaze, se usar) e nos workers do Cloudflare.
5. **Ativar o Firebase App Check** (reCAPTCHA Enterprise ou v3) para que só o seu aplicativo consiga falar com o banco.

### Fase 1 — Regras do Firestore (resolve S1)

1. Com as regras atuais em mãos, listar quem pode ler/gravar cada coleção.
2. Escrever regras por **papel**: uma "função de regras" lê o papel do usuário (`equipe/{uid}`) e exige a permissão certa para cada gravação (ex.: só `cancelar` altera `vendas.status`; só `excluir` apaga; `custos` para ler `despesas`).
3. Testar no **emulador do Firebase** (`firebase emulators:start`) com casos reais antes de publicar.
4. Publicar primeiro em uma empresa de teste; depois na RK Informática.

> Só vale a pena endurecer a interface depois que as regras estiverem no servidor. Sem isso, qualquer permissão no app é cosmética.

### Fase 2 — Senhas dos operadores (resolve S2)

Escolha uma das opções (recomendo A):

- **A. Sair do hash no cliente.** Cada operador passa a ter um **usuário real do Firebase Auth** (e-mail/senha ou o PIN verificado por uma função no worker). O hash nunca desce para o aparelho. As regras (Fase 1) usam o `uid` real.
- **B. Mínimo viável:** trocar por PBKDF2 (≥ 200 mil iterações) com sal individual e não baixar os hashes dos outros usuários. Mantém o desenho atual, mas ainda deixa o PIN curto frágil.

Em ambos: exigir PIN de pelo menos 6 dígitos e bloqueio após tentativas erradas (no servidor).

### Fase 3 — `ponte-busca` (resolve S3)

1. Copiar de `ponte-ia` o `usuarioOk(empresa, sistema, idToken)`.
2. Trocar `Access-Control-Allow-Origin: *` pela mesma lista `ORIGENS` do `ponte-ia`.
3. Remover o `X-Chave` guardado no banco; usar só o token do usuário.
4. Limite por empresa (por exemplo, 200 pesquisas/dia, guardado no KV).
5. Se possível, **fundir as duas pontes em uma só**, ou compartilhar um módulo de verificação.

### Fase 4 — Cadeia de suprimentos (resolve S4)

1. Curto prazo: adicionar `integrity="sha384-…"` e `crossorigin="anonymous"` nas 12 bibliotecas e um `Content-Security-Policy` por meta tag (`script-src` restrito a `'self'` + `www.gstatic.com` + os CDNs usados).
2. Longo prazo (**vem de graça com o Vite/React**): instalar as bibliotecas via `npm`, empacotar com o app, sem CDN, com `package-lock.json` e `npm audit` a cada versão.

### Fase 5 — Rotina contínua

- `npm audit` e Dependabot no GitHub.
- Separar `MESTRE` de `BANCO_SEGREDO` (Cloudflare → Variables and Secrets) e trocar a senha mestre periodicamente.
- Registro de acesso (já existe o "log de uso") enviado também para fora do banco da empresa.

---

## Parte 4 — Plano recomendado (React + segurança juntos)

1. **Agora (sem risco):** Fase 0 e Fase 1. Resolvem o mais grave sem tocar no app.
2. **Em seguida:** Fases 2 e 3 (mudanças pequenas e isoladas).
3. **Decisão:** modularizar com Vite (1.6) primeiro ou ir direto ao React (Parte 1). Eu recomendo modularizar primeiro; ele cobre SRI/CSP e abre espaço para testes automáticos.
4. **Migração React tela por tela**, na ordem da tabela 1.2, sempre com o app antigo funcionando em paralelo.

## Próximo passo sugerido

Me envie as **regras do Firestore atuais** (cole aqui). Com elas eu confirmo ou descarto o risco S1 e escrevo as regras novas.

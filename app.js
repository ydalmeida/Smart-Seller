/* ============================================================
   Smart Seller — App principal
   Lógica: CNPJ → BrasilAPI → scoring → Top 5 → IA Groq (opcional)
   ============================================================ */

// =========================================================
// ESTADO GLOBAL
// =========================================================
const ADMIN_EMAIL = 'diogokarita547@gmail.com';
const ADMIN_SENHA = 'Arcom2026';

const STATE = {
  user: null,        // {email, uid, role: 'admin' | 'consultor'}
  produtos: [],
  historico: [],
  config: {
    // Firebase — deixe vazio para usar o modo local (login funciona 100% sem Firebase).
    // Quando criar o projeto no console.firebase.google.com, cole as credenciais em
    // Configurações → Firebase, e o login real + sync entre dispositivos passam a funcionar.
    firebase: {
      apiKey: "",
      authDomain: "",
      projectId: "",
      storageBucket: "",
      messagingSenderId: "",
      appId: ""
    },
    groq: { apiKey: '', modelo: 'llama-3.1-70b-versatile' },
    pesos: { cnae: 50, regiao: 30, prioridade: 10, keywords: 10 }
  }
};

const STORAGE_KEYS = {
  config: 'cda_top5_config_v1',
  produtos: 'cda_top5_produtos_v1',
  // Histórico é por usuário (chave dinâmica via historicoKey())
  historicoLegacy: 'cda_top5_historico_v1',
  users: 'cda_top5_users_v1'
};

// Cada usuário tem sua própria chave de histórico no localStorage.
// Isso garante que o histórico de consultas seja individual e privado.
function historicoKey() {
  const uid = (STATE.user && STATE.user.uid) ? STATE.user.uid : 'anon';
  return `cda_top5_historico_${uid}`;
}

// 'firebase' = login real + sync | 'local' = login funciona só neste navegador
let APP_MODE = 'local';

function isAdmin() { return STATE.user?.role === 'admin'; }

// =========================================================
// UTILITÁRIOS
// =========================================================
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => Array.from(el.querySelectorAll(s));

function toast(msg, tipo = 'success') {
  const box = $('#toastBox');
  const t = document.createElement('div');
  t.className = `toast ${tipo}`;
  const icon = { success: 'check-circle', error: 'circle-xmark', info: 'circle-info' }[tipo] || 'circle-info';
  t.innerHTML = `<i class="fa-solid fa-${icon}"></i> ${msg}`;
  box.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transform = 'translateX(100%)'; setTimeout(() => t.remove(), 300); }, 3500);
}

function salvarLocal() {
  localStorage.setItem(STORAGE_KEYS.config, JSON.stringify(STATE.config));
  localStorage.setItem(STORAGE_KEYS.produtos, JSON.stringify(STATE.produtos));
  // Histórico é salvo por usuário para que cada um veja apenas as suas consultas
  localStorage.setItem(historicoKey(), JSON.stringify(STATE.historico));
  // Se estiver logado e online, sincroniza com Firestore em background
  if (firebaseDb && STATE.user) {
    salvarNoFirestore();
  }
}

function carregarLocal() {
  try {
    const cfg = localStorage.getItem(STORAGE_KEYS.config);
    if (cfg) Object.assign(STATE.config, JSON.parse(cfg));
    const prods = localStorage.getItem(STORAGE_KEYS.produtos);
    if (prods) STATE.produtos = JSON.parse(prods);
    // Migração única do histórico legado (chave global) para a chave do admin local,
    // caso o usuário já tenha consultas salvas pela versão antiga do app.
    const legacyHist = localStorage.getItem(STORAGE_KEYS.historicoLegacy);
    const myKey = historicoKey();
    if (legacyHist && !localStorage.getItem(myKey)) {
      try {
        const parsed = JSON.parse(legacyHist);
        if (Array.isArray(parsed) && parsed.length) {
          localStorage.setItem(myKey, JSON.stringify(parsed));
        }
      } catch {}
    }
    const hist = localStorage.getItem(myKey);
    if (hist) STATE.historico = JSON.parse(hist);
  } catch (e) { console.warn('Erro ao carregar local:', e); }
}

// =========================================================
// USUÁRIOS LOCAIS (modo sem Firebase)
// Apenas o admin fixo pode cadastrar consultores no navegador.
// Senhas são armazenadas em base64 — é só ofuscação, não segurança real.
// Funciona enquanto o Firebase não está configurado.
// =========================================================
function getLocalUsers() {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEYS.users) || '[]'); }
  catch { return []; }
}
function setLocalUsers(arr) {
  localStorage.setItem(STORAGE_KEYS.users, JSON.stringify(arr));
}
function ofuscarSenha(s) {
  // Ofuscação simples — apenas para não exibir em texto puro no localStorage.
  // NUNCA use isso em produção real; aqui só serve pro modo local.
  try { return btoa(unescape(encodeURIComponent(s))); } catch { return s; }
}
function verificarSenhaLocal(s, hash) {
  return ofuscarSenha(s) === hash;
}

function mascaraCNPJ(v) {
  v = v.replace(/\D/g, '').slice(0, 14);
  v = v.replace(/^(\d{2})(\d)/, '$1.$2');
  v = v.replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3');
  v = v.replace(/\.(\d{3})(\d)/, '.$1/$2');
  v = v.replace(/(\d{4})(\d)/, '$1-$2');
  return v;
}

function fmtBRL(n) {
  return n.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
}

function fmtData(iso) {
  return new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function getId() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

// =========================================================
// TEMA (claro/escuro)
// =========================================================
function initTema() {
  const t = localStorage.getItem('cda_top5_tema') || 'dark';
  document.documentElement.setAttribute('data-theme', t);
}
$('#btnTema').addEventListener('click', () => {
  const atual = document.documentElement.getAttribute('data-theme');
  const novo = atual === 'dark' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', novo);
  localStorage.setItem('cda_top5_tema', novo);
});

// =========================================================
// PARTÍCULAS (fundo)
// =========================================================
(function initParticulas() {
  const canvas = $('#particleCanvas');
  const ctx = canvas.getContext('2d');
  let w, h, particles = [];
  function resize() { w = canvas.width = innerWidth; h = canvas.height = innerHeight; }
  function criar() {
    particles = [];
    const n = Math.min(60, Math.floor((w * h) / 25000));
    for (let i = 0; i < n; i++) {
      particles.push({
        x: Math.random() * w, y: Math.random() * h,
        vx: (Math.random() - 0.5) * 0.3, vy: (Math.random() - 0.5) * 0.3,
        r: Math.random() * 1.5 + 0.5, a: Math.random() * 0.3 + 0.1
      });
    }
  }
  function draw() {
    ctx.clearRect(0, 0, w, h);
    const dark = document.documentElement.getAttribute('data-theme') === 'dark';
    particles.forEach(p => {
      p.x += p.vx; p.y += p.vy;
      if (p.x < 0 || p.x > w) p.vx *= -1;
      if (p.y < 0 || p.y > h) p.vy *= -1;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fillStyle = dark ? `rgba(186,230,79,${p.a})` : `rgba(0,120,64,${p.a * 0.6})`;
      ctx.fill();
    });
    requestAnimationFrame(draw);
  }
  resize(); criar(); draw();
  addEventListener('resize', () => { resize(); criar(); });
})();

// =========================================================
// FIREBASE (opcional — funciona só se preencher credenciais REAIS)
// =========================================================
let firebaseApp = null, firebaseAuth = null, firebaseDb = null;

// Detecta se a config do Firebase é placeholder (chave de exemplo) ou está vazia.
// Se for, NÃO inicializa o Firebase — o app cai automaticamente no modo local.
function firebaseConfigValida(c) {
  if (!c) return false;
  if (!c.apiKey || !c.projectId) return false;
  // apiKey real do Firebase começa com "AIzaSy" e tem ~39 caracteres
  if (!c.apiKey.startsWith('AIzaSy') || c.apiKey.length < 30) return false;
  // Rejeita placeholders conhecidos usados em exemplos
  const placeholders = ['abcdef123456', 'BnqWPn9Z_VV_5dSJMnL0bfXt6wHp4bAuA', 'YOUR_API_KEY'];
  if (placeholders.includes(c.apiKey)) return false;
  return true;
}

function initFirebase() {
  const c = STATE.config.firebase;
  if (!firebaseConfigValida(c)) return false;
  try {
    if (!firebase.apps.length) firebaseApp = firebase.initializeApp(c);
    else firebaseApp = firebase.app();
    firebaseAuth = firebase.auth();
    firebaseDb = firebase.firestore();
    return true;
  } catch (e) {
    console.warn('Firebase init falhou:', e);
    return false;
  }
}

// =========================================================
// AUTH
// =========================================================
function mostrarApp() {
  $('#loginOverlay').style.display = 'none';
  $('#appRoot').style.display = 'block';
  $('#userEmail').textContent = STATE.user?.email || 'modo local';
  // Garante que o histórico exibido é o do usuário que acabou de logar
  // (carregarLocal() no boot rodou com STATE.user == null e pode ter lido a chave 'anon')
  try {
    const h = localStorage.getItem(historicoKey());
    STATE.historico = h ? JSON.parse(h) : [];
  } catch { STATE.historico = []; }
  // Aplica permissões (mostra/oculta botões conforme role)
  aplicarPermissoes();
  renderProdutos(); renderHistorico(); renderConfig();
  // Indicador de modo no header (Firebase vs Local)
  const lbl = $('#fbModeLabel');
  if (lbl) {
    lbl.textContent = APP_MODE === 'firebase' ? 'Firebase (nuvem)' : 'local (este navegador)';
    lbl.style.color = APP_MODE === 'firebase' ? 'var(--green, #0a7d4a)' : 'var(--yellow, #c9a227)';
  }
  if (isAdmin()) renderUsersList();
}
function mostrarLogin() {
  $('#loginOverlay').style.display = 'flex';
  $('#appRoot').style.display = 'none';
}

function aplicarPermissoes() {
  // Mostra/esconde elementos que exigem permissão de admin
  $$('.only-admin').forEach(el => el.style.display = isAdmin() ? '' : 'none');
  // Badge de role no user chip
  const roleEl = $('#userRole');
  if (roleEl && STATE.user) {
    roleEl.textContent = isAdmin() ? 'ADMIN' : 'CONSULTOR';
    roleEl.className = `role-badge ${isAdmin() ? 'role-admin' : 'role-consultor'}`;
  }
  // Aviso da aba Produtos
  const aviso = $('#consultorAviso');
  if (aviso) aviso.style.display = isAdmin() ? 'none' : 'flex';
  // Se não for admin, força ir para a aba Consulta
  if (!isAdmin()) {
    $$('.nav-item').forEach(n => n.classList.remove('active'));
    $$('.tab-pane').forEach(t => t.classList.remove('active'));
    $('.nav-item[data-tab="consulta"]').classList.add('active');
    $('#tab-consulta').classList.add('active');
  }
}

// Busca o role do usuário no Firestore. Se não existir, cria como 'consultor'.
// O admin tem role fixo no Firestore (definido por este app).
async function carregarRoleUsuario(uid, email) {
  if (!firebaseDb) {
    // Sem Firestore, fallback por email
    return email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'consultor';
  }
  try {
    const doc = await firebaseDb.collection('usuarios').doc(uid).get();
    if (doc.exists) {
      return doc.data().role || 'consultor';
    } else {
      // Cria doc de usuário
      const role = email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'consultor';
      await firebaseDb.collection('usuarios').doc(uid).set({
        email, role, criadoEm: firebase.firestore.FieldValue.serverTimestamp()
      });
      return role;
    }
  } catch (e) {
    console.warn('Erro ao buscar role:', e);
    return email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'consultor';
  }
}

// Garante que o admin existe no Firebase Auth (cria na primeira vez)
async function garantirAdminExiste() {
  if (!firebaseAuth) return;
  try {
    // Tenta login direto
    await firebaseAuth.signInWithEmailAndPassword(ADMIN_EMAIL, ADMIN_SENHA);
    return true;
  } catch (err) {
    if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
      try {
        await firebaseAuth.createUserWithEmailAndPassword(ADMIN_EMAIL, ADMIN_SENHA);
        console.log('✓ Conta admin criada automaticamente');
        return true;
      } catch (e2) {
        console.error('Falha ao criar admin:', e2);
        return false;
      }
    }
    return false;
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const pass = $('#loginPass').value;
  const status = $('#loginStatus');
  status.textContent = 'Entrando…';

  const firebaseOk = initFirebase() && firebaseAuth;
  APP_MODE = firebaseOk ? 'firebase' : 'local';

  if (firebaseOk) {
    // ===== LOGIN VIA FIREBASE (com sync entre dispositivos) =====
    try {
      const cred = await firebaseAuth.signInWithEmailAndPassword(email, pass);
      const role = await carregarRoleUsuario(cred.user.uid, cred.user.email);
      STATE.user = { email: cred.user.email, uid: cred.user.uid, role };
      await carregarDoFirestore();
      mostrarApp();
      toast(`Bem-vindo, ${role === 'admin' ? 'Administrador' : 'Consultor'}!`, 'success');
      return;
    } catch (err) {
      if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && pass === ADMIN_SENHA) {
        try {
          const cred = await firebaseAuth.createUserWithEmailAndPassword(email, pass);
          const role = await carregarRoleUsuario(cred.user.uid, cred.user.email);
          STATE.user = { email: cred.user.email, uid: cred.user.uid, role };
          await carregarDoFirestore();
          mostrarApp();
          toast('Conta admin criada e logado!', 'success');
          return;
        } catch (e2) { status.textContent = e2.message; return; }
      }
      if (err.code === 'auth/user-not-found') {
        status.textContent = 'Usuário não encontrado.';
      } else if (err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential') {
        status.textContent = 'Senha incorreta.';
      } else if (err.code === 'auth/api-key-not-valid' || err.code === 'auth/invalid-api-key') {
        status.textContent = 'Firebase: apiKey inválida. Use o modo local ou configure em Configurações.';
      } else {
        status.textContent = err.message;
      }
      return;
    }
  }

  // ===== LOGIN LOCAL (sem Firebase) =====
  // Admin fixo
  if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && pass === ADMIN_SENHA) {
    STATE.user = { email, uid: 'local-admin', role: 'admin' };
    mostrarApp();
    toast('Bem-vindo, Administrador! (modo local)', 'success');
    return;
  }
  // Consultores cadastrados localmente
  const users = getLocalUsers();
  const u = users.find(x => x.email.toLowerCase() === email.toLowerCase());
  if (u && verificarSenhaLocal(pass, u.senhaHash)) {
    STATE.user = { email, uid: u.id, role: u.role || 'consultor' };
    mostrarApp();
    toast('Bem-vindo, Consultor! (modo local)', 'success');
    return;
  }
  // Nenhuma credencial bateu
  if (u) {
    status.textContent = 'Senha incorreta.';
  } else {
    status.textContent = 'Usuário não encontrado. Contate o administrador para criar sua conta.';
  }
});

$('#btnCriarConta').addEventListener('click', (e) => {
  e.preventDefault();
  toast('Apenas o administrador pode criar usuários. Contate diogokarita547@gmail.com para solicitar acesso.', 'info', 6000);
});

$('#btnSair').addEventListener('click', async () => {
  if (firebaseAuth) await firebaseAuth.signOut();
  STATE.user = null;
  mostrarLogin();
});

// =========================================================
// TABS
// =========================================================
$$('.nav-item').forEach(el => el.addEventListener('click', () => {
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $$('.tab-pane').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  $(`#tab-${el.dataset.tab}`).classList.add('active');
}));

// =========================================================
// CONSULTA CNPJ → BrasilAPI
// =========================================================
$('#cnpjInput').addEventListener('input', e => e.target.value = mascaraCNPJ(e.target.value));

$$('.chip[data-cnpj]').forEach(c => c.addEventListener('click', () => {
  $('#cnpjInput').value = c.dataset.cnpj;
}));

$('#btnConsultar').addEventListener('click', () => consultar());
$('#cnpjInput').addEventListener('keypress', e => { if (e.key === 'Enter') consultar(); });

async function consultar() {
  const raw = $('#cnpjInput').value.replace(/\D/g, '');
  if (raw.length !== 14) {
    $('#consultaStatus').className = 'consulta-status error';
    $('#consultaStatus').textContent = 'Informe um CNPJ válido com 14 dígitos.';
    return;
  }

  const status = $('#consultaStatus');
  status.className = 'consulta-status';
  status.textContent = 'Consultando…';
  $('#loadingBox').style.display = 'flex';
  $('#empresaBox').style.display = 'none';
  $('#top5Box').style.display = 'none';
  $('#btnConsultar').disabled = true;

  try {
    // 1) BrasilAPI
    const resp = await fetch(`https://brasilapi.com.br/api/cnpj/v1/${raw}`);
    if (!resp.ok) throw new Error('CNPJ não encontrado na Receita Federal.');
    const cnpj = await resp.json();

    // 2) Mapeia para objeto empresa
    const empresa = {
      cnpj: cnpj.cnpj,
      razao: cnpj.razao_social,
      cnae: cnpj.cnae_fiscal,
      cnaeDesc: cnpj.cnae_fiscal_descricao || (window.CNAE_DESC[cnpj.cnae_fiscal] || ''),
      uf: cnpj.uf,
      cidade: cnpj.municipio,
      bairro: cnpj.bairro,
      logradouro: `${cnpj.descricao_tipo_de_logradouro} ${cnpj.logradouro}, ${cnpj.numero}`,
      cep: cnpj.cep,
      status: cnpj.descricao_situacao_cadastral,
      porte: cnpj.porte,
      natureza: cnpj.natureza_juridica
    };

    // 3) Calcular Top 5
    const top5 = calcularTop5(empresa);

    // 4) Render
    renderEmpresa(empresa, top5.afinidade);
    renderTop5(top5.itens, empresa);
    $('#loadingBox').style.display = 'none';
    $('#empresaBox').style.display = 'block';
    $('#top5Box').style.display = 'block';

    // 5) Histórico (individual por usuário)
    STATE.historico.unshift({
      id: getId(), data: new Date().toISOString(),
      uid: STATE.user?.uid || 'anon',
      userEmail: STATE.user?.email || '—',
      cnpj: empresa.cnpj, empresa: empresa.razao, cnae: empresa.cnae, uf: empresa.uf,
      top1: top5.itens[0]?.nome || '—'
    });
    STATE.historico = STATE.historico.slice(0, 50);
    salvarLocal(); renderHistorico();

    status.className = 'consulta-status ok';
    status.textContent = `✓ ${empresa.razao} — Top 5 calculado.`;

    // 6) Enriquecer com IA Groq (em background)
    enriquecerComIA(top5.itens, empresa);
  } catch (err) {
    $('#loadingBox').style.display = 'none';
    status.className = 'consulta-status error';
    status.textContent = err.message;
  } finally {
    $('#btnConsultar').disabled = false;
  }
}

// =========================================================
// ALGORITMO DE SCORING (Top 5)
// =========================================================
function calcularTop5(empresa) {
  const w = STATE.config.pesos;
  const totalW = (w.cnae || 0) + (w.regiao || 0) + (w.prioridade || 0) + (w.keywords || 0) || 100;
  const pCnae = (w.cnae || 0) / totalW;
  const pRegiao = (w.regiao || 0) / totalW;
  const pPrio = (w.prioridade || 0) / totalW;
  const pKw = (w.keywords || 0) / totalW;

  const resultados = STATE.produtos.map(p => {
    // CNAE match: exato vale 100, raiz 5 dígitos 60, raiz 4 dígitos 30
    let cnaeScore = 0;
    if (p.cnaes) {
      const lista = p.cnaes.split(',').map(s => s.trim());
      if (lista.includes(String(empresa.cnae))) cnaeScore = 100;
      else {
        const raiz = String(empresa.cnae).slice(0, 5);
        if (lista.some(c => c.startsWith(raiz))) cnaeScore = 60;
        else {
          const raiz4 = String(empresa.cnae).slice(0, 4);
          if (lista.some(c => c.startsWith(raiz4))) cnaeScore = 30;
        }
      }
    }
    // UF match
    let regiaoScore = 0;
    if (!p.ufs || !p.ufs.trim()) regiaoScore = 50; // sem restrição = todos
    else {
      const lista = p.ufs.toUpperCase().split(',').map(s => s.trim());
      if (lista.includes(empresa.uf)) regiaoScore = 100;
    }
    // Prioridade comercial: produtos com maior "prioridade" ganham mais
    const prioScore = Math.min(100, (p.prioridade || 0));
    // Keywords (palavras do CNAE/descrição batendo com keywords do produto)
    let kwScore = 0;
    if (p.keywords) {
      const kws = p.keywords.toLowerCase().split(',').map(s => s.trim());
      const texto = `${empresa.cnaeDesc} ${empresa.natureza}`.toLowerCase();
      const hits = kws.filter(k => texto.includes(k)).length;
      kwScore = Math.min(100, hits * 33);
    }

    const score = cnaeScore * pCnae + regiaoScore * pRegiao + prioScore * pPrio + kwScore * pKw;

    // Motivo resumido
    const motivos = [];
    if (cnaeScore === 100) motivos.push('CNAE compatível');
    else if (cnaeScore > 0) motivos.push(`Setor próximo (CNAE ${cnaeScore === 60 ? 'mesma classe' : 'mesma subclasse'})`);
    if (regiaoScore === 100) motivos.push(`Atende ${empresa.uf}`);
    else if (regiaoScore === 0) motivos.push('Fora da região padrão');
    if (prioScore >= 60) motivos.push('Produto prioritário');
    if (kwScore >= 33) motivos.push('Palavras-chave compatíveis');

    return { produto: p, score: Math.round(score), cnaeScore, regiaoScore, kwScore, motivo: motivos };
  });

  // Ordena
  resultados.sort((a, b) => b.score - a.score);
  const top5 = resultados.slice(0, 5);
  const afinidade = Math.round(top5.reduce((s, r) => s + r.score, 0) / top5.length);

  return { itens: top5, afinidade };
}

// =========================================================
// RENDER EMPRESA
// =========================================================
function renderEmpresa(empresa, afinidade) {
  $('#empRazao').textContent = empresa.razao;
  $('#empCnae').textContent = `CNAE ${empresa.cnae} — ${empresa.cnaeDesc}`;
  $('#empLocal').textContent = `${empresa.cidade} / ${empresa.uf}`;
  $('#empCnpj').textContent = empresa.cnpj;
  $('#empStatus').textContent = empresa.status;
  $('#empCnaeDesc').textContent = `Porte: ${empresa.porte} • Natureza: ${empresa.natureza} • ${empresa.logradouro}`;

  // Score circle
  const circle = $('#scoreCircle');
  circle.style.setProperty('--p', afinidade + '%');
  $('#scoreValue').textContent = afinidade;
}

// =========================================================
// RENDER TOP 5
// =========================================================
function renderTop5(itens, empresa) {
  const list = $('#top5List');
  list.innerHTML = '';
  itens.forEach((it, i) => {
    const p = it.produto;
    const card = document.createElement('div');
    card.className = 'top5-card';
    // Card mostra apenas: marca, categoria e nome do produto
    const meta = `
      <span><b>${p.marca || '—'}</b></span>
      <span>${p.categoria || '—'}</span>
    `;
    card.innerHTML = `
      <div class="top5-rank">${i + 1}</div>
      <div class="top5-content">
        <h4>${p.nome}</h4>
        <div class="meta">${meta}</div>
        <div class="top5-motivo loading" id="motivo-${i}">
          <i class="fa-solid fa-circle-notch fa-spin"></i> ${it.motivo.length ? it.motivo.join(' • ') : 'Calculando explicação com IA…'}
        </div>
      </div>
      <div class="top5-actions">
        <div class="top5-score">${it.score}<small>score</small></div>
      </div>
    `;
    list.appendChild(card);
  });
}

// =========================================================
// ENRIQUECIMENTO COM IA (Groq)
// =========================================================
async function enriquecerComIA(itens, empresa) {
  if (!STATE.config.groq.apiKey) {
    itens.forEach((_, i) => {
      const m = $(`#motivo-${i}`);
      if (m) {
        m.classList.remove('loading');
        m.innerHTML = `<i class="fa-solid fa-info-circle"></i> Configure a IA Groq em <b>Configurações</b> para explicações personalizadas.`;
      }
    });
    return;
  }

  const prompt = `Você é um assistente comercial de uma distribuidora brasileira. Para a empresa abaixo, gere UMA frase curta de venda (máx 18 palavras, português BR) para CADA produto recomendado, explicando por que ele é boa opção para esse cliente.

Empresa: ${empresa.razao}
CNAE principal: ${empresa.cnae} - ${empresa.cnaeDesc}
Localização: ${empresa.cidade}/${empresa.uf}
Porte: ${empresa.porte}

Produtos recomendados:
${itens.map((it, i) => `${i + 1}. ${it.produto.nome} (${it.produto.marca || 's/marca'}) - Categoria: ${it.produto.categoria} - Descrição: ${it.produto.descricao || '—'}`).join('\n')}

Responda em JSON puro, no formato: {"1":"frase do produto 1","2":"frase do produto 2",...}`;

  try {
    const resp = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${STATE.config.groq.apiKey}`
      },
      body: JSON.stringify({
        model: STATE.config.groq.modelo || 'llama-3.1-70b-versatile',
        messages: [
          { role: 'system', content: 'Você gera frases curtas de venda em português brasileiro. Responda APENAS JSON válido.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.7,
        max_tokens: 600
      })
    });
    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    const data = await resp.json();
    const txt = data.choices?.[0]?.message?.content || '';
    // Extrai JSON
    const match = txt.match(/\{[\s\S]*\}/);
    const explicacoes = match ? JSON.parse(match[0]) : {};
    itens.forEach((_, i) => {
      const m = $(`#motivo-${i}`);
      if (m) {
        m.classList.remove('loading');
        const ex = explicacoes[i + 1];
        m.innerHTML = `<i class="fa-solid fa-sparkles" style="color:var(--lima)"></i> ${ex || 'Recomendado pelo algoritmo de scoring.'}`;
      }
    });
  } catch (e) {
    console.warn('IA falhou:', e);
    itens.forEach((_, i) => {
      const m = $(`#motivo-${i}`);
      if (m) {
        m.classList.remove('loading');
        m.innerHTML = `<i class="fa-solid fa-exclamation-triangle" style="color:var(--yellow)"></i> IA indisponível: ${e.message.slice(0, 60)}`;
      }
    });
  }
}

// =========================================================
// HISTÓRICO
// =========================================================
function renderHistorico() {
  const tb = $('#histTable tbody');
  tb.innerHTML = '';
  if (!STATE.historico.length) {
    $('#histEmpty').style.display = 'block';
    return;
  }
  $('#histEmpty').style.display = 'none';
  STATE.historico.forEach(h => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${fmtData(h.data)}</td>
      <td><code>${h.cnpj}</code></td>
      <td>${h.empresa}</td>
      <td>${h.cnae}</td>
      <td>${h.uf}</td>
      <td>${h.top1}</td>
    `;
    tb.appendChild(tr);
  });
}

// =========================================================
// PRODUTOS (CRUD)
// =========================================================
function renderProdutos() {
  // Popular filtro de categorias
  const cats = [...new Set(STATE.produtos.map(p => p.categoria).filter(Boolean))].sort();
  const sel = $('#prodFiltroCat');
  const val = sel.value;
  sel.innerHTML = '<option value="">Todas categorias</option>' + cats.map(c => `<option value="${c}">${c}</option>`).join('');
  sel.value = val;

  // Filtros
  const busca = ($('#prodBusca').value || '').toLowerCase();
  const catFiltro = sel.value;
  const filtrados = STATE.produtos.filter(p =>
    (!busca || p.nome.toLowerCase().includes(busca) || (p.marca || '').toLowerCase().includes(busca)) &&
    (!catFiltro || p.categoria === catFiltro)
  );

  // A coluna de ações só aparece para o admin (editar/excluir)
  const showActions = isAdmin();
  $$('#prodTable th.only-admin').forEach(th => th.style.display = showActions ? '' : 'none');

  const tb = $('#prodTable tbody');
  tb.innerHTML = '';
  if (!filtrados.length) {
    $('#prodEmpty').style.display = 'block';
    return;
  }
  $('#prodEmpty').style.display = 'none';
  filtrados.forEach(p => {
    const tr = document.createElement('tr');
    tr.innerHTML = `
      <td><b>${p.nome}</b></td>
      <td>${p.marca || '—'}</td>
      <td>${p.categoria || '—'}</td>
      <td>${(p.cnaes || '').split(',').slice(0, 2).join(', ')}${p.cnaes && p.cnaes.split(',').length > 2 ? '…' : ''}</td>
      <td>${p.ufs || 'Todas'}</td>
      <td class="only-admin">
        <div class="row-actions-cell">
          <button data-edit="${p.id}" title="Editar"><i class="fa-solid fa-pen"></i></button>
          <button class="danger" data-del="${p.id}" title="Excluir"><i class="fa-solid fa-trash"></i></button>
        </div>
      </td>
    `;
    tb.appendChild(tr);
  });

  if (isAdmin()) {
    $$('[data-edit]').forEach(b => b.addEventListener('click', () => editarProduto(b.dataset.edit)));
    $$('[data-del]').forEach(b => b.addEventListener('click', () => deletarProduto(b.dataset.del)));
  }
}

$('#prodBusca').addEventListener('input', renderProdutos);
$('#prodFiltroCat').addEventListener('change', renderProdutos);

$('#btnNovoProduto').addEventListener('click', () => {
  if (!isAdmin()) {
    toast('Apenas administradores podem cadastrar produtos.', 'error');
    return;
  }
  abrirModalProduto();
});

function abrirModalProduto(prod = null) {
  if (!isAdmin()) {
    toast('Apenas administradores podem editar produtos.', 'error');
    return;
  }
  $('#produtoModalTitle').textContent = prod ? 'Editar produto' : 'Novo produto';
  $('#prodId').value = prod?.id || '';
  $('#prodNome').value = prod?.nome || '';
  $('#prodMarca').value = prod?.marca || '';
  $('#prodCategoria').value = prod?.categoria || '';
  $('#prodDescricao').value = prod?.descricao || '';
  $('#prodCnaes').value = prod?.cnaes || '';
  $('#prodUfs').value = prod?.ufs || '';
  $('#prodKeywords').value = prod?.keywords || '';
  $('#produtoModal').style.display = 'flex';
}

$('#btnFecharModal').addEventListener('click', () => $('#produtoModal').style.display = 'none');
$('#btnCancelarModal').addEventListener('click', () => $('#produtoModal').style.display = 'none');

$('#produtoForm').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!isAdmin()) { toast('Acesso negado.', 'error'); return; }
  const p = {
    id: $('#prodId').value || getId(),
    nome: $('#prodNome').value.trim(),
    marca: $('#prodMarca').value.trim(),
    categoria: $('#prodCategoria').value.trim(),
    descricao: $('#prodDescricao').value.trim(),
    cnaes: $('#prodCnaes').value.trim(),
    ufs: $('#prodUfs').value.trim().toUpperCase(),
    keywords: $('#prodKeywords').value.trim()
  };
  const idx = STATE.produtos.findIndex(x => x.id === p.id);
  if (idx >= 0) STATE.produtos[idx] = p; else STATE.produtos.push(p);
  salvarLocal(); renderProdutos();
  $('#produtoModal').style.display = 'none';
  toast(idx >= 0 ? 'Produto atualizado!' : 'Produto cadastrado!', 'success');
});

function editarProduto(id) {
  if (!isAdmin()) { toast('Apenas administradores podem editar produtos.', 'error'); return; }
  const p = STATE.produtos.find(x => x.id === id);
  if (p) abrirModalProduto(p);
}
function deletarProduto(id) {
  if (!isAdmin()) { toast('Apenas administradores podem excluir produtos.', 'error'); return; }
  if (!confirm('Excluir este produto?')) return;
  STATE.produtos = STATE.produtos.filter(x => x.id !== id);
  salvarLocal(); renderProdutos();
  toast('Produto excluído.', 'info');
}

// =========================================================
// CONFIGURAÇÕES
// =========================================================
$('#btnConfigIA').addEventListener('click', () => {
  if (!isAdmin()) {
    toast('Apenas administradores podem acessar Configurações.', 'error');
    return;
  }
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $$('.tab-pane').forEach(t => t.classList.remove('active'));
  $('.nav-item[data-tab="config"]').classList.add('active');
  $('#tab-config').classList.add('active');
});

function renderConfig() {
  // Firebase
  const fb = STATE.config.firebase || {};
  $('#fb_apiKey').value = fb.apiKey || '';
  $('#fb_authDomain').value = fb.authDomain || '';
  $('#fb_projectId').value = fb.projectId || '';
  $('#fb_storageBucket').value = fb.storageBucket || '';
  $('#fb_senderId').value = fb.messagingSenderId || '';
  $('#fb_appId').value = fb.appId || '';

  // Groq
  $('#groqKey').value = STATE.config.groq.apiKey || '';
  $('#groqModel').value = STATE.config.groq.modelo || 'llama-3.1-70b-versatile';

  // Pesos
  const w = STATE.config.pesos;
  const box = $('#pesosBox');
  box.innerHTML = '';
  const pesos = [
    { k: 'cnae', label: 'CNAE compatível', desc: 'Ramo de atuação do cliente' },
    { k: 'regiao', label: 'Região (UF)', desc: 'Localização da empresa' },
    { k: 'prioridade', label: 'Prioridade comercial', desc: 'Produtos marcados como prioritários' },
    { k: 'keywords', label: 'Palavras-chave', desc: 'Match entre descrição e keywords' }
  ];
  pesos.forEach(p => {
    const div = document.createElement('div');
    div.className = 'peso-item';
    div.innerHTML = `
      <label>${p.label} <span>${w[p.k]}</span></label>
      <input type="range" min="0" max="100" value="${w[p.k]}" data-peso="${p.k}">
      <small>${p.desc}</small>
    `;
    box.appendChild(div);
  });
  $$('[data-peso]').forEach(input => input.addEventListener('input', e => {
    e.target.previousElementSibling.querySelector('span').textContent = e.target.value;
  }));
}

$('#btnSalvarFirebase').addEventListener('click', () => {
  STATE.config.firebase = {
    apiKey: $('#fb_apiKey').value.trim(),
    authDomain: $('#fb_authDomain').value.trim(),
    projectId: $('#fb_projectId').value.trim(),
    storageBucket: $('#fb_storageBucket').value.trim(),
    messagingSenderId: $('#fb_senderId').value.trim(),
    appId: $('#fb_appId').value.trim()
  };
  salvarLocal();
  // Se os campos ficaram vazios, limpa o app do Firebase e cai em modo local
  if (!firebaseConfigValida(STATE.config.firebase)) {
    firebaseApp = null; firebaseAuth = null; firebaseDb = null;
    APP_MODE = 'local';
    if (window.firebase && firebase.apps.length) {
      try { firebase.app().delete(); } catch {}
    }
    $('#fbStatus').textContent = '⚠ Modo local (Firebase não configurado)';
    toast('Configuração salva. Login segue em modo local até o Firebase ser configurado.', 'info');
    return;
  }
  // Tenta inicializar de fato
  const ok = initFirebase();
  if (ok) {
    APP_MODE = 'firebase';
    $('#fbStatus').textContent = '✓ Conectado ao Firebase';
    toast('Firebase conectado! Faça login novamente para validar.', 'success');
  } else {
    $('#fbStatus').textContent = '✗ Config inválida — verifique os dados';
    toast('Configuração salva, mas o Firebase recusou a inicialização.', 'error');
  }
});

$('#btnSalvarGroq').addEventListener('click', () => {
  STATE.config.groq.apiKey = $('#groqKey').value.trim();
  STATE.config.groq.modelo = $('#groqModel').value;
  salvarLocal();
  $('#groqStatus').textContent = '✓ Salvo';
  toast('Chave Groq salva!', 'success');
});

$('#btnTestarGroq').addEventListener('click', async () => {
  const key = $('#groqKey').value.trim();
  if (!key) { toast('Cole uma API Key primeiro.', 'error'); return; }
  $('#groqStatus').textContent = 'Testando…';
  try {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
      body: JSON.stringify({
        model: $('#groqModel').value,
        messages: [{ role: 'user', content: 'Responda apenas: ok' }],
        max_tokens: 5
      })
    });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    $('#groqStatus').textContent = '✓ Conexão OK';
    toast('Groq funcionando!', 'success');
  } catch (e) {
    $('#groqStatus').textContent = '✗ ' + e.message;
    toast('Falha: ' + e.message, 'error');
  }
});

$('#btnSalvarPesos').addEventListener('click', () => {
  $$('[data-peso]').forEach(input => {
    STATE.config.pesos[input.dataset.peso] = parseInt(input.value);
  });
  salvarLocal();
  toast('Pesos atualizados!', 'success');
});

$('#btnLimparTudo').addEventListener('click', async () => {
  if (!isAdmin()) { toast('Apenas administradores podem limpar tudo.', 'error'); return; }
  if (!confirm('Apagar TODOS os produtos, histórico e configurações deste navegador e do Firestore?')) return;
  // Apaga todas as chaves de histórico por usuário (e a legada)
  Object.keys(localStorage).forEach(k => {
    if (k.startsWith('cda_top5_historico_') || k === STORAGE_KEYS.historicoLegacy) {
      localStorage.removeItem(k);
    }
  });
  localStorage.removeItem(STORAGE_KEYS.produtos);
  localStorage.removeItem(STORAGE_KEYS.users);
  STATE.produtos = window.PRODUTOS_SEED.map(p => ({ ...p, id: getId() }));
  STATE.historico = [];
  STATE.config.pesos = { cnae: 50, regiao: 30, prioridade: 10, keywords: 10 };
  // Não apaga firebase config
  const fbBackup = STATE.config.firebase;
  STATE.config.firebase = fbBackup;
  if (firebaseDb) await salvarNoFirestore();
  salvarLocal(); renderProdutos(); renderHistorico(); renderConfig();
  toast('Tudo limpo. Produtos restaurados ao padrão.', 'info');
});

// =========================================================
// GERENCIAMENTO DE USUÁRIOS (só Admin)
// =========================================================
$('#btnCriarUser').addEventListener('click', async (e) => {
  e.preventDefault();
  if (!isAdmin()) { toast('Apenas administradores podem criar usuários.', 'error'); return; }
  const email = $('#novoUserEmail').value.trim();
  const pass = $('#novoUserPass').value;
  if (!email || pass.length < 6) { toast('Preencha email e senha (mínimo 6 caracteres).', 'error'); return; }

  $('#criarUserStatus').textContent = 'Criando…';

  // MODO FIREBASE: cria usuário no Auth + doc no Firestore
  if (APP_MODE === 'firebase' && firebaseAuth) {
    try {
      const cred = await firebaseAuth.createUserWithEmailAndPassword(email, pass);
      if (firebaseDb) {
        await firebaseDb.collection('usuarios').doc(cred.user.uid).set({
          email, role: 'consultor', criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
          criadoPor: STATE.user.email
        });
      }
      toast(`Consultor ${email} criado! Faça login novamente.`, 'success', 6000);
      $('#novoUserEmail').value = '';
      $('#novoUserPass').value = '';
      $('#criarUserStatus').textContent = '✓ Criado';
      setTimeout(() => { STATE.user = null; mostrarLogin(); }, 2500);
    } catch (err) {
      $('#criarUserStatus').textContent = '✗ ' + err.message;
      toast('Erro: ' + err.message, 'error');
    }
    return;
  }

  // MODO LOCAL: salva na lista de usuários deste navegador
  const users = getLocalUsers();
  if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    $('#criarUserStatus').textContent = '✗ Email já cadastrado';
    toast('Já existe um consultor com este email (neste navegador).', 'error');
    return;
  }
  users.push({
    id: getId(),
    email,
    role: 'consultor',
    senhaHash: ofuscarSenha(pass),
    criadoPor: STATE.user.email,
    criadoEm: new Date().toISOString()
  });
  setLocalUsers(users);
  toast(`Consultor ${email} criado! Senha inicial: ${pass} — envie por canal seguro.`, 'success', 7000);
  $('#novoUserEmail').value = '';
  $('#novoUserPass').value = '';
  $('#criarUserStatus').textContent = '✓ Criado (local)';
  renderUsersList();
});

async function renderUsersList() {
  const box = $('#usersList');
  // MODO FIREBASE: lista do Firestore
  if (APP_MODE === 'firebase' && firebaseDb) {
    try {
      const snap = await firebaseDb.collection('usuarios').orderBy('email').get();
      let html = '<table class="smart-table"><thead><tr><th>Email</th><th>Role</th><th>Criado por</th></tr></thead><tbody>';
      // sempre mostra o admin fixo
      html += `<tr>
        <td>${ADMIN_EMAIL}</td>
        <td><span class="role-badge role-admin">admin</span></td>
        <td class="muted">sistema</td>
      </tr>`;
      if (!snap.empty) {
        snap.forEach(d => {
          const u = d.data();
          html += `<tr>
            <td>${u.email}</td>
            <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-consultor'}">${u.role}</span></td>
            <td class="muted">${u.criadoPor || '—'}</td>
          </tr>`;
        });
      }
      html += '</tbody></table>';
      box.innerHTML = html;
    } catch (e) {
      box.innerHTML = '<p class="muted">Erro ao listar usuários.</p>';
    }
    return;
  }

  // MODO LOCAL: lista do localStorage
  const users = getLocalUsers();
  let html = '<table class="smart-table"><thead><tr><th>Email</th><th>Role</th><th>Criado por</th><th></th></tr></thead><tbody>';
  html += `<tr>
    <td>${ADMIN_EMAIL}</td>
    <td><span class="role-badge role-admin">admin</span></td>
    <td class="muted">sistema</td>
    <td class="muted">fixo</td>
  </tr>`;
  if (users.length) {
    users.forEach(u => {
      html += `<tr>
        <td>${u.email}</td>
        <td><span class="role-badge role-consultor">${u.role}</span></td>
        <td class="muted">${u.criadoPor || '—'}</td>
        <td><button class="row-actions-cell" data-del-user="${u.id}" title="Remover"><i class="fa-solid fa-trash"></i></button></td>
      </tr>`;
    });
  }
  html += '</tbody></table>';
  if (APP_MODE === 'local') {
    html += '<p class="muted" style="margin-top:10px"><i class="fa-solid fa-circle-info"></i> Modo local: usuários existem só neste navegador. Para sync entre dispositivos, configure o Firebase em Configurações.</p>';
  }
  box.innerHTML = html;
  $$('[data-del-user]').forEach(b => b.addEventListener('click', () => {
    if (!isAdmin()) return;
    if (!confirm('Remover este consultor?')) return;
    const id = b.dataset.delUser;
    setLocalUsers(getLocalUsers().filter(u => u.id !== id));
    renderUsersList();
    toast('Consultor removido.', 'info');
  }));
}

// =========================================================
// EXPORTAR PDF
// =========================================================
$('#btnExportar').addEventListener('click', async () => {
  const emp = {
    razao: $('#empRazao').textContent,
    cnpj: $('#empCnpj').textContent,
    cnae: $('#empCnae').textContent,
    local: $('#empLocal').textContent,
    status: $('#empStatus').textContent
  };
  let html = `
    <html><head><meta charset="UTF-8"><title>Top 5 - ${emp.razao}</title>
    <style>
      body { font-family: 'Helvetica', sans-serif; padding: 40px; color: #1F4033; }
      h1 { color: #007840; border-bottom: 3px solid #007840; padding-bottom: 8px; }
      h3 { color: #007840; margin-top: 24px; }
      .card { background: #F6F6F6; border-left: 4px solid #007840; padding: 14px; margin: 10px 0; border-radius: 6px; }
      .score { float: right; font-size: 22px; font-weight: bold; color: #007840; }
      .meta { color: #636466; font-size: 12px; margin-top: 4px; }
      .motivo { background: #BAE64F33; padding: 8px 12px; border-radius: 6px; margin-top: 8px; font-size: 13px; }
    </style></head><body>
    <h1>Smart Seller — Recomendação para ${emp.razao}</h1>
    <p><b>CNPJ:</b> ${emp.cnpj} • <b>${emp.cnae}</b> • ${emp.local}</p>
    <h3>Top 5 produtos recomendados</h3>
  `;
  $$('.top5-card').forEach(c => {
    const nome = c.querySelector('h4').textContent;
    const meta = c.querySelector('.meta').textContent;
    const motivo = c.querySelector('.top5-motivo').textContent.trim();
    const score = c.querySelector('.top5-score').firstChild.textContent;
    html += `<div class="card"><span class="score">${score}</span><b>${nome}</b><div class="meta">${meta}</div><div class="motivo">${motivo}</div></div>`;
  });
  html += `<p style="margin-top:32px;color:#636466;font-size:11px">Gerado por Smart Seller em ${new Date().toLocaleString('pt-BR')}</p></body></html>`;

  const w = window.open('', '_blank');
  w.document.write(html);
  w.document.close();
  w.print();
});

// =========================================================
// BOOT
// =========================================================
(async function boot() {
  initTema();
  carregarLocal();

  // Inicializa seed de produtos se for primeira vez (só local)
  if (!STATE.produtos || !STATE.produtos.length) {
    STATE.produtos = window.PRODUTOS_SEED.map(p => ({ ...p, id: getId() }));
    salvarLocal();
  }

  // Tenta conectar Firebase automaticamente (só se a config for válida e real)
  if (firebaseConfigValida(STATE.config.firebase)) {
    if (initFirebase() && firebaseAuth) {
      APP_MODE = 'firebase';
      // Garante que o admin existe (cria no primeiro acesso)
      // Nota: isso desconecta qualquer usuário atual
      await garantirAdminExiste();
      await firebaseAuth.signOut();

      // Listener de autenticação
      firebaseAuth.onAuthStateChanged(async user => {
        if (user) {
          const role = await carregarRoleUsuario(user.uid, user.email);
          STATE.user = { email: user.email, uid: user.uid, role };
          // Carrega dados do Firestore (se conseguir)
          await carregarDoFirestore();
          mostrarApp();
        } else {
          mostrarLogin();
        }
      });
      return;
    }
  }
  // Sem Firebase válido: entra em modo local (login funciona 100%)
  APP_MODE = 'local';
  mostrarLogin();
})();

// =========================================================
// SINCRONIZAÇÃO COM FIRESTORE
// =========================================================
async function carregarDoFirestore() {
  if (!firebaseDb || !STATE.user) return;
  try {
    const prodsDoc = await firebaseDb.collection('dados').doc('produtos').get();
    if (prodsDoc.exists && prodsDoc.data().lista?.length) {
      STATE.produtos = prodsDoc.data().lista;
    }
    // Histórico é por usuário: lê apenas os itens do UID logado
    const histSnap = await firebaseDb.collection('dados')
      .doc('historico')
      .collection('itens')
      .where('uid', '==', STATE.user.uid)
      .orderBy('data', 'desc')
      .limit(50)
      .get();
    const lista = [];
    histSnap.forEach(d => lista.push(d.data()));
    STATE.historico = lista;
    salvarLocal();
  } catch (e) {
    console.warn('Falha ao carregar do Firestore:', e);
  }
}

async function salvarNoFirestore() {
  if (!firebaseDb || !STATE.user) return;
  try {
    await firebaseDb.collection('dados').doc('produtos').set({
      lista: STATE.produtos,
      atualizadoPor: STATE.user.email,
      atualizadoEm: firebase.firestore.FieldValue.serverTimestamp()
    });
    // Salva o histórico por usuário na subcoleção `dados/historico/itens`.
    // Cada item é identificado pelo próprio `id` e filtrado por `uid` na leitura.
    const col = firebaseDb.collection('dados').doc('historico').collection('itens');
    const batch = firebaseDb.batch();
    STATE.historico.forEach(item => {
      const ref = col.doc(item.id);
      batch.set(ref, { ...item, uid: STATE.user.uid, userEmail: STATE.user.email }, { merge: true });
    });
    await batch.commit();
  } catch (e) {
    console.warn('Falha ao salvar no Firestore:', e);
  }
}

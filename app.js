/* ============================================================
   Smart Seller — App principal
   Lógica: CNPJ → BrasilAPI → scoring → Top 5 → IA (opcional)
   ============================================================ */

// =========================================================
// ESTADO GLOBAL
// =========================================================

// Credenciais do administrador ofuscadas.
// IMPORTANTE: qualquer credencial em JS executado no client é visível
// via DevTools (F12 → Sources). Este ofuscamento não é segurança real —
// ele apenas evita que um grep rápido no source revele o email/senha em
// texto puro. Pra segurança de verdade, use o modo Firebase com
// Firestore Rules (o admin nunca autentica via essas constantes).
//
// Cada credencial é armazenada como Base64 com caracteres embaralhados
// via uma chave interna. A função _decodeAdmin() desfaz a transformação
// no momento do uso.
const _K = 'S3l0p4'; // chave de embaralhamento (não é segurança, só dificulta leitura)
function _b64(s) { try { return btoa(unescape(encodeURIComponent(s))); } catch { return s; } }
function _unb64(s) { try { return decodeURIComponent(escape(atob(s))); } catch { return s; } }
// Aplica XOR byte-a-byte contra a chave pra evitar Base64 direto
function _x(s, k) { let out = ''; for (let i = 0; i < s.length; i++) out += String.fromCharCode(s.charCodeAt(i) ^ k.charCodeAt(i % k.length)); return out; }
function _encEmail(s) { return _b64(_x(s, _K)); }
function _encSenha(s) { return _b64(_x(s, _K)); }
function _decodeAdmin(encoded) { return _x(_unb64(encoded), _K); }

// Email e senha ofuscados. Para descobrir: use _decodeAdmin() no console.
const ADMIN_EMAIL_ENC = 'N1oDVx9fMkEFRBEBZwQsVx1VOl9CUx9Z';
const ADMIN_SENHA_ENC = 'EkEPXx0GYwFa';
const ADMIN_EMAIL = _decodeAdmin(ADMIN_EMAIL_ENC);
const ADMIN_SENHA = _decodeAdmin(ADMIN_SENHA_ENC);

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
  users: 'cda_top5_users_v1',
  // Sessão persistida (modo local): ao atualizar a página, o usuário
  // permanece logado. No modo Firebase, a sessão é gerenciada pelo próprio
  // Firebase Auth (ele restaura via onAuthStateChanged).
  session: 'cda_top5_session_v1'
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

// Helper: checa se um email é o admin FIXO (proteção do admin principal —
// não pode ser editado, excluído nem rebaixado).
function isAdminFixo(email) {
  return (email || '').toLowerCase() === ADMIN_EMAIL.toLowerCase();
}

// Helper: conta quantos admins existem no sistema (modo Firebase ou local).
// Usado pela checagem de "último admin" antes de rebaixar/excluir.
async function contarAdmins() {
  // Admin fixo conta como 1 independente do que está gravado
  let total = 1;
  if (APP_MODE === 'firebase' && firebaseDb) {
    try {
      const snap = await firebaseDb.collection('usuarios').where('role', '==', 'admin').get();
      // Pode incluir o admin fixo se o doc dele existir — não conta duplicado
      snap.forEach(d => { if (!isAdminFixo(d.data().email)) total++; });
    } catch (e) { /* fallback: considera só o fixo */ }
  } else {
    const users = getLocalUsers();
    users.filter(u => u.role === 'admin' && !isAdminFixo(u.email)).forEach(() => total++);
  }
  return total;
}

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

// Persistência de sessão (modo local) -------------------------------------
// Salva a sessão do usuário atual para que ele continue logado após um
// refresh / fechamento de aba. É um blob mínimo (email + uid + role).
// Nunca é usado em modo Firebase (lá quem cuida é o firebaseAuth).
function salvarSessaoLocal() {
  if (!STATE.user) {
    localStorage.removeItem(STORAGE_KEYS.session);
    return;
  }
  // Não persiste admin fixo com uid 'local-admin'? Persiste sim — é
  // justamente o que o usuário pediu ("ao atualizar, se eu estiver logado,
  // permaneça logado").
  localStorage.setItem(STORAGE_KEYS.session, JSON.stringify({
    email: STATE.user.email,
    uid: STATE.user.uid,
    role: STATE.user.role,
    ts: Date.now()
  }));
}
function limparSessaoLocal() {
  localStorage.removeItem(STORAGE_KEYS.session);
}
function carregarSessaoLocal() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.session);
    if (!raw) return null;
    const s = JSON.parse(raw);
    if (!s || !s.email || !s.role) return null;
    // Sessão de admin fixo: aceita direto, é o mesmo email/senha do código.
    if (s.role === 'admin' && s.email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
      return { email: s.email, uid: 'local-admin', role: 'admin' };
    }
    // Sessão de consultor: precisa existir na lista local com mesmo email e role.
    if (s.role === 'consultor') {
      const u = getLocalUsers().find(x => x.email.toLowerCase() === s.email.toLowerCase());
      if (u && u.role === 'consultor') {
        return { email: u.email, uid: u.id, role: 'consultor' };
      }
    }
    return null;
  } catch {
    return null;
  }
}
function ofuscarSenha(s) {
  // Ofuscação simples — apenas para não exibir em texto puro no localStorage.
  // NUNCA use isso em produção real; aqui só serve pro modo local.
  try { return btoa(unescape(encodeURIComponent(s))); } catch { return s; }
}
function verificarSenhaLocal(s, hash) {
  return ofuscarSenha(s) === hash;
}

// Alterna visualização de senha (olho) nos campos de login/cadastro.
// Usado pelos botões .login-pwd-toggle no HTML.
function togglePwd(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const icon = btn.querySelector('i');
  if (input.type === 'password') {
    input.type = 'text';
    if (icon) { icon.classList.remove('fa-eye'); icon.classList.add('fa-eye-slash'); }
  } else {
    input.type = 'password';
    if (icon) { icon.classList.remove('fa-eye-slash'); icon.classList.add('fa-eye'); }
  }
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

// Listener em tempo real da coleção de usuários — faz o card de solicitações
// atualizar automaticamente quando alguém se cadastra, sem precisar F5 nem
// clicar em "Atualizar". Guardamos em window._solicUnsubscribe pra poder
// desativar no logout (evita listener zumbi em segundo plano).
function iniciarListenerSolicitacoes() {
  if (APP_MODE !== 'firebase' || !firebaseDb || !isAdmin()) return;
  if (window._solicUnsubscribe) { try { window._solicUnsubscribe(); } catch {} window._solicUnsubscribe = null; }
  let primeiroSnapshot = true;
  try {
    window._solicUnsubscribe = firebaseDb.collection('usuarios')
      .orderBy('criadoEm', 'desc')
      .onSnapshot(snap => {
        // Re-renderiza o card e atualiza o badge do sidebar em tempo real.
        renderSolicitacoes();
        if (!primeiroSnapshot) {
          const qtd = snap.docs.filter(d => {
            const u = d.data();
            return u.role === 'pendente' && (u.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase();
          }).length;
          if (qtd > 0) toast(`Nova solicitação de acesso recebida (${qtd} pendente${qtd === 1 ? '' : 's'})`, 'info', 3500);
        }
        primeiroSnapshot = false;
      }, err => console.warn('solicitacoes listener:', err));
  } catch (e) {
    console.warn('Falha ao registrar listener de solicitações:', e);
  }
}
function pararListenerSolicitacoes() {
  if (window._solicUnsubscribe) {
    try { window._solicUnsubscribe(); } catch {}
    window._solicUnsubscribe = null;
  }
}

function mostrarApp() {
  $('#splashOverlay').style.display = 'none';
  $('#loginOverlay').style.display = 'none';
  $('#appRoot').style.display = 'block';
  // Anima o "momento do login": o CSS cuida do pulse na logo + fade+scale no
  // card enquanto a transição acontece. Aqui só ligamos a classe no body e
  // aguardamos a animação terminar para revelar o app.
  document.body.classList.add('login-success');
  setTimeout(() => {
    document.body.classList.remove('login-success');
    const appRoot = $('#appRoot');
    appRoot.classList.remove('show');
    // força reflow para re-disparar a animação se logar de novo
    void appRoot.offsetWidth;
    appRoot.classList.add('show');
  }, 480);
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
  if (isAdmin()) { renderUsersList(); renderSolicitacoes(); diagnosticarFirestoreAdmin(); }
  // Liga o listener em tempo real da coleção de usuários (só faz efeito no
  // modo Firebase, e só se o admin estiver logado). Atualiza o card de
  // solicitações sem precisar dar F5 ou clicar em "Atualizar".
  iniciarListenerSolicitacoes();
}
function mostrarLogin() {
  $('#splashOverlay').style.display = 'none';
  $('#loginOverlay').style.display = 'flex';
  $('#appRoot').style.display = 'none';
  // Limpa classes de animação do momento do login (caso o usuário tenha
  // deslogado e esteja voltando à tela de login — sem isso, a próxima
  // animação "login-success" não rodaria).
  document.body.classList.remove('login-success');
  const appRoot = $('#appRoot');
  if (appRoot) appRoot.classList.remove('show');
  // Limpa o listener de solicitações — não faz sentido ficar escutando a
  // coleção "usuarios" com ninguém logado.
  pararListenerSolicitacoes();
}

// Mostra a splash (boas-vindas) ao abrir o site. Chamada quando não há
// sessão ativa — primeiro acesso ou logout.
function mostrarSplash() {
  $('#splashOverlay').style.display = 'flex';
  $('#loginOverlay').style.display = 'none';
  $('#appRoot').style.display = 'none';
  // Limpa classes de animação que possam ter ficado de uma transição anterior
  document.body.classList.remove('login-success', 'splash-leaving');
  // Garante que nenhum listener de solicitações ficou ativo do logout
  pararListenerSolicitacoes();
}

// Transição da splash pro login (com animação de saída).
function irParaLogin() {
  document.body.classList.add('splash-leaving');
  setTimeout(() => {
    $('#splashOverlay').style.display = 'none';
    document.body.classList.remove('splash-leaving');
    mostrarLogin();
  }, 500);
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
      return doc.data().role || 'pendente';
    } else {
      // Sem doc no Firestore: se for o admin fixo, aprova direto.
      // Qualquer outro email vira 'pendente' (fica na fila do Admin) — nunca
      // aprova automaticamente, para não abrir uma brecha de acesso.
      const role = email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'pendente';
      await firebaseDb.collection('usuarios').doc(uid).set({
        email, role,
        // criadoEm (serverTimestamp) é usado pra ordenar/listar.
        // criadoEmLocal (ISO string) é o fallback caso o server ainda não
        // tenha propagado o timestamp — evita lista vazia/fora de ordem.
        criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
        criadoEmLocal: new Date().toISOString()
      });
      return role;
    }
  } catch (e) {
    console.warn('Erro ao buscar role:', e);
    return email.toLowerCase() === ADMIN_EMAIL.toLowerCase() ? 'admin' : 'pendente';
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

// Helper: define a mensagem do #loginStatus. Se for erro, dispara um
// "shake" leve para dar feedback visual (re-disparável via remove/add).
function setLoginStatus(msg, isError = false) {
  const status = $('#loginStatus');
  if (!status) return;
  status.textContent = msg;
  if (isError) {
    // remove/add garante que a animação reinicia mesmo se ela já estiver
    // rodando (sem esse truque, o segundo erro de login não anima).
    status.classList.remove('shake');
    void status.offsetWidth;
    status.classList.add('shake');
  } else {
    status.classList.remove('shake');
  }
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#loginEmail').value.trim();
  const pass = $('#loginPass').value;
  setLoginStatus('Entrando…', false);

  const firebaseOk = initFirebase() && firebaseAuth;
  APP_MODE = firebaseOk ? 'firebase' : 'local';

  if (firebaseOk) {
    // ===== LOGIN VIA FIREBASE (com sync entre dispositivos) =====
    try {
      const cred = await firebaseAuth.signInWithEmailAndPassword(email, pass);
      const role = await carregarRoleUsuario(cred.user.uid, cred.user.email);
      if (role === 'pendente') {
        await firebaseAuth.signOut();
        setLoginStatus('Sua conta ainda está aguardando aprovação do administrador.', true);
        return;
      }
      if (role === 'recusado') {
        await firebaseAuth.signOut();
        setLoginStatus('Seu acesso foi recusado pelo administrador.', true);
        return;
      }
      STATE.user = { email: cred.user.email, uid: cred.user.uid, role };
      await carregarDoFirestore();
      mostrarApp();
      toast(`Bem-vindo, ${role === 'admin' ? 'Administrador' : 'Consultor'}!`, 'success');
      return;
    } catch (err) {
      if (err.code === 'auth/user-not-found' || err.code === 'auth/invalid-credential' || err.code === 'auth/wrong-password') {
        // Usa fetchSignInMethodsForEmail pra saber se a conta existe e mostrar
        // uma mensagem útil. É a forma recomendada pelo Firebase pra
        // distinguir "conta inexistente" de "senha errada" sem vazar infos.
        try {
          const methods = await firebaseAuth.fetchSignInMethodsForEmail(email);
          if (methods && methods.length > 0) {
            setLoginStatus('Senha incorreta para este email. Verifique a senha ou use "Solicitar acesso".', true);
          } else {
            setLoginStatus('Usuário não encontrado. Clique em "Solicitar acesso" para criar sua conta.', true);
          }
        } catch (probeErr) {
          // Se a checagem falhar (rede etc), cai na mensagem genérica.
          setLoginStatus(err.code === 'auth/user-not-found'
            ? 'Usuário não encontrado. Clique em "Solicitar acesso" para criar sua conta.'
            : 'Senha incorreta. Verifique ou use "Solicitar acesso".', true);
        }
      } else if (err.code === 'auth/api-key-not-valid' || err.code === 'auth/invalid-api-key') {
        setLoginStatus('Firebase: apiKey inválida. Use o modo local ou configure em Configurações.', true);
      } else {
        setLoginStatus(err.message, true);
      }
      return;
    }
  }

  // ===== LOGIN LOCAL (sem Firebase) =====
  // Admin fixo
  if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase() && pass === ADMIN_SENHA) {
    STATE.user = { email, uid: 'local-admin', role: 'admin' };
    salvarSessaoLocal();
    mostrarApp();
    toast('Bem-vindo, Administrador! (modo local)', 'success');
    return;
  }
  // Consultores cadastrados localmente
  const users = getLocalUsers();
  const u = users.find(x => x.email.toLowerCase() === email.toLowerCase());
  if (u && verificarSenhaLocal(pass, u.senhaHash)) {
    if (u.role === 'pendente') {
      setLoginStatus('Sua conta ainda está aguardando aprovação do administrador.', true);
      return;
    }
    if (u.role === 'recusado') {
      setLoginStatus('Seu acesso foi recusado pelo administrador.', true);
      return;
    }
    STATE.user = { email, uid: u.id, role: u.role || 'consultor' };
    salvarSessaoLocal();
    mostrarApp();
    toast('Bem-vindo, Consultor! (modo local)', 'success');
    return;
  }
  // Nenhuma credencial bateu
  if (u) {
    setLoginStatus('Senha incorreta.', true);
  } else {
    setLoginStatus('Usuário não encontrado. Clique em "Solicitar acesso" para criar sua conta.', true);
  }
});

$('#btnCriarConta').addEventListener('click', (e) => {
  e.preventDefault();
  $('#loginForm').closest('.login-box').style.display = 'none';
  $('#signupBox').style.display = '';
  $('#loginStatus').textContent = '';
});
$('#btnVoltarLogin').addEventListener('click', (e) => {
  e.preventDefault();
  $('#signupBox').style.display = 'none';
  $('#loginForm').closest('.login-box').style.display = '';
  $('#signupStatus').textContent = '';
});

// =========================================================
// SOLICITAÇÃO DE ACESSO (autocadastro de consultor + aprovação do Admin)
// O consultor cria a própria conta com email/senha, mas ela nasce com
// role 'pendente' — sem acesso ao sistema — até o Admin aprovar em Configurações.
// =========================================================
$('#signupForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const nome = $('#suNome').value.trim();
  const email = $('#suEmail').value.trim();
  const setor = $('#suSetor').value.trim();
  const pass = $('#suSenha').value;
  const status = $('#signupStatus');

  if (!nome || !email || pass.length < 6) {
    status.textContent = 'Preencha nome, email e senha (mínimo 6 caracteres).';
    return;
  }
  if (email.toLowerCase() === ADMIN_EMAIL.toLowerCase()) {
    status.textContent = 'Este email já é o do administrador.';
    return;
  }
  status.textContent = 'Enviando solicitação…';

  const firebaseOk = initFirebase() && firebaseAuth;
  APP_MODE = firebaseOk ? 'firebase' : 'local';

  if (firebaseOk) {
    // Antes de criar a conta, verifica se ela já existe no Firebase Auth.
    // Isso evita o erro genérico "auth/email-already-in-use" e dá uma mensagem
    // clara para o usuário — ele pode estar tentando se cadastrar com um
    // email que já foi usado num teste anterior ou por outro consultor.
    try {
      await firebaseAuth.signInWithEmailAndPassword(email, pass);
      // Login funcionou → a conta já existe. Descobre o status dela no Firestore
      // e informa o usuário com precisão.
      const user = firebaseAuth.currentUser;
      const role = await carregarRoleUsuario(user.uid, user.email);
      await firebaseAuth.signOut(); // não deixa o usuário entrar
      if (role === 'pendente') {
        status.textContent = `Já existe uma solicitação com este email. Aguarde o administrador aprovar.`;
      } else if (role === 'recusado') {
        status.textContent = `Este email foi recusado pelo administrador. Fale com a equipe para liberar.`;
      } else if (role === 'consultor' || role === 'admin') {
        status.textContent = `Este email já possui cadastro. Use o botão "Entrar" para fazer login.`;
      } else {
        status.textContent = `Este email já possui cadastro. Use o botão "Entrar" para fazer login.`;
      }
      return;
    } catch (preErr) {
      // Se o erro for de credencial inválida (não é "user not found"), significa
      // que a senha está errada — ou seja, a conta existe com outra senha.
      if (preErr.code === 'auth/invalid-credential' || preErr.code === 'auth/wrong-password') {
        status.textContent = `Este email já possui cadastro com outra senha. Fale com o administrador para recuperar o acesso.`;
        return;
      }
      // auth/user-not-found → email livre, podemos criar a conta.
      // Outros erros (network, etc.) → deixa cair no createUserWithEmailAndPassword
      // que vai dar a mensagem apropriada.
    }

    try {
      const cred = await firebaseAuth.createUserWithEmailAndPassword(email, pass);
      await firebaseDb.collection('usuarios').doc(cred.user.uid).set({
        email, nome, setor: setor || null,
        role: 'pendente',
        // criadoEm (serverTimestamp) é o timestamp "oficial" usado pra ordenar.
        // criadoEmLocal (ISO string) é gravado JUNTO pra servir de fallback na
        // ordenação caso o server ainda não tenha propagado o serverTimestamp
        // — sem isso, a solicitação pode ficar invisível para o Admin nos
        // primeiros segundos após o cadastro (esse era o bug original).
        criadoEm: firebase.firestore.FieldValue.serverTimestamp(),
        criadoEmLocal: new Date().toISOString()
      });
      await firebaseAuth.signOut(); // não deixa entrar enquanto estiver pendente
      status.textContent = '';
      toast('Solicitação enviada! Aguarde o administrador aprovar seu acesso.', 'success', 6000);
      $('#signupForm').reset();
      $('#btnVoltarLogin').click();
    } catch (err) {
      if (err.code === 'auth/email-already-in-use') {
        // Fallback: caso a verificação prévia tenha falhado (ex: race condition),
        // mantemos a mensagem original.
        status.textContent = 'Já existe uma conta com este email. Use "Entrar" ou fale com o administrador.';
      } else if (err.code === 'auth/weak-password') {
        status.textContent = 'Senha muito fraca — use ao menos 6 caracteres.';
      } else {
        status.textContent = err.message;
      }
    }
    return;
  }

  // ===== MODO LOCAL =====
  const users = getLocalUsers();
  if (users.some(u => u.email.toLowerCase() === email.toLowerCase())) {
    status.textContent = 'Já existe uma conta (ou solicitação) com este email.';
    return;
  }
  users.push({
    id: getId(),
    email, nome, setor: setor || null,
    role: 'pendente',
    senhaHash: ofuscarSenha(pass),
    criadoEm: new Date().toISOString(),
    criadoEmLocal: new Date().toISOString()
  });
  setLocalUsers(users);
  status.textContent = '';
  toast('Solicitação enviada! Aguarde o administrador aprovar seu acesso (neste navegador).', 'success', 6000);
  $('#signupForm').reset();
  $('#btnVoltarLogin').click();
});

$('#btnSair').addEventListener('click', async () => {
  if (firebaseAuth) await firebaseAuth.signOut();
  STATE.user = null;
  limparSessaoLocal();
  // mostrarSplash() já chama pararListenerSolicitacoes() indiretamente via
  // mostrarLogin se o usuário voltar a entrar, mas chamamos direto aqui
  // também por garantia — evita leak quando o usuário troca de role.
  pararListenerSolicitacoes();
  // Volta pra splash (não pro login direto) — fluxo padrão do site
  mostrarSplash();
});

// =========================================================
// TABS
// =========================================================
$$('.nav-item').forEach(el => el.addEventListener('click', () => {
  $$('.nav-item').forEach(n => n.classList.remove('active'));
  $$('.tab-pane').forEach(t => t.classList.remove('active'));
  el.classList.add('active');
  $(`#tab-${el.dataset.tab}`).classList.add('active');
  // Garante que dados sensíveis ao contexto sempre reflitam o estado mais
  // recente ao entrar em cada aba. Evita o caso clássico de "a solicitação
  // não aparece" — pode ter sido criada em outra aba/janela e o admin só
  // percebe ao reentrar em Configurações.
  if (el.dataset.tab === 'config' && isAdmin()) {
    renderSolicitacoes();
    renderUsersList();
  }
  if (el.dataset.tab === 'historico') renderHistorico();
  if (el.dataset.tab === 'produtos') renderProdutos();
}));

// Botão "Atualizar" do card de solicitações — força reload da lista.
// Útil quando o cadastro do consultor foi feito em outra aba/janela e o
// admin precisa ver a nova solicitação sem dar F5.
const _btnAtualizarSolic = $('#btnAtualizarSolicitacoes');
if (_btnAtualizarSolic) {
  _btnAtualizarSolic.addEventListener('click', async () => {
    if (!isAdmin()) return;
    const icon = _btnAtualizarSolic.querySelector('i');
    if (icon) { icon.classList.add('fa-spin'); }
    await renderSolicitacoes();
    if (icon) { icon.classList.remove('fa-spin'); }
    const qtd = getLocalUsers().filter(u => u.role === 'pendente').length;
    if (qtd > 0) toast(`${qtd} solicitação(ões) pendente(s)`, 'info', 2000);
  });
}

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
      // Campos extras da BrasilAPI que agora alimentam o scoring e a IA
      nomeFantasia: cnpj.nome_fantasia || '',
      cnae: cnpj.cnae_fiscal,
      cnaeDesc: cnpj.cnae_fiscal_descricao || (window.CNAE_DESC[cnpj.cnae_fiscal] || ''),
      cnaesSecundarios: Array.isArray(cnpj.cnaes_secundarios) ? cnpj.cnaes_secundarios : [],
      dataInicioAtividade: cnpj.data_inicio_atividade || null,
      idadeAnos: calcularIdade(cnpj.data_inicio_atividade),
      faixaIdade: faixaPorIdade(calcularIdade(cnpj.data_inicio_atividade)),
      opcaoMei: cnpj.opcao_pelo_mei === true,
      uf: cnpj.uf,
      cidade: cnpj.municipio,
      bairro: cnpj.bairro,
      logradouro: `${cnpj.descricao_tipo_de_logradouro} ${cnpj.logradouro}, ${cnpj.numero}`,
      cep: cnpj.cep,
      status: cnpj.descricao_situacao_cadastral,
      porte: cnpj.porte,
      natureza: cnpj.natureza_juridica
    };

    // 3) Calcular Top 5 (agora retorna 7 candidatos pra IA escolher 5,
    //    além de flag de fallback e categoria inferida).
    const top5 = calcularTop5(empresa);

    // 4) Render — passa info de fallback e se a IA está disponível
    const iaDisponivel = !!STATE.config.groq.apiKey;
    renderEmpresa(empresa, top5.afinidade);
    renderTop5(top5.itensFinais, empresa, {
      fallbackSimilaridade: top5.fallbackSimilaridade,
      categoriaInferida: top5.categoriaInferidaNome,
      iaDisponivel
    });
    $('#loadingBox').style.display = 'none';
    $('#empresaBox').style.display = 'block';
    $('#top5Box').style.display = 'block';

    // 5) Histórico (individual por usuário)
    STATE.historico.unshift({
      id: getId(), data: new Date().toISOString(),
      uid: STATE.user?.uid || 'anon',
      userEmail: STATE.user?.email || '—',
      cnpj: empresa.cnpj, empresa: empresa.razao, cnae: empresa.cnae, uf: empresa.uf,
      top1: top5.itensFinais[0]?.nome || '—'
    });
    STATE.historico = STATE.historico.slice(0, 50);
    salvarLocal(); renderHistorico();

    status.className = 'consulta-status ok';
    status.textContent = `✓ ${empresa.razao} — Top 5 calculado.`;

    // 6) Enriquecer / re-rankear com IA Groq (em background)
    enriquecerComIA(top5.itens, empresa, top5.itensFinais, {
      fallbackSimilaridade: top5.fallbackSimilaridade,
      categoriaInferida: top5.categoriaInferidaNome
    });
  } catch (err) {
    $('#loadingBox').style.display = 'none';
    status.className = 'consulta-status error';
    status.textContent = err.message;
  } finally {
    $('#btnConsultar').disabled = false;
  }
}

// =========================================================
// ALGORITMO DE SCORING (Top 5) — inteligente, multi-sinal
// =========================================================

// Mapa de categoria → palavras-gatilho. Usado pra inferir o ramo provável
// do cliente quando o CNAE é genérico (ex: 4711-3 "Comércio varejista de
// mercadorias em geral") — o nome fantasia ou descrição do CNAE acaba
// revelando o que a empresa realmente faz.
const CATEGORIAS_GATILHO = {
  'Construção':     ['obra', 'construção', 'construtor', 'engenharia', 'alvenaria', 'reforma', 'pedreiro', 'cimento', 'tinta', 'pintura', 'revestimento', 'eletricista', 'encanamento', 'gesseiro', 'marceneiro', 'serralheiro'],
  'Alimentos':      ['restaurante', 'lanchonete', 'padaria', 'bar', 'pizzaria', 'hamburgueria', 'food', 'comida', 'mercearia', 'supermercado', 'açougue', 'cafeteria', 'doceria', 'confeitaria', 'sushi', 'sorveteria'],
  'Hospitalar':     ['hospital', 'clínica', 'clinica', 'saúde', 'saude', 'médic', 'medic', 'odontolog', 'farmac', 'laboratório', 'laboratorio', 'enfermagem', 'paciente', 'consultório', 'consultorio'],
  'EPI':            ['epi', 'segurança do trabalho', 'seguranca do trabalho', 'nr-6', 'nr 6', 'nr-10', 'nr-35', 'obrigação'],
  'Tecnologia':     ['tecnologia', 'ti ', 'informática', 'informatica', 'software', 'computação', 'computacao', 'startup', 'desenvolv', 'programação', 'programacao', 'digital', ' dados'],
  'Automotivo':     ['oficina', 'mecânica', 'mecanica', 'auto', 'veículo', 'veiculo', 'posto', 'combustível', 'combustivel', 'troca de óleo', 'troca de oleo', 'funilaria', 'pneu'],
  'Agro':           ['agro', 'agrícola', 'agricola', 'pecuária', 'pecuaria', 'fazenda', 'sítio', 'sitio', 'lavoura', 'grãos', 'graos', 'plantação', 'plantacao', 'criação', 'criacao', 'gado'],
  'Pet':            ['pet', 'veterinária', 'veterinaria', 'cachorro', 'gato', 'animal', 'ração', 'racao'],
  'Educação':       ['escola', 'educação', 'educacao', 'curso', 'universidade', 'faculdade', 'colégio', 'colegio', 'ensino', 'aluno'],
  'Hospedagem':     ['hotel', 'pousada', 'hospedagem', 'hostel', 'resort', 'turismo', 'viagem'],
  'Limpeza':        ['limpeza', 'faxina', 'diarista', 'higienização', 'higienizacao', 'conservação', 'conservacao', 'sanitização', 'sanitizacao'],
  'Escritório':     ['escritório', 'escritorio', 'contabilidade', 'contábil', 'contabil', 'advocacia', 'advogado', 'consultoria', 'administradora'],
  'Beleza':         ['salão', 'salao', 'barbearia', 'beleza', 'estética', 'estetica', 'cabeleireiro', 'manicure', 'maquiagem'],
  'Logística':      ['logística', 'logistica', 'transportadora', 'frete', 'armazenagem', 'distribuidora', 'entrega', 'expedição', 'expedicao'],
  'Eletrodomésticos': ['eletrodoméstico', 'eletrodomestico', 'loja de departamento', 'magazine'],
  'Energia':        ['energia', 'solar', 'fotovoltaico', 'fotovoltaíco', 'elétrica', 'eletrica', 'usina'],
  'Vestuário':      ['vestuário', 'vestuario', 'roupa', 'moda', 'confecção', 'confeccao', 'loja de roupa', 'boutique'],
  'Tintas':         ['tinta', 'pintura', 'revenda de tinta'],
  'Ferramentas':    ['ferramenta', 'ferramentaria', 'parafuso', 'fixação', 'fixacao']
};

// Palavras-chave que identificam um produto "enterprise" — destinado a
// grandes empresas. Em clientes MEI / muito novos, esses produtos recebem
// uma penalidade no score (não é exclusão automática; é apenas um sinal
// de "baixa confiança" pra IA ponderar).
const PRODUTOS_ENTERPRISE = ['empilhadeira', 'notebook 15', 'servidor', 'paine solar', 'data center', 'split 12000', 'split 18000', 'split 24000'];

// Calcula idade (em anos completos) a partir de uma data de início no
// formato YYYY-MM-DD (ou DD/MM/YYYY como fallback). Retorna null se a data
// for inválida/ausente.
function calcularIdade(dataInicio) {
  if (!dataInicio) return null;
  let d;
  // BrasilAPI normalmente devolve "YYYY-MM-DD"
  if (typeof dataInicio === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dataInicio)) {
    d = new Date(dataInicio);
  } else if (typeof dataInicio === 'string' && /^\d{2}\/\d{2}\/\d{4}/.test(dataInicio)) {
    const [dd, mm, aaaa] = dataInicio.split('/');
    d = new Date(`${aaaa}-${mm}-${dd}`);
  } else {
    return null;
  }
  if (isNaN(d.getTime())) return null;
  const agora = new Date();
  let anos = agora.getFullYear() - d.getFullYear();
  // Ainda não fez aniversário este ano → desconta 1
  const m = agora.getMonth() - d.getMonth();
  if (m < 0 || (m === 0 && agora.getDate() < d.getDate())) anos--;
  return Math.max(0, anos);
}

// Devolve "nova" (< 1 ano), "jovem" (1–5), "consolidada" (> 5).
function faixaPorIdade(anos) {
  if (anos === null || anos === undefined) return 'desconhecida';
  if (anos < 1) return 'nova';
  if (anos <= 5) return 'jovem';
  return 'consolidada';
}

// Infere a categoria mais provável da empresa a partir do nome fantasia e
// da descrição do CNAE. Retorna { categoria, hits } ou null se nenhum
// gatilho bater. Usado como fallback quando CNAE é genérico.
function inferirCategoria(empresa) {
  const texto = [
    empresa.nomeFantasia || '',
    empresa.razao || '',
    empresa.cnaeDesc || '',
    (empresa.cnaesSecundarios || []).map(c => c.descricao || '').join(' ')
  ].join(' ').toLowerCase();
  let melhor = null;
  for (const [cat, gatilhos] of Object.entries(CATEGORIAS_GATILHO)) {
    const hits = gatilhos.filter(g => texto.includes(g)).length;
    if (hits > 0 && (!melhor || hits > melhor.hits)) {
      melhor = { categoria: cat, hits };
    }
  }
  return melhor;
}

// Verifica se um produto é claramente "enterprise" (alto valor, baixa
// relevância pra MEI/empresa nova).
function ehProdutoEnterprise(produto) {
  const txt = `${produto.nome || ''} ${produto.categoria || ''}`.toLowerCase();
  return PRODUTOS_ENTERPRISE.some(p => txt.includes(p));
}

function calcularTop5(empresa) {
  // ----- 1) Pesos vindos do usuário, redistribuídos entre os sinais novos -----
  // Internamente, "cnae" vira CNAE principal (50%) + secundários (20%),
  // "keywords" vira keywords (30%) + categoria inferida (30%) + match de
  // nome/razão (40%). O usuário não vê diferença, mas a distribuição fica
  // mais justa.
  const w = STATE.config.pesos;
  const totalW = (w.cnae || 0) + (w.regiao || 0) + (w.prioridade || 0) + (w.keywords || 0) || 100;
  // Pesos normalizados por categoria de sinal
  const pCnae   = (w.cnae || 0)      / totalW;  // bloco CNAE (principal + secundários)
  const pRegiao = (w.regiao || 0)    / totalW;  // bloco região
  const pPrio   = (w.prioridade || 0)/ totalW;  // bloco prioridade comercial
  const pKw     = (w.keywords || 0)  / totalW;  // bloco keywords (expandido)
  // Pesos internos de cada bloco (somam 1 dentro do bloco)
  const pCnaePrincipal  = 0.70; // 70% do peso "cnae" vai pro CNAE principal
  const pCnaeSecundario = 0.30; // 30% pros CNAEs secundários
  const pKwKeywords     = 0.30; // 30% do peso "keywords" pra match de keywords
  const pKwCategoria    = 0.30; // 30% pro match de categoria inferida
  const pKwNomeFantasia = 0.40; // 40% pro match contra nome/razão social

  // ----- 2) Inferência de categoria a partir do nome fantasia/CNAE -----
  const categoriaInferida = inferirCategoria(empresa);
  const categoriaInferidaNome = categoriaInferida?.categoria || null;

  // ----- 3) Penalidade por porte (MEI + produto enterprise) -----
  const ehMei = empresa.opcaoMei === true ||
    (empresa.porte && /micro.?empresa/i.test(empresa.porte) && /mei/i.test(empresa.porte));
  const empresaNova = empresa.faixaIdade === 'nova';

  // Conjunto de CNAEs secundários (códigos como strings) pra busca rápida
  const secundarios = (empresa.cnaesSecundarios || [])
    .map(c => String(c.codigo || ''))
    .filter(Boolean);

  const resultados = STATE.produtos.map(p => {
    // ===== BLOCO CNAE =====
    let cnaePrincipalScore = 0;
    if (p.cnaes) {
      const lista = p.cnaes.split(',').map(s => s.trim());
      if (lista.includes(String(empresa.cnae))) cnaePrincipalScore = 100;
      else {
        const raiz = String(empresa.cnae).slice(0, 5);
        if (lista.some(c => c.startsWith(raiz))) cnaePrincipalScore = 60;
        else {
          const raiz4 = String(empresa.cnae).slice(0, 4);
          if (lista.some(c => c.startsWith(raiz4))) cnaePrincipalScore = 30;
        }
      }
    }

    let cnaeSecundarioScore = 0;
    if (secundarios.length && p.cnaes) {
      const lista = p.cnaes.split(',').map(s => s.trim());
      // Pontuação: 70 se match exato em algum secundário; senão, raiz 5 = 40
      const matchExato = secundarios.some(c => lista.includes(c));
      if (matchExato) cnaeSecundarioScore = 70;
      else {
        const matchRaiz = secundarios.some(c => {
          const raiz5 = String(c).slice(0, 5);
          return lista.some(l => l.startsWith(raiz5));
        });
        if (matchRaiz) cnaeSecundarioScore = 40;
      }
    }

    // ===== BLOCO REGIÃO =====
    let regiaoScore = 0;
    if (!p.ufs || !p.ufs.trim()) regiaoScore = 50; // sem restrição = atende todas
    else {
      const lista = p.ufs.toUpperCase().split(',').map(s => s.trim());
      if (lista.includes(empresa.uf)) regiaoScore = 100;
    }

    // ===== BLOCO PRIORIDADE COMERCIAL =====
    const prioScore = Math.min(100, (p.prioridade || 0));

    // ===== BLOCO KEYWORDS (expandido) =====
    // 3a) Match de keywords do produto contra descrição do CNAE + natureza
    let kwScore = 0;
    if (p.keywords) {
      const kws = p.keywords.toLowerCase().split(',').map(s => s.trim());
      const textoCnae = `${empresa.cnaeDesc} ${empresa.natureza}`.toLowerCase();
      const hits = kws.filter(k => textoCnae.includes(k)).length;
      kwScore = Math.min(100, hits * 33);
    }

    // 3b) Match por categoria inferida (palavras-gatilho contra nome fantasia + CNAE)
    let categoriaScore = 0;
    if (categoriaInferidaNome && p.categoria) {
      // Match exato → 100; mesma raiz (ex: "Construção" e "Materiais de Construção") → 60
      const catProd = p.categoria.toLowerCase();
      const catInf  = categoriaInferidaNome.toLowerCase();
      if (catProd === catInf) categoriaScore = 100;
      else if (catProd.includes(catInf) || catInf.includes(catProd)) categoriaScore = 60;
    }

    // 3c) Match contra nome fantasia + razão social (palavras inteiras)
    let nomeFantasiaScore = 0;
    if (p.keywords) {
      const kws = p.keywords.toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
      const textoNome = `${empresa.nomeFantasia || ''} ${empresa.razao || ''}`.toLowerCase();
      const hits = kws.filter(k => {
        // Usa word-boundary-like: separa por não-letra pra evitar match parcial
        const re = new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z0-9]|$)`, 'i');
        return re.test(textoNome);
      }).length;
      nomeFantasiaScore = Math.min(100, hits * 40);
    }

    // ----- Combinação ponderada (mantendo o score na escala 0–100) -----
    // Cada bloco contribui com seu peso externo × seu peso interno × seu score.
    const scoreCnaeBloco   = (cnaePrincipalScore * pCnaePrincipal + cnaeSecundarioScore * pCnaeSecundario);
    const scoreKwBloco     = (kwScore * pKwKeywords + categoriaScore * pKwCategoria + nomeFantasiaScore * pKwNomeFantasia);
    const score =
      scoreCnaeBloco   * pCnae +
      regiaoScore      * pRegiao +
      prioScore        * pPrio +
      scoreKwBloco     * pKw;

    // ----- Penalidade por porte (não exclui, só rebaixa) -----
    let penalidade = 1.0;
    if (ehMei && ehProdutoEnterprise(p)) penalidade = 0.7;
    else if (empresaNova && ehProdutoEnterprise(p)) penalidade = 0.85;

    const scoreFinal = Math.round(score * penalidade);

    // ----- Motivos resumidos (mostrados na UI) -----
    const motivos = [];
    if (cnaePrincipalScore === 100) motivos.push('CNAE compatível');
    else if (cnaePrincipalScore > 0) motivos.push(`Setor próximo (CNAE ${cnaePrincipalScore === 60 ? 'mesma classe' : 'mesma subclasse'})`);
    if (cnaeSecundarioScore > 0) motivos.push('CNAE secundário compatível');
    if (regiaoScore === 100) motivos.push(`Atende ${empresa.uf}`);
    else if (regiaoScore === 0) motivos.push('Fora da região padrão');
    if (prioScore >= 60) motivos.push('Produto prioritário');
    if (categoriaScore > 0) motivos.push('Categoria inferida');
    if (nomeFantasiaScore > 0) motivos.push('Nome do cliente compatível');
    if (kwScore >= 33) motivos.push('Palavras-chave compatíveis');
    if (penalidade < 1) motivos.push('Porte × produto: ajustar IA');

    return {
      produto: p,
      score: scoreFinal,
      scoreAlgoritmo: scoreFinal,
      cnaeScore: cnaePrincipalScore,
      cnaeSecundarioScore,
      regiaoScore,
      kwScore,
      categoriaScore,
      nomeFantasiaScore,
      penalidade,
      motivo: motivos,
      // Flags que vão pra IA depois
      ehEnterprise: ehProdutoEnterprise(p),
      categoriaProduto: p.categoria
    };
  });

  // ----- 4) Ordena e seleciona Top 7 (1 a mais que o final, pra IA poder excluir 1 se quiser) -----
  resultados.sort((a, b) => b.score - a.score);
  const top7 = resultados.slice(0, 7);
  const top5 = resultados.slice(0, 5);
  const afinidade = Math.round(top5.reduce((s, r) => s + r.score, 0) / top5.length);

  // ----- 5) Detecta se é fallback (nenhum match direto) -----
  const temMatchDireto = resultados.some(r =>
    r.cnaeScore === 100 || r.cnaeSecundarioScore >= 70
  );
  const fallbackSimilaridade = !temMatchDireto;

  return {
    itens: top7,                 // IA recebe 7 candidatos
    itensFinais: top5.slice(),   // UI recebe 5 (vai ser sobrescrito pela IA se ela responder)
    afinidade,
    fallbackSimilaridade,
    categoriaInferidaNome
  };
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
function renderTop5(itens, empresa, opcoes = {}) {
  // opcoes = { fallbackSimilaridade, categoriaInferida, iaDisponivel }
  const list = $('#top5List');
  list.innerHTML = '';
  // Aviso de "match por similaridade" quando o algoritmo não achou nada direto
  if (opcoes.fallbackSimilaridade) {
    const warn = document.createElement('div');
    warn.className = 'aviso-similaridade';
    warn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ` +
      `Nenhum produto deste catálogo tem match direto com o CNAE do cliente. ` +
      `Recomendação por similaridade${opcoes.categoriaInferida ? ` (categoria inferida: <b>${opcoes.categoriaInferida}</b>)` : ''}.`;
    list.appendChild(warn);
  }
  itens.forEach((it, i) => {
    const p = it.produto;
    const card = document.createElement('div');
    card.className = 'top5-card';
    const meta = `
      <span><b>${p.marca || '—'}</b></span>
      <span>${p.categoria || '—'}</span>
    `;
    // Selo de confiança (só mostra se houver nível definido)
    const nivelConfianca = it.confianca || null;
    const confHtml = nivelConfianca
      ? `<div class="confianca-badge conf-${nivelConfianca}" title="Confiança: ${nivelConfianca}">${
          nivelConfianca === 'alta' ? '●●● Alta'
            : nivelConfianca === 'media' ? '●● Média'
            : '● Baixa'
        }</div>`
      : '';
    card.innerHTML = `
      <div class="top5-rank">${i + 1}</div>
      <div class="top5-content">
        <h4>${p.nome}</h4>
        <div class="meta">${meta}</div>
        <div class="top5-motivo loading" id="motivo-${i}">
          <i class="fa-solid fa-circle-notch fa-spin"></i> ${opcoes.iaDisponivel ? 'Reavaliando com IA…' : (it.motivo.length ? it.motivo.join(' • ') : 'Recomendado pelo algoritmo de scoring.')}
        </div>
      </div>
      <div class="top5-actions">
        <div class="top5-score">${it.score}<small>score</small></div>
        ${confHtml}
      </div>
    `;
    list.appendChild(card);
  });
}

// =========================================================
// ENRIQUECIMENTO / RE-RANKING COM IA (Groq)
//
// A IA aqui deixou de ser só "geradora de texto". Ela é JUIZ e
// RE-RANKEADOR: recebe os 7 candidatos do algoritmo e devolve os 5
// finais (pode excluir 1 ou 2 se julgar incompatíveis), com score
// próprio + nível de confiança + frase PT-BR.
//
// Score final = 60% IA + 40% algoritmo (com fallback gracioso).
// =========================================================
async function enriquecerComIA(itens, empresa, itensFinais, opcoes) {
  // Sem chave Groq → mantém o resultado algorítmico como está e remove o
  // spinner dos cards (UX atual preservada).
  if (!STATE.config.groq.apiKey) {
    itensFinais.forEach((it, i) => {
      const m = $(`#motivo-${i}`);
      if (m) {
        m.classList.remove('loading');
        m.innerHTML = `<i class="fa-solid fa-info-circle"></i> ${it.motivo.join(' • ') || 'Recomendado pelo algoritmo de scoring.'}`;
      }
    });
    return;
  }

  // Monta o prompt estruturado. Inserimos os IDs (1..7) pra IA referenciar
  // os produtos sem ambiguidade.
  const secundTxt = (empresa.cnaesSecundarios || []).slice(0, 6)
    .map(c => `${c.codigo} (${c.descricao})`).join('; ') || 'nenhum';

  const prompt = `Você é um assistente comercial sênior de uma distribuidora brasileira.

REGRAS OBRIGATÓRIAS:
- Avalie CADA produto considerando o contexto real do cliente (porte, ramo, região, idade).
- Você pode REDUZIR o ranking de um produto (dar score menor) se ele não fizer sentido real, mesmo que o CNAE bata (ex: empilhadeira pra MEI, equipamento industrial caro pra empresa nova).
- Você pode EXCLUIR um produto se ele for claramente incompatível. Nesse caso, dê score 0 e explique em 1 frase.
- NÃO invente produtos — use apenas os IDs fornecidos.

Empresa cliente:
- Razão social: ${empresa.razao}
- Nome fantasia: ${empresa.nomeFantasia || 'não informado'}
- CNAE principal: ${empresa.cnae} — ${empresa.cnaeDesc}
- CNAEs secundários: ${secundTxt}
- Localização: ${empresa.cidade}/${empresa.uf}
- Porte: ${empresa.porte}
- Idade: ${empresa.idadeAnos ?? '?'} anos (${empresa.faixaIdade})

Produtos candidatos (com score algorítmico atual):
${itens.map((it, i) => `[ID ${i + 1}] ${it.produto.nome} | ${it.produto.marca} | Cat: ${it.produto.categoria} | Score atual: ${it.score} | Motivos: ${it.motivo.join(', ')}`).join('\n')}

Tarefa:
1. Devolva um JSON com a lista REORDENADA, no formato:
   {"ranking":[{"id":N,"score":0-100,"confianca":"alta"|"media"|"baixa","frase":"…"},{"id":N,"score":…,"confianca":…,"frase":"…"}, …]}
2. A frase deve ser PT-BR, máx 18 palavras, justificando a recomendação em UMA linha.
3. Confiança "alta" = match perfeito de CNAE + porte compatível. "media" = match parcial. "baixa" = forçado por categoria/keywords.
4. Mantenha APENAS os 5 produtos. Se decidir que um produto não deve aparecer, remova-o da lista (você recebe 7 candidatos, devolve 5).

Responda APENAS o JSON puro, sem markdown.`;

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
          { role: 'system', content: 'Você é um classificador comercial. Responda APENAS JSON válido, sem markdown.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 1000
      })
    });
    if (!resp.ok) throw new Error(`Groq ${resp.status}: ${(await resp.text()).slice(0, 120)}`);
    const data = await resp.json();
    const txt = (data.choices?.[0]?.message?.content || '').trim();

    // Parse robusto: tira fences ```json se houver
    const clean = txt.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
    let parsed;
    try {
      parsed = JSON.parse(clean);
    } catch (e1) {
      // Fallback: tenta achar o primeiro {...}
      const m = clean.match(/\{[\s\S]*\}/);
      if (!m) throw new Error('Resposta da IA não contém JSON.');
      parsed = JSON.parse(m[0]);
    }
    const ranking = Array.isArray(parsed.ranking) ? parsed.ranking : [];

    // ===== Combinação 60% IA + 40% algoritmo =====
    const idsVistos = new Set();
    const combinados = [];
    for (const r of ranking) {
      const id = parseInt(r.id, 10);
      if (!Number.isFinite(id) || id < 1 || id > itens.length) continue;
      if (idsVistos.has(id)) continue;
      idsVistos.add(id);
      const cand = itens[id - 1];
      if (!cand) continue;
      const scoreIA = Math.max(0, Math.min(100, parseInt(r.score, 10) || 0));
      const scoreAlg = cand.score || 0;
      const scoreFinal = Math.round(scoreIA * 0.6 + scoreAlg * 0.4);
      const confianca = ['alta', 'media', 'baixa'].includes(r.confianca) ? r.confianca : nivelConfiancaPorScore(scoreFinal);
      combinados.push({
        ...cand,
        score: scoreFinal,
        scoreAlgoritmo: scoreAlg,
        scoreIA,
        confianca,
        fraseIA: (r.frase || '').slice(0, 140),
        motivo: [cand.motivo.join(' • '), r.frase].filter(Boolean)
      });
      if (combinados.length === 5) break;
    }

    // Se a IA devolveu menos de 5, completa com os próximos do algoritmo
    // que ainda não foram vistos.
    if (combinados.length < 5) {
      for (const cand of itens) {
        if (combinados.length >= 5) break;
        if (idsVistos.has(itens.indexOf(cand) + 1)) continue;
        idsVistos.add(itens.indexOf(cand) + 1);
        combinados.push({
          ...cand,
          score: cand.score,
          scoreAlgoritmo: cand.score,
          scoreIA: null,
          confianca: opcoes.fallbackSimilaridade ? 'baixa' : 'media',
          fraseIA: '',
          motivo: cand.motivo
        });
      }
    }

    // Garante exatamente 5 itens
    while (combinados.length < 5) {
      combinados.push({
        produto: { nome: '—', marca: '—', categoria: '—' },
        score: 0, motivo: ['Sem mais opções'], confianca: 'baixa', fraseIA: ''
      });
    }
    const finalItens = combinados.slice(0, 5);

    // ===== Re-render (sobrescreve os cards com a versão final da IA) =====
    $('#top5List').innerHTML = '';
    // Aviso de fallback continua se aplicável
    if (opcoes.fallbackSimilaridade) {
      const warn = document.createElement('div');
      warn.className = 'aviso-similaridade';
      warn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> ` +
        `Nenhum produto deste catálogo tem match direto com o CNAE do cliente. ` +
        `Recomendação por similaridade${opcoes.categoriaInferida ? ` (categoria inferida: <b>${opcoes.categoriaInferida}</b>)` : ''}.`;
      $('#top5List').appendChild(warn);
    }
    finalItens.forEach((it, i) => {
      const p = it.produto;
      const card = document.createElement('div');
      card.className = 'top5-card';
      const meta = `<span><b>${p.marca || '—'}</b></span><span>${p.categoria || '—'}</span>`;
      const confHtml = it.confianca
        ? `<div class="confianca-badge conf-${it.confianca}" title="Confiança: ${it.confianca}">${
            it.confianca === 'alta' ? '●●● Alta'
              : it.confianca === 'media' ? '●● Média'
              : '● Baixa'
          }</div>` : '';
      card.innerHTML = `
        <div class="top5-rank">${i + 1}</div>
        <div class="top5-content">
          <h4>${p.nome}</h4>
          <div class="meta">${meta}</div>
          <div class="top5-motivo">
            <i class="fa-solid fa-sparkles" style="color:var(--lima)"></i> ${escapeHtml(it.fraseIA) || (it.motivo.join(' • ') || 'Recomendado pelo algoritmo.')}
          </div>
        </div>
        <div class="top5-actions">
          <div class="top5-score">${it.score}<small>score</small></div>
          ${confHtml}
        </div>
      `;
      $('#top5List').appendChild(card);
    });

    // Atualiza afinidade geral baseada no score final combinado
    const afin = Math.round(finalItens.reduce((s, r) => s + r.score, 0) / finalItens.length);
    const circle = $('#scoreCircle');
    if (circle) circle.style.setProperty('--p', afin + '%');
    const sv = $('#scoreValue');
    if (sv) sv.textContent = afin;
  } catch (e) {
    console.warn('IA falhou:', e);
    // Fallback: deixa o resultado algorítmico no lugar e remove spinner
    itensFinais.forEach((it, i) => {
      const m = $(`#motivo-${i}`);
      if (m) {
        m.classList.remove('loading');
        m.innerHTML = `<i class="fa-solid fa-exclamation-triangle" style="color:var(--yellow)"></i> IA indisponível: ${e.message.slice(0, 60)}. ${it.motivo.join(' • ')}`;
      }
    });
  }
}

// Deriva o nível de confiança a partir do score numérico (fallback quando
// a IA não devolve o campo "confianca").
function nivelConfiancaPorScore(score) {
  if (score >= 75) return 'alta';
  if (score >= 50) return 'media';
  return 'baixa';
}

// Helper mínimo pra evitar quebrar o render se a IA devolver HTML/& raro.
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, ch => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[ch]));
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
  // Bloqueia criar conta com o email do admin fixo: ele já existe (criado
  // automaticamente no boot pelo garantirAdminExiste), e nunca deve ser
  // sobrescrito nem duplicado.
  if (isAdminFixo(email)) {
    $('#criarUserStatus').textContent = '✗ Este email é o do admin fixo';
    toast('O admin fixo (' + ADMIN_EMAIL + ') já existe e não pode ser recriado.', 'error');
    return;
  }

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
      // Faz logout imediatamente e volta para a tela de login.
      // O toast de sucesso fica visível na próxima tela.
      await firebaseAuth.signOut();
      STATE.user = null;
      mostrarLogin();
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

// =========================================================
// SOLICITAÇÕES DE ACESSO PENDENTES (só Admin aprova/recusa)
// =========================================================
function atualizarBadgePendentes(qtd) {
  const badge = $('#pendingBadge');
  if (!badge) return;
  if (qtd > 0) { badge.textContent = qtd; badge.style.display = ''; }
  else { badge.style.display = 'none'; }

  // Espelha a contagem no card de solicitações (cabeçalho "Solicitações
  // de acesso pendentes"). Mantém os dois visíveis e em sincronia para que
  // o admin sempre veja se há pedidos aguardando, mesmo que o badge da
  // sidebar esteja pequeno demais.
  const count = $('#solicitacoesCount');
  if (count) {
    if (qtd > 0) { count.textContent = qtd + (qtd === 1 ? ' pendente' : ' pendentes'); count.style.display = ''; }
    else { count.style.display = 'none'; }
  }
}

// Função utilitária de ordenação: usa criadoEm (serverTimestamp do Firestore)
// e cai pro criadoEmLocal (ISO string que gravamos no signup) caso o server
// timestamp ainda não tenha sido propagado pelo Firestore. Evita que uma
// solicitação "fresca" fique embaixo da lista enquanto o timestamp não chega.
function tsOrdenacao(u) {
  const ce = u && u.criadoEm;
  if (ce && typeof ce.toMillis === 'function') return ce.toMillis();
  if (ce && typeof ce === 'object' && ce.seconds) return ce.seconds * 1000;
  if (ce) { const t = new Date(ce).getTime(); if (!isNaN(t)) return t; }
  if (u && u.criadoEmLocal) { const t = new Date(u.criadoEmLocal).getTime(); if (!isNaN(t)) return t; }
  return 0;
}

// =========================================================
// DIAGNÓSTICO FIRESTORE (admin) — testa se o admin consegue ler/escrever
// na coleção "usuarios". Mostra avisos proativos quando as regras estão
// bloqueando, evitando que o admin fique "achando que não há solicitações".
// =========================================================
async function diagnosticarFirestoreAdmin() {
  const box = $('#firestoreDiag');
  const content = $('#firestoreDiagContent');
  if (!box || !content) return;
  if (APP_MODE !== 'firebase' || !firebaseDb || !isAdmin()) { box.style.display = 'none'; return; }
  box.style.display = '';
  content.innerHTML = '<p class="muted"><i class="fa-solid fa-circle-info"></i> Verificando permissões do Firestore…</p>';
  const resultado = { leitura: null, contagem: null, docExemplo: null };
  try {
    const snap = await firebaseDb.collection('usuarios').limit(1).get();
    resultado.leitura = 'ok';
    resultado.contagem = snap.size;
    if (!snap.empty) {
      const d = snap.docs[0];
      resultado.docExemplo = { id: d.id, email: d.data().email, role: d.data().role };
    }
  } catch (e) {
    resultado.leitura = 'erro: ' + (e.code || e.message);
  }
  let html = '';
  if (resultado.leitura === 'ok') {
    html = `<p style="color:var(--green);font-size:13px"><i class="fa-solid fa-circle-check"></i> Leitura da coleção <code>usuarios</code> funcionando (${resultado.contagem} doc(s) visíveis).</p>`;
  } else {
    html = `<p style="color:var(--red);font-size:13px"><i class="fa-solid fa-triangle-exclamation"></i> <b>Não consigo ler a coleção <code>usuarios</code>.</b> Suas regras do Firestore estão bloqueando. Para liberar:</p>
      <ol style="font-size:12px;color:var(--muted);margin:8px 0 8px 24px">
        <li>Abra o <a href="https://console.firebase.google.com" target="_blank">Firebase Console</a> → Firestore → Rules</li>
        <li>Cole as regras do README do projeto (seção 🔥 Firebase)</li>
        <li>Publique e atualize esta página</li>
      </ol>
      <details style="font-size:11px;color:var(--muted)"><summary>Detalhes técnicos</summary><code>${resultado.leitura}</code></details>`;
  }
  content.innerHTML = html;
}

async function renderSolicitacoes() {
  const box = $('#solicitacoesList');
  if (!box || !isAdmin()) return;

  // MODO FIREBASE
  if (APP_MODE === 'firebase' && firebaseDb) {
    try {
      // Não usamos .where('role','==','pendente') aqui de propósito: junto
      // com .orderBy('criadoEm','desc') isso exigiria um índice composto
      // no Firestore. Sem o índice criado, a query falha em silêncio e o
      // card mostra "Nenhuma solicitação" mesmo havendo cadastros. Então
      // puxamos todos os docs ordenados por criadoEm (desc) e filtramos no
      // cliente — funciona com QUALQUER coleção e não precisa índice.
      const snap = await firebaseDb.collection('usuarios').orderBy('criadoEm', 'desc').get();
      const pendentes = snap.docs
        .map(d => ({ id: d.id, ...d.data() }))
        .filter(u => u.role === 'pendente' && (u.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase())
        // Fallback de ordenação: se o criadoEm do Firestore ainda não chegou,
        // usa o criadoEmLocal (ISO string que gravamos no signup).
        .sort((a, b) => {
          const ta = tsOrdenacao(a);
          const tb = tsOrdenacao(b);
          return tb - ta;
        });

      if (!pendentes.length) {
        box.innerHTML = '<p class="muted">Nenhuma solicitação pendente.</p>';
        atualizarBadgePendentes(0);
        return;
      }
      let html = '<table class="smart-table"><thead><tr><th>Nome</th><th>Email</th><th>Setor/Cargo</th><th></th></tr></thead><tbody>';
      pendentes.forEach(u => {
        html += `<tr>
          <td>${u.nome || '—'}</td>
          <td>${u.email}</td>
          <td class="muted">${u.setor || '—'}</td>
          <td style="display:flex;gap:6px">
            <button class="btn-primary" style="padding:6px 10px;font-size:12px" data-aprovar="${u.id}"><i class="fa-solid fa-check"></i> Aprovar</button>
            <button class="row-actions-cell" data-recusar="${u.id}" title="Recusar"><i class="fa-solid fa-xmark"></i></button>
          </td>
        </tr>`;
      });
      html += '</tbody></table>';
      box.innerHTML = html;
      atualizarBadgePendentes(pendentes.length);

      $$('[data-aprovar]').forEach(b => b.addEventListener('click', async () => {
        await firebaseDb.collection('usuarios').doc(b.dataset.aprovar).update({ role: 'consultor' });
        toast('Consultor aprovado!', 'success');
        renderSolicitacoes(); renderUsersList();
      }));
      $$('[data-recusar]').forEach(b => b.addEventListener('click', async () => {
        if (!confirm('Recusar esta solicitação de acesso?')) return;
        await firebaseDb.collection('usuarios').doc(b.dataset.recusar).update({ role: 'recusado' });
        toast('Solicitação recusada.', 'info');
        renderSolicitacoes();
      }));
    } catch (e) {
      console.warn('renderSolicitacoes firebase:', e);
      // Mensagem mais útil para os casos mais comuns de erro:
      // - permission-denied: as regras do Firestore estão bloqueando a leitura
      //   da coleção "usuarios" pelo admin. O admin precisa liberar isso no
      //   Firebase Console → Firestore → Rules.
      // - unavailable: problema de rede / Firestore offline.
      let msg = 'Erro ao carregar solicitações.';
      if (e.code === 'permission-denied' || (e.message && e.message.includes('permission'))) {
        msg = 'Sem permissão para ler a coleção "usuarios". Configure as regras do Firestore (veja o README, seção 🔥 Firebase).';
      } else if (e.code === 'unavailable') {
        msg = 'Firestore indisponível no momento. Verifique sua conexão.';
      }
      box.innerHTML = `<p class="muted">${msg}</p>`;
    }
    return;
  }

  // MODO LOCAL
  const users = getLocalUsers();
  const pendentes = users
    .filter(u => u.role === 'pendente' && (u.email || '').toLowerCase() !== ADMIN_EMAIL.toLowerCase())
    .sort((a, b) => {
      // Mais recente primeiro (pendentes sem criadoEm vão para o fim)
      const ta = a.criadoEm ? new Date(a.criadoEm).getTime() : 0;
      const tb = b.criadoEm ? new Date(b.criadoEm).getTime() : 0;
      return tb - ta;
    });
  if (!pendentes.length) {
    box.innerHTML = '<p class="muted">Nenhuma solicitação pendente.</p>';
    atualizarBadgePendentes(0);
    return;
  }
  let html = '<table class="smart-table"><thead><tr><th>Nome</th><th>Email</th><th>Setor/Cargo</th><th></th></tr></thead><tbody>';
  pendentes.forEach(u => {
    html += `<tr>
      <td>${u.nome || '—'}</td>
      <td>${u.email}</td>
      <td class="muted">${u.setor || '—'}</td>
      <td style="display:flex;gap:6px">
        <button class="btn-primary" style="padding:6px 10px;font-size:12px" data-aprovar-local="${u.id}"><i class="fa-solid fa-check"></i> Aprovar</button>
        <button class="row-actions-cell" data-recusar-local="${u.id}" title="Recusar"><i class="fa-solid fa-xmark"></i></button>
      </td>
    </tr>`;
  });
  html += '</tbody></table>';
  box.innerHTML = html;
  atualizarBadgePendentes(pendentes.length);

  $$('[data-aprovar-local]').forEach(b => b.addEventListener('click', () => {
    const list = getLocalUsers();
    const u = list.find(x => x.id === b.dataset.aprovarLocal);
    if (u) u.role = 'consultor';
    setLocalUsers(list);
    toast('Consultor aprovado!', 'success');
    renderSolicitacoes(); renderUsersList();
  }));
  $$('[data-recusar-local]').forEach(b => b.addEventListener('click', () => {
    if (!confirm('Recusar esta solicitação de acesso?')) return;
    setLocalUsers(getLocalUsers().filter(x => x.id !== b.dataset.recusarLocal));
    toast('Solicitação recusada.', 'info');
    renderSolicitacoes();
  }));
}

async function renderUsersList() {
  const box = $('#usersList');
  // Linha HTML reutilizável do admin fixo: aparece sempre no topo, sem
  // botões de ação (é imutável). O cadeado 🔒 reforça visualmente.
  const adminFixoRow = `
    <tr style="background:rgba(0,120,64,.04)">
      <td><b>${ADMIN_EMAIL}</b> <i class="fa-solid fa-lock" title="Admin fixo — não editável" style="color:var(--muted);font-size:11px"></i></td>
      <td><span class="role-badge role-admin">admin (fixo)</span></td>
      <td class="muted">sistema</td>
      <td></td>
    </tr>`;

  // MODO FIREBASE: lista do Firestore
  if (APP_MODE === 'firebase' && firebaseDb) {
    try {
      const snap = await firebaseDb.collection('usuarios').orderBy('email').get();
      let html = '<table class="smart-table"><thead><tr><th>Email</th><th>Role</th><th>Criado por</th><th></th></tr></thead><tbody>';
      html += adminFixoRow;
      if (!snap.empty) {
        snap.forEach(d => {
          const u = d.data();
          if (isAdminFixo(u.email)) return; // já exibido como admin fixo
          if (u.role === 'pendente' || u.role === 'recusado') return; // aparecem no painel de solicitações
          html += `<tr>
            <td>${u.email}</td>
            <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-consultor'}">${u.role}</span></td>
            <td class="muted">${u.criadoPor || '—'}</td>
            <td>
              <div class="row-actions-cell">
                <button data-edit-user="${d.id}" title="Editar"><i class="fa-solid fa-pen"></i></button>
                <button class="danger" data-del-user="${d.id}" title="Excluir"><i class="fa-solid fa-trash"></i></button>
              </div>
            </td>
          </tr>`;
        });
      }
      html += '</tbody></table>';
      box.innerHTML = html;
      // Liga os handlers de editar e excluir para os botões que acabaram de ser renderizados
      $$('[data-edit-user]').forEach(b => b.addEventListener('click', () => editarUsuario(b.dataset.editUser)));
      $$('[data-del-user]').forEach(b => b.addEventListener('click', () => excluirUsuario(b.dataset.delUser)));
    } catch (e) {
      console.warn('renderUsersList firebase:', e);
      box.innerHTML = '<p class="muted">Erro ao listar usuários.</p>';
    }
    return;
  }

  // MODO LOCAL: lista do localStorage
  const users = getLocalUsers();
  let html = '<table class="smart-table"><thead><tr><th>Email</th><th>Role</th><th>Criado por</th><th></th></tr></thead><tbody>';
  html += adminFixoRow;
  const aprovados = users.filter(u => u.role !== 'pendente' && u.role !== 'recusado' && !isAdminFixo(u.email));
  if (aprovados.length) {
    aprovados.forEach(u => {
      html += `<tr>
        <td>${u.email}</td>
        <td><span class="role-badge ${u.role === 'admin' ? 'role-admin' : 'role-consultor'}">${u.role}</span></td>
        <td class="muted">${u.criadoPor || '—'}</td>
        <td>
          <div class="row-actions-cell">
            <button data-edit-user-local="${u.id}" title="Editar"><i class="fa-solid fa-pen"></i></button>
            <button class="danger" data-del-user-local="${u.id}" title="Excluir"><i class="fa-solid fa-trash"></i></button>
          </div>
        </td>
      </tr>`;
    });
  }
  html += '</tbody></table>';
  if (APP_MODE === 'local') {
    html += '<p class="muted" style="margin-top:10px"><i class="fa-solid fa-circle-info"></i> Modo local: usuários existem só neste navegador. Para sync entre dispositivos, configure o Firebase em Configurações.</p>';
  }
  box.innerHTML = html;
  $$('[data-edit-user-local]').forEach(b => b.addEventListener('click', () => editarUsuarioLocal(b.dataset.editUserLocal)));
  $$('[data-del-user-local]').forEach(b => b.addEventListener('click', () => excluirUsuarioLocal(b.dataset.delUserLocal)));
}

// =========================================================
// EDIÇÃO / EXCLUSÃO / RESET DE USUÁRIOS (Admin)
// Proteções:
//   - Admin fixo (definido em _decodeAdmin) nunca é editável/excluível
//   - Não se pode rebaixar/excluir o último admin do sistema
//   - Histórico de consultas é preservado (não apaga subcoleções)
// =========================================================

// Abre o modal de edição com os dados do usuário (modo Firebase).
async function editarUsuario(uid) {
  if (!isAdmin()) { toast('Apenas administradores podem editar usuários.', 'error'); return; }
  try {
    const doc = await firebaseDb.collection('usuarios').doc(uid).get();
    if (!doc.exists) { toast('Usuário não encontrado.', 'error'); return; }
    const u = doc.data();
    if (isAdminFixo(u.email)) {
      toast('O admin fixo não pode ser editado.', 'info');
      return;
    }
    abrirModalEdicaoUser({
      id: uid,
      email: u.email,
      nome: u.nome || '',
      setor: u.setor || '',
      role: u.role || 'consultor',
      adminFixo: false
    });
  } catch (e) {
    console.warn('editarUsuario:', e);
    toast('Erro ao carregar usuário: ' + e.message, 'error');
  }
}

// Modo local
function editarUsuarioLocal(id) {
  if (!isAdmin()) { toast('Apenas administradores podem editar usuários.', 'error'); return; }
  const u = getLocalUsers().find(x => x.id === id);
  if (!u) { toast('Usuário não encontrado.', 'error'); return; }
  if (isAdminFixo(u.email)) {
    toast('O admin fixo não pode ser editado.', 'info');
    return;
  }
  abrirModalEdicaoUser({
    id: id,
    email: u.email,
    nome: u.nome || '',
    setor: u.setor || '',
    role: u.role || 'consultor',
    adminFixo: false
  });
}

// Preenche e exibe o modal de edição. Recebe os dados já lidos do Firestore/local.
async function abrirModalEdicaoUser(dados) {
  if (!isAdmin()) return;
  const aviso = $('#userEditAviso');
  // Reset estado
  aviso.style.display = 'none';
  aviso.textContent = '';
  $('#userEditId').value = dados.id;
  $('#userEditEmailOriginal').value = dados.email;
  $('#userEditEmail').textContent = dados.email;
  $('#userEditNome').value = dados.nome;
  $('#userEditSetor').value = dados.setor;
  $('#userEditRole').value = dados.role;
  const nomeInput = $('#userEditNome');
  const setorInput = $('#userEditSetor');
  const roleSelect = $('#userEditRole');
  const btnReset = $('#btnUserResetSenha');

  if (dados.adminFixo) {
    // Modo somente-leitura: admin fixo não pode ser editado
    nomeInput.disabled = true; setorInput.disabled = true; roleSelect.disabled = true;
    aviso.textContent = 'Admin fixo — esta conta é imutável (não pode ser editada nem excluída).';
    aviso.style.display = 'block';
    btnReset.style.display = 'none';
  } else {
    nomeInput.disabled = false; setorInput.disabled = false;
    btnReset.style.display = '';
    // Se o usuário é admin mas for o ÚNICO admin do sistema, bloqueia o rebaixamento
    // (não dá pra deixar o app sem admin). O admin fixo é contado separado.
    if (dados.role === 'admin') {
      const total = await contarAdmins();
      if (total <= 1) {
        roleSelect.disabled = true;
        aviso.textContent = 'Este é o único admin do sistema. Promova outro consultor antes de rebaixar este.';
        aviso.style.display = 'block';
      } else {
        roleSelect.disabled = false;
      }
    } else {
      roleSelect.disabled = false;
    }
    // No modo local, sem Firebase Auth, o reset de senha não funciona
    if (APP_MODE !== 'firebase' || !firebaseAuth) {
      btnReset.disabled = true;
      btnReset.title = 'Reset de senha só funciona no modo Firebase';
    } else {
      btnReset.disabled = false;
      btnReset.title = '';
    }
  }
  $('#userEditModal').style.display = 'flex';
}

function fecharModalEdicaoUser() {
  $('#userEditModal').style.display = 'none';
  $('#userEditId').value = '';
  $('#userEditEmailOriginal').value = '';
  $('#userEditNome').value = '';
  $('#userEditSetor').value = '';
  $('#userEditRole').value = 'consultor';
  $('#userEditNome').disabled = false;
  $('#userEditSetor').disabled = false;
  $('#userEditRole').disabled = false;
  $('#btnUserResetSenha').disabled = false;
  $('#btnUserResetSenha').style.display = '';
  $('#userEditAviso').style.display = 'none';
}

// Submit do modal — salva no Firestore (ou localStorage)
$('#userEditForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  if (!isAdmin()) return;
  const id = $('#userEditId').value;
  const email = $('#userEditEmailOriginal').value;
  if (isAdminFixo(email)) { toast('Admin fixo não pode ser editado.', 'error'); fecharModalEdicaoUser(); return; }
  const novoNome = $('#userEditNome').value.trim();
  const novoSetor = $('#userEditSetor').value.trim();
  const novoRole = $('#userEditRole').value;
  if (novoRole !== 'consultor' && novoRole !== 'admin') {
    toast('Role inválido.', 'error'); return;
  }
  // Bloqueio: se está rebaixando admin para consultor e ele é o último
  if (novoRole === 'consultor') {
    const doc = APP_MODE === 'firebase'
      ? await firebaseDb.collection('usuarios').doc(id).get()
      : { data: () => getLocalUsers().find(u => u.id === id) };
    const u = doc.data ? doc.data() : doc;
    if (u && u.role === 'admin' && !isAdminFixo(u.email)) {
      const total = await contarAdmins();
      if (total <= 1) {
        toast('Não é possível rebaixar o último admin do sistema. Promova outro antes.', 'error');
        return;
      }
    }
  }

  if (APP_MODE === 'firebase' && firebaseDb) {
    try {
      await firebaseDb.collection('usuarios').doc(id).update({
        nome: novoNome,
        setor: novoSetor || null,
        role: novoRole,
        atualizadoEm: firebase.firestore.FieldValue.serverTimestamp(),
        atualizadoPor: STATE.user?.email || 'admin'
      });
      toast('Usuário atualizado.', 'success');
      fecharModalEdicaoUser();
      renderUsersList();
    } catch (e) {
      console.warn('salvar edicao user firebase:', e);
      toast('Erro ao salvar: ' + e.message, 'error');
    }
  } else {
    const list = getLocalUsers();
    const u = list.find(x => x.id === id);
    if (u) {
      u.nome = novoNome; u.setor = novoSetor || null; u.role = novoRole;
      u.atualizadoEm = new Date().toISOString();
      setLocalUsers(list);
      toast('Usuário atualizado.', 'success');
      fecharModalEdicaoUser();
      renderUsersList();
    } else {
      toast('Usuário não encontrado.', 'error');
    }
  }
});

// Excluir usuário (modo Firebase)
async function excluirUsuario(uid) {
  if (!isAdmin()) { toast('Apenas administradores podem excluir usuários.', 'error'); return; }
  try {
    const doc = await firebaseDb.collection('usuarios').doc(uid).get();
    if (!doc.exists) { toast('Usuário não encontrado.', 'error'); return; }
    const u = doc.data();
    if (isAdminFixo(u.email)) { toast('O admin fixo não pode ser excluído.', 'error'); return; }
    if (u.role === 'admin') {
      const total = await contarAdmins();
      if (total <= 1) { toast('Não é possível excluir o último admin do sistema.', 'error'); return; }
    }
    if (!confirm(`Excluir o usuário ${u.email}?\n\nEsta ação remove o acesso dele ao sistema. O histórico de consultas é preservado para auditoria.`)) return;
    // Apaga só o doc Firestore. A conta no Firebase Auth fica "órfã" — o
    // usuário não consegue mais logar porque perde o doc com role (cai em
    // 'pendente'). Apagar a conta Auth exigiria Cloud Function ou Admin SDK.
    await firebaseDb.collection('usuarios').doc(uid).delete();
    toast('Usuário excluído.', 'success');
    renderUsersList();
  } catch (e) {
    console.warn('excluirUsuario:', e);
    toast('Erro ao excluir: ' + e.message, 'error');
  }
}

// Excluir usuário (modo local)
function excluirUsuarioLocal(id) {
  if (!isAdmin()) { toast('Apenas administradores podem excluir usuários.', 'error'); return; }
  const list = getLocalUsers();
  const u = list.find(x => x.id === id);
  if (!u) { toast('Usuário não encontrado.', 'error'); return; }
  if (isAdminFixo(u.email)) { toast('O admin fixo não pode ser excluído.', 'error'); return; }
  if (u.role === 'admin') {
    // No modo local, conta local + admin fixo. Se for o único admin não-fixo,
    // o sistema ainda tem o admin fixo. Permitimos excluir (o fixo cobre).
    // Mas se o próprio fixo estiver envolvido (impossível pela guarda acima), já bloqueou.
  }
  if (!confirm(`Excluir o usuário ${u.email}?\n\nEsta ação remove o acesso dele ao sistema. O histórico de consultas é preservado.`)) return;
  setLocalUsers(list.filter(x => x.id !== id));
  toast('Usuário excluído.', 'success');
  renderUsersList();
}

// Reset de senha via Firebase Auth (envia email com link de redefinição)
$('#btnUserResetSenha').addEventListener('click', async () => {
  if (!isAdmin()) return;
  const email = $('#userEditEmailOriginal').value;
  if (!email) return;
  if (APP_MODE !== 'firebase' || !firebaseAuth) {
    toast('Reset de senha só funciona no modo Firebase.', 'error');
    return;
  }
  if (!confirm(`Enviar email de redefinição de senha para ${email}?`)) return;
  try {
    await firebaseAuth.sendPasswordResetEmail(email);
    toast(`Email de redefinição enviado para ${email}.`, 'success', 5000);
  } catch (e) {
    console.warn('sendPasswordResetEmail:', e);
    let msg = 'Erro ao enviar email: ' + (e.message || e);
    if (e.code === 'auth/user-not-found') msg = 'Não existe conta Auth para este email (cadastro órfão).';
    if (e.code === 'auth/invalid-email') msg = 'Email inválido.';
    toast(msg, 'error');
  }
});

// Fechar modal
$('#btnFecharUserEdit').addEventListener('click', fecharModalEdicaoUser);
$('#btnCancelarUserEdit').addEventListener('click', fecharModalEdicaoUser);

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

  // Garante que a config do Firebase existe como objeto (proteção contra
  // estado corrompido no localStorage de versões antigas do app).
  if (!STATE.config.firebase || typeof STATE.config.firebase !== 'object') {
    STATE.config.firebase = {
      apiKey: "", authDomain: "", projectId: "",
      storageBucket: "", messagingSenderId: "", appId: ""
    };
  }

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
          if (role === 'pendente' || role === 'recusado') {
            // Sessão de uma conta ainda não aprovada (ou recusada): não deixa entrar.
            await firebaseAuth.signOut();
            mostrarLogin();
            $('#loginStatus').textContent = role === 'pendente'
              ? 'Sua conta ainda está aguardando aprovação do administrador.'
              : 'Seu acesso foi recusado pelo administrador.';
            return;
          }
          STATE.user = { email: user.email, uid: user.uid, role };
          // Carrega dados do Firestore (se conseguir)
          await carregarDoFirestore();
          mostrarApp();
        } else {
          // Sem usuário no Firebase → mostra splash (primeiro acesso / deslogado)
          mostrarSplash();
        }
      });
      return;
    }
  }
  // Sem Firebase válido: entra em modo local (login funciona 100%)
  APP_MODE = 'local';
  // Tenta restaurar a sessão persistida (admin fixo ou consultor local).
  // Se válida, entra direto no app — sem precisar logar de novo.
  const sess = carregarSessaoLocal();
  if (sess) {
    STATE.user = sess;
    mostrarApp();
    toast(`Sessão restaurada: ${sess.role === 'admin' ? 'Administrador' : 'Consultor'}`, 'info', 2500);
  } else {
    // Sem sessão salva → mostra splash (não pula direto pro login)
    mostrarSplash();
  }
})();

// Listener do botão "Entrar" da splash (transição splash → login).
// Usa uma flag pra não disparar duas vezes em cliques seguidos.
let _splashEntrando = false;
$('#btnSplashEntrar').addEventListener('click', () => {
  if (_splashEntrando) return;
  _splashEntrando = true;
  irParaLogin();
  // Libera o flag após a animação terminar (CSS .splash-leaving = 550ms)
  setTimeout(() => { _splashEntrando = false; }, 600);
});

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

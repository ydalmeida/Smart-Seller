# Smart Seller — Recomendador de produtos por CNPJ

> Inspirado no design do CDA (ARCOM), com estrutura nova, enxuta e focada no que importa:
> **coloca o CNPJ, mostra o Top 5 produtos mais vendidos para aquele ramo + região.**

## 🚀 Como rodar (30 segundos)

1. Abra o arquivo `index.html` no navegador (Chrome, Edge, Firefox).
2. Login:
   - **Admin (acesso total)**: `diogokarita547@gmail.com` / `Arcom2026`
   - **Consultor**: precisa ser criado pelo Admin (aba Configurações)
3. Pronto. O sistema já vem com **30 produtos-exemplo** cadastrados.

> ✅ O sistema **funciona 100% sem Firebase** (modo local). O login, permissões admin/consultor e o CRUD de produtos já estão operacionais. Quando você configurar seu próprio projeto Firebase, o login passa a ser em nuvem e os dados sincronizam entre dispositivos.

## 🔐 Sistema de permissões (Admin × Consultor)

| Função | Admin | Consultor |
|---|:---:|:---:|
| Consultar CNPJ e ver Top 5 | ✅ | ✅ |
| Ver histórico de consultas | ✅ | ✅ |
| Exportar PDF do Top 5 | ✅ | ✅ |
| Ver lista de produtos | ✅ | ✅ |
| **Cadastrar/editar/excluir produtos** | ✅ | ❌ |
| **Criar novos usuários consultores** | ✅ | ❌ |
| Configurar IA Groq, pesos do algoritmo, etc. | ✅ | ❌ |

Quando um **Consultor** entra:
- As abas **Produtos** e **Configurações** somem da sidebar
- Aparece um aviso amarelo na tela de produtos
- Os botões de **editar** e **excluir** somem da tabela
- Mesmo se ele tentar abrir a URL da aba Config, o sistema redireciona pra Consulta

## 👑 Primeiro acesso do Admin

Na primeira vez que abrir o sistema, a conta `diogokarita547@gmail.com` será **criada automaticamente** no Firebase. Basta:

1. Abrir `index.html`
2. Digitar email: `diogokarita547@gmail.com`  | senha: `Arcom2026`
3. Clicar **Entrar**
4. Pronto — você está logado como Admin

> ⚠️ **Importante**: Você precisa substituir as credenciais Firebase de exemplo (no `app.js`, constante `STATE.config.firebase`) pelas **credenciais reais do SEU projeto Firebase**. Do contrário, todos os usuários compartilharão o mesmo banco. Veja a seção "Firebase" abaixo.

## 👥 Criar consultores

Apenas o Admin pode criar consultores:

1. Faça login como Admin
2. Vá em **Configurações** (engrenagem no canto ou na sidebar)
3. Role até **"Gerenciar usuários"**
4. Preencha o email e a senha inicial (mínimo 6 caracteres)
5. Clique **Criar consultor**
6. Envie o email e a senha para o consultor por canal seguro

⚠️ Ao criar um novo usuário, o Firebase desloga o Admin automaticamente (limitação do Firebase Auth).
Faça login novamente com sua conta de Admin.

## 🤖 IA Groq (gratuita)

A IA é **opcional**. O Top 5 funciona perfeitamente sem ela — só mostra o motivo do algoritmo.

Para ativar as explicações personalizadas:

1. Vá em [console.groq.com](https://console.groq.com) → crie conta grátis
2. **API Keys** → **Create API Key** → copie
3. No sistema (como Admin), clique no ícone de robô 🤖 na barra superior
4. Cole a chave e clique **Testar conexão**
5. Pronto — as próximas consultas vêm com explicações geradas por IA

**Por que Groq?** Tier gratuito generoso, sem cartão, modelos Llama 3.1 70B rápidos.

## 🔥 Firebase (configurar seu próprio projeto)

**⚠️ Antes de usar em produção, configure seu projeto Firebase:**

1. Crie projeto em [console.firebase.google.com](https://console.firebase.google.com)
2. Ative **Authentication → Email/Senha**
3. Crie o app Web e copie as credenciais
4. No Firestore, crie o banco em modo de produção (ou teste)
5. Abra o arquivo `app.js` e substitua o bloco `STATE.config.firebase` (linha ~20) pelas suas credenciais:

```js
firebase: {
  apiKey: "AIzaSy...",
  authDomain: "seu-projeto.firebaseapp.com",
  projectId: "seu-projeto",
  storageBucket: "seu-projeto.appspot.com",
  messagingSenderId: "123...",
  appId: "1:123:web:abc"
}
```

Estrutura no Firestore (criada automaticamente):

```
usuarios/{uid}     → { email, role, criadoEm, criadoPor }
dados/produtos     → { lista: [...], atualizadoPor, atualizadoEm }
dados/historico    → { lista: [...], atualizadoEm }
```

**Regras de segurança recomendadas (Firestore Rules):**

```
rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {
    match /usuarios/{uid} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && (
        request.auth.uid == uid ||
        get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data.role == 'admin'
      );
    }
    match /dados/{doc} {
      allow read: if request.auth != null;
      allow write: if request.auth != null && 
        get(/databases/$(database)/documents/usuarios/$(request.auth.uid)).data.role == 'admin';
    }
  }
}
```

## ⚙️ Pesos do algoritmo (ajustáveis, só Admin)

| Peso | Padrão | Quando ajustar |
|---|---|---|
| **CNAE compatível** | 40 | Se você atende nichos muito específicos |
| **Região (UF)** | 25 | Se atende só algumas regiões |
| **Prioridade comercial** | 15 | Se tem produtos estratégicos que quer empurrar |
| **Margem de lucro** | 10 | Se quer priorizar rentabilidade |
| **Palavras-chave** | 10 | Se o CNAE sozinho não é suficiente |

## 📦 Cadastrar produtos (só Admin)

Aba **Produtos** → **Novo produto**:

| Campo | Para que serve |
|---|---|
| **Código** | SKU interno |
| **Nome, Marca, Categoria** | Identificação |
| **Preço, Margem** | Comerciais (margem entra no score) |
| **CNAEs compatíveis** | Lista separada por vírgula. Match exato, de classe (5 dígitos) ou subclasse (4 dígitos) |
| **UFs compatíveis** | Vazio = atende todas |
| **Palavras-chave** | Match contra a descrição CNAE do cliente |
| **Descrição** | Usada pela IA Groq para gerar a frase de venda |

## 📁 Estrutura dos arquivos

```
C:\Users\diogo\Documents\CLOUD\
├── index.html         # Tela + estrutura
├── style.css          # Visual (cores ARCOM, dark mode, partículas)
├── app.js             # Lógica: Firebase Auth, roles, scoring, IA, CRUD
├── produtos-seed.js   # 30 produtos de exemplo
└── README.md          # Este arquivo
```

## 🔮 Próximos passos (módulos futuros)

A estrutura foi pensada para crescer. Quando quiser, é só me chamar:

- [ ] Importação em massa via XLSX/CSV
- [ ] Módulo de Pedidos (gerar pedido e enviar por WhatsApp)
- [ ] Dashboard executivo com gráficos
- [ ] Logs de auditoria (já contemplado no EXEC.txt)
- [ ] Integração com Bling, Tiny, Omie, SAP
- [ ] 100k+ produtos com paginação server-side
- [ ] Cadastro de produtos via IA (colar descrição, IA sugere CNAE, UF, keywords)

## 🆘 Problemas comuns

**"Não consegue logar"**
- Verifique email e senha. Apenas o Admin pré-definido pode fazer login automático.
- Se for consultor, confirme que o Admin criou sua conta.

**"Firebase: project not found"**
- Você precisa substituir as credenciais de exemplo pelas suas. Veja seção "Firebase" acima.

**"IA não responde nada"**
- Vá em Configurações → Groq → cole a chave → **Testar conexão** (deve aparecer ✓)

**"Tela branca / erro JS"**
- Abra o DevTools (F12) → aba **Console** → me mande o erro

---

Feito com base no design system do CDA. ARCOM Design System © — estrutura e código novos.

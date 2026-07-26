# Smart Seller — Recomendador de produtos por CNPJ

> Sistema de recomendação que recebe um CNPJ, identifica o ramo e a região
> da empresa e devolve os **5 produtos mais compatíveis** do catálogo,
> com explicações geradas por IA.

## 🚀 Como rodar (30 segundos)

1. Abra o arquivo `index.html` no navegador (Chrome, Edge, Firefox).
2. Faça login como administrador (credenciais configuradas no app) ou
   clique em **"Solicitar acesso"** para que um consultor crie a conta.
3. O sistema já vem com produtos-exemplo cadastrados — é só consultar
   um CNPJ na aba **Consulta**.

> ✅ O sistema **funciona 100% sem Firebase** (modo local). O login,
> permissões admin/consultor e o CRUD de produtos já estão operacionais.
> Quando você configurar seu próprio projeto Firebase, o login passa a
> ser em nuvem e os dados sincronizam entre dispositivos.

## 🔐 Sistema de permissões (Admin × Consultor)

| Função | Admin | Consultor |
|---|:---:|:---:|
| Consultar CNPJ e ver Top 5 | ✅ | ✅ |
| Ver histórico de consultas | ✅ | ✅ |
| Exportar PDF do Top 5 | ✅ | ✅ |
| Ver lista de produtos | ✅ | ✅ |
| **Cadastrar/editar/excluir produtos** | ✅ | ❌ |
| **Aprovar/recusar solicitações de acesso** | ✅ | ❌ |
| Configurar IA, pesos do algoritmo, etc. | ✅ | ❌ |

Quando um **Consultor** entra:
- As abas **Produtos** e **Configurações** somem da sidebar
- Aparece um aviso amarelo na tela de produtos
- Os botões de **editar** e **excluir** somem da tabela
- Mesmo se ele tentar abrir a URL da aba Config, o sistema redireciona pra Consulta

## 👑 Primeiro acesso do Admin

> As credenciais do administrador são definidas na configuração interna
> do app. Por segurança, elas **não estão expostas** neste README nem em
> texto puro no código-fonte — somente o responsável pela implantação
> tem acesso.

Na primeira vez que abrir o sistema, a conta administradora é **criada
automaticamente** ao usar as credenciais configuradas.

## 👥 Consultores: autocadastro + aprovação do Admin

O próprio consultor cria a conta — o Admin só aprova ou recusa:

1. O consultor abre `index.html`, clica em **"Solicitar acesso"**
2. Preenche nome, email, setor/cargo e cria uma senha (mín. 6 caracteres)
3. Clica **Enviar solicitação** — a conta nasce com status **pendente**
   e não consegue logar ainda
4. O Admin faz login → **Configurações** → **"Solicitações de acesso
   pendentes"** (um badge vermelho avisa quando há pedidos)
5. O Admin clica **Aprovar** (vira consultor, já pode logar) ou no **X**
   para **Recusar** (acesso bloqueado)

> O Admin ainda pode criar um consultor diretamente (já aprovado), na
> mesma aba, em **"Consultores"**, se preferir pular a etapa de aprovação.

⚠️ Ao criar um novo usuário (seja pelo autocadastro ou pelo Admin), o
Firebase desloga a sessão atual automaticamente (limitação do Firebase
Auth). Se isso acontecer com o Admin, é só logar de novo.

## 🤖 IA (opcional)

A IA é **opcional**. O Top 5 funciona perfeitamente sem ela — só mostra
o motivo do algoritmo.

Para ativar as explicações personalizadas:

1. Crie conta grátis em um provedor de IA compatível com a API OpenAI
   (Groq, OpenRouter, etc.)
2. Gere uma API Key
3. No sistema (como Admin), clique no ícone de robô 🤖 na barra superior
4. Cole a chave e clique **Testar conexão**
5. Pronto — as próximas consultas vêm com explicações geradas por IA

## 🔥 Firebase (configurar seu próprio projeto)

**⚠️ Antes de usar em produção, configure seu projeto Firebase:**

1. Crie projeto em [console.firebase.google.com](https://console.firebase.google.com)
2. Ative **Authentication → Email/Senha**
3. Crie o app Web e copie as credenciais
4. No Firestore, crie o banco em modo de produção (ou teste)
5. Abra o arquivo `app.js` e substitua o bloco `STATE.config.firebase`
   pelas suas credenciais.

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
| **Descrição** | Usada pela IA para gerar a frase de venda |

## 📁 Estrutura dos arquivos

```
C:\Users\diogo\Documents\CLOUD\
├── index.html         # Tela + estrutura
├── style.css          # Visual (cores, dark mode, partículas, animações)
├── app.js             # Lógica: Auth, roles, scoring, IA, CRUD
├── produtos-seed.js   # Produtos de exemplo
└── README.md          # Este arquivo
```

## 🔮 Próximos passos (módulos futuros)

A estrutura foi pensada para crescer. Quando quiser, é só chamar:

- [ ] Importação em massa via XLSX/CSV
- [ ] Módulo de Pedidos (gerar pedido e enviar por WhatsApp)
- [ ] Dashboard executivo com gráficos
- [ ] Logs de auditoria
- [ ] Integração com Bling, Tiny, Omie, SAP
- [ ] 100k+ produtos com paginação server-side
- [ ] Cadastro de produtos via IA

## 🆘 Problemas comuns

**"Não consegue logar"**
- Confirme que as credenciais de administrador estão configuradas no app.
- Se for consultor, confirme que o Admin criou sua conta.

**"Firebase: project not found"**
- Você precisa substituir as credenciais de exemplo pelas suas. Veja a
  seção "Firebase" acima.

**"IA não responde nada"**
- Vá em Configurações → IA → cole a chave → **Testar conexão** (deve
  aparecer ✓)

**"Tela branca / erro JS"**
- Abra o DevTools (F12) → aba **Console** → confira a mensagem de erro

---

Sistema de recomendação por CNPJ. Interface e regras próprias.
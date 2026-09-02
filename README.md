# Notas Fiscais — PWA

> ## ⚙️ Estado da configuração (preenchido pelo assistente em 31/08/2026)
>
> **Já feito:**
> - Revisão do código + pequenos ajustes (ver "Ajustes aplicados" no fim deste arquivo).
> - OneDrive: pasta e planilha criadas na sua conta `thais@senigalia.com.br`:
>   - Planilha: **`/Notas Fiscais App/Notas Fiscais.xlsx`** — tabela **`TabelaNotas`**
>     com as 7 colunas na ordem pedida.
>   - Pasta das fotos: **`/Notas Fiscais App/Fotos`**
>
> **Falta você fazer (precisa da sua conta / login):**
> 1. Registrar o app no Entra ID e pegar o **Client ID** (seção 2 abaixo).
> 2. Colar o Client ID em `js/config.js` (linha `clientId`).
> 3. Publicar a pasta num host HTTPS (seção 1) e anotar a URL.
> 4. Cadastrar essa URL (com barra no final) como Redirect URI **SPA** no Entra ID.
> 5. Abrir o app → Configurações → Entrar → preencher os caminhos acima → testar.


App instalável no iPhone que fotografa uma nota fiscal, lê os dados por OCR
direto no navegador (Tesseract.js), deixa você revisar e corrigir, e ao
confirmar:

1. adiciona uma linha numa tabela do Excel (OneDrive / Microsoft 365);
2. salva a foto original numa pasta do OneDrive.

Sem servidor próprio: é um site estático (HTML/CSS/JS puro, sem build) que
fala diretamente com o Microsoft Graph a partir do seu iPhone.

---

## 1. Hospedar o site

Qualquer host de arquivo estático serve. Três exemplos:

### Vercel
```
npm i -g vercel
cd notafiscal-pwa
vercel --prod
```

### Netlify
```
npm i -g netlify-cli
cd notafiscal-pwa
netlify deploy --prod
```

### GitHub Pages
1. Crie um repositório e suba o conteúdo desta pasta.
2. Em *Settings → Pages*, escolha a branch e a pasta raiz.
3. O site fica em `https://SEU-USUARIO.github.io/SEU-REPOSITORIO/`.

Guarde a URL final — você vai precisar dela no passo 2.

> O app **precisa de HTTPS** para funcionar (câmera, instalação como PWA e
> login Microsoft exigem isso). Os três hosts acima já servem em HTTPS por
> padrão.

---

## 2. Registrar o app no Microsoft Entra ID (Azure AD)

Isso permite que o app peça permissão para ler/gravar no seu Excel e
OneDrive, sem nunca lidar com sua senha diretamente.

1. Acesse **https://entra.microsoft.com** (ou portal.azure.com → Microsoft
   Entra ID) e faça login com a mesma conta Microsoft 365 que você vai usar
   no app.
2. Vá em **Aplicativos → Registros de aplicativo → Novo registro**.
3. Preencha:
   - **Nome**: `Notas Fiscais` (ou o nome que preferir).
   - **Tipos de conta com suporte**: se for usar só a sua própria conta,
     "Somente contas neste diretório organizacional" ou "Contas em
     qualquer diretório organizacional e contas pessoais Microsoft" — esta
     última é a opção mais simples se você não tiver certeza.
   - **URI de Redirecionamento**: escolha a plataforma **"Aplicativo de
     página única (SPA)"** e cole a URL do site publicado no passo 1 (ex.:
     `https://seu-app.vercel.app/`).
4. Clique em **Registrar**.
5. Na página do app, copie o **"ID do aplicativo (cliente)"** — é o
   `clientId` que vai no arquivo `js/config.js`.
6. Vá em **Permissões de API → Adicionar uma permissão → Microsoft Graph →
   Permissões delegadas** e adicione:
   - `User.Read`
   - `Files.ReadWrite`
7. Se aparecer o botão **"Conceder consentimento do administrador"** e você
   for admin do tenant, clique nele (opcional para conta pessoal/própria —
   nesse caso o próprio app pede o consentimento no primeiro login).
8. Em **Autenticação**, confirme que a URI de redirecionamento cadastrada é
   **exatamente igual** à URL do site (com ou sem barra final, do jeito que
   o navegador realmente carrega). Marque também os tokens de acesso/ID se
   o assistente pedir (não é obrigatório para este fluxo, mas não atrapalha).

Edite `js/config.js` e preencha:

```js
const APP_CONFIG = {
  clientId: "cole-aqui-o-id-do-aplicativo",
  authority: "https://login.microsoftonline.com/common",
  redirectUri: window.location.origin + window.location.pathname,
  scopes: ["User.Read", "Files.ReadWrite"],
};
```

Suba o arquivo alterado para o mesmo host do passo 1.

---

## 3. Preparar a planilha no Excel

1. No OneDrive, crie (ou use) um arquivo `.xlsx`.
2. Nele, crie uma **tabela do Excel** (selecione a linha de cabeçalho →
   guia *Inserir* → *Tabela*) com as colunas **nesta ordem**:

   | Data de emissão | Número | CNPJ | Razão social | Valor total | Forma de pagamento | Categoria |
   |---|---|---|---|---|---|---|

3. Dê um nome à tabela (guia *Design da Tabela* → *Nome da Tabela*, ex.
   `TabelaNotas`) — é esse nome que vai nas Configurações do app.
4. Anote o caminho do arquivo dentro do OneDrive, por exemplo
   `/Financeiro/Notas Fiscais.xlsx` (a partir da raiz do seu OneDrive).
5. Crie também a pasta onde as fotos vão ser salvas, ex.
   `/Financeiro/Notas Fiscais/Fotos`.

---

## 4. Instalar no iPhone

1. Abra a URL do app no **Safari** do iPhone (precisa ser o Safari, não
   Chrome/outro navegador).
2. Toque no ícone de **Compartilhar** (o quadrado com a seta para cima).
3. Toque em **"Adicionar à Tela de Início"**.
4. Confirme o nome e toque em **Adicionar**.
5. O ícone aparece na tela de início e abre em tela cheia, como um app.

---

## 5. Primeiro uso dentro do app

1. Abra o app pela tela de início.
2. Vá em **Configurações**:
   - Toque em **Entrar** e faça login com sua conta Microsoft.
   - Preencha o **caminho do arquivo Excel** e o **nome da tabela**
     (passo 3).
   - Preencha a **pasta do OneDrive** para as fotos (passo 3).
   - Opcionalmente, liste algumas **categorias** sugeridas separadas por
     vírgula (ex. `reforma, mercado, casa, viagem`).
   - Toque em **Salvar configurações**.
3. Volte para o **Início** e toque em **Nova nota fiscal** para testar.

Essas configurações ficam salvas no navegador do seu iPhone (não precisa
preencher de novo toda vez que abrir o app).

---

## Como funciona por baixo dos panos

- **OCR**: roda inteiramente no navegador com [Tesseract.js](https://tesseract.projectnaptha.com/),
  usando o idioma português. Não exige nenhuma chave ou conta adicional —
  foi essa a opção mais simples de configurar, já que a autenticação do app
  inteiro já passa pela sua conta Microsoft. Na primeira leitura, o
  navegador baixa o "dicionário" de português (alguns MB); depois disso,
  fica em cache. A extração de campos é heurística (procura por palavras
  como "TOTAL", "CNPJ", datas, etc.) — por isso a tela de revisão sempre
  aparece antes de salvar, para você corrigir o que o OCR errar.
- **Envio ao Excel/OneDrive**: usa a Microsoft Graph API diretamente do
  navegador, com o token obtido via MSAL.js (biblioteca oficial da
  Microsoft). Nenhuma senha ou token fica em texto puro no código — tudo é
  gerenciado pela biblioteca e guardado pelo próprio navegador.
- **Nunca perder uma nota**: assim que você toca em "Confirmar e salvar", a
  nota (foto + dados) é gravada localmente (IndexedDB) *antes* de tentar
  enviar. Se o envio falhar (sem internet, token expirado, etc.), a nota
  fica marcada como "Pendente"/"Falhou" na tela inicial, com um botão para
  tentar de novo — e o app tenta reenviar automaticamente quando a conexão
  volta.

## Limitações conhecidas

- O app não é 100% offline: capturar a foto funciona sem internet, mas o
  OCR e o envio precisam de conexão (por isso o cache local, para não
  perder nada nesse meio-tempo).
- Se o upload da foto for bem-sucedido mas a gravação na planilha falhar
  logo em seguida, um novo "tentar novamente" reenvia a foto de novo (fica
  duplicada no OneDrive). É um efeito colateral raro; se acontecer, é só
  apagar a foto duplicada.
- Limpar os dados do site no Safari (Ajustes → Safari → Avançado → Dados de
  Site) apaga as configurações salvas e desconecta sua conta Microsoft.
- Não foi publicado na App Store — é um PWA instalado direto pelo Safari.

## Ajustes aplicados na revisão (31/08/2026)

- `js/config.js`: `authority` mudou de `common` para `organizations` (a conta é
  corporativa Microsoft 365). O `redirectUri` agora remove `index.html` do final,
  então basta cadastrar **uma** Redirect URI no Entra ID: a raiz do site com
  barra no final (ex.: `https://seu-app.vercel.app/`). Isso evita o erro mais
  comum (`redirect_uri mismatch`) quando o app é aberto pela tela de início.
- `manifest.json`: `start_url` mudou de `./index.html` para `./` (mesma URL
  em todo lugar).
- `js/graph.js`: `parseValorNumero` ficou mais tolerante — aceita `1.234,56`,
  `1234,56`, `1234.56` e valores com `R$`/espaços sem quebrar.
- `service-worker.js`: `CACHE_NAME` v1 → v2 para forçar atualização do cache
  na primeira abertura depois de republicar.

### Observações do review (não bloqueiam o uso)

- A data vai para o Excel como texto ISO `AAAA-MM-DD`. Se quiser data "de
  verdade" na planilha, formate a coluna A como Data no Excel.
- Duplicação de foto em falha parcial (upload OK + planilha falha) já está
  documentada em "Limitações conhecidas".
- iOS: o login Microsoft usa fluxo de redirecionamento (correto para PWA na
  tela de início). Precisa de iOS relativamente recente; o cache do MSAL está
  em `localStorage`, então sobrevive ao fechar o app.
- O service worker faz cache-first do `js/config.js`. Se editar o Client ID
  depois de já ter aberto o app, suba junto uma mudança no `CACHE_NAME`.

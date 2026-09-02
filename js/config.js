// ============================================================
// Preencha o clientId depois de registrar o app no Microsoft
// Entra ID (Azure AD). Veja o passo a passo no README.
// ============================================================
const APP_CONFIG = {
  // "ID do aplicativo (cliente)" do app registrado no Entra ID.
  clientId: "ce148503-f90b-4ff7-b597-f2f655126a77",

  // "common"  = aceita conta pessoal OU corporativa
  // "organizations" = só contas corporativas/escolares (qualquer tenant)
  // "<TENANT_ID>"   = trava numa organização específica
  // A conta thais@senigalia.com.br é corporativa (Microsoft 365), então
  // "organizations" ou o Tenant ID funcionam. "common" também serve.
  authority: "https://login.microsoftonline.com/organizations",

  // Redirect URI: precisa bater EXATAMENTE com o que estiver cadastrado
  // no Entra ID (aba Autenticação). Normalizamos removendo "index.html"
  // do final para que abrir ".../app/" e ".../app/index.html" (a versão
  // instalada na tela de início) usem a MESMA URI — assim basta cadastrar
  // uma única: a raiz do site com barra no final.
  redirectUri: (window.location.origin + window.location.pathname).replace(/index\.html?$/i, ""),

  // Permissões (scopes) do Microsoft Graph.
  scopes: ["User.Read", "Files.ReadWrite"],
};

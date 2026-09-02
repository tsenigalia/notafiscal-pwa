// ============================================================
// auth.js
// Login com a conta Microsoft (MSAL.js, fluxo de redirecionamento)
// e obtenção de tokens para chamar o Microsoft Graph.
// Nenhuma senha ou token fica em texto puro em lugar nenhum do
// código — tudo é gerenciado pela biblioteca MSAL.
// ============================================================

const Auth = (() => {
  let msalInstance = null;
  let account = null;

  async function init() {
    msalInstance = new msal.PublicClientApplication({
      auth: {
        clientId: APP_CONFIG.clientId,
        authority: APP_CONFIG.authority,
        redirectUri: APP_CONFIG.redirectUri,
      },
      cache: {
        cacheLocation: "localStorage", // sobrevive ao fechar o app na tela de início
        storeAuthStateInCookie: false,
      },
    });

    await msalInstance.initialize();

    // Se estamos voltando de um login por redirecionamento, processa o resultado.
    const result = await msalInstance.handleRedirectPromise();
    if (result && result.account) {
      account = result.account;
    } else {
      const accounts = msalInstance.getAllAccounts();
      if (accounts.length > 0) account = accounts[0];
    }
    return account;
  }

  function isLoggedIn() {
    return Boolean(account);
  }

  function getAccount() {
    return account;
  }

  function login() {
    return msalInstance.loginRedirect({ scopes: APP_CONFIG.scopes });
  }

  function logout() {
    return msalInstance.logoutRedirect();
  }

  async function getToken() {
    if (!account) throw new Error("Usuário não conectado.");
    const request = { scopes: APP_CONFIG.scopes, account };
    try {
      const result = await msalInstance.acquireTokenSilent(request);
      return result.accessToken;
    } catch (err) {
      // Token expirado ou consentimento pendente: pede login interativo.
      await msalInstance.acquireTokenRedirect(request);
      // acquireTokenRedirect navega para fora do app; nada mais executa aqui.
      return null;
    }
  }

  return { init, isLoggedIn, getAccount, login, logout, getToken };
})();

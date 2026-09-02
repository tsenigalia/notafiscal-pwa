// ============================================================
// app.js
// Orquestra as telas (início, captura, revisão, salvando,
// configurações), o fluxo de OCR e o envio para o Graph,
// sempre gravando localmente antes de tentar enviar — assim
// nenhuma nota fotografada se perde por causa de uma falha de
// conexão momentânea.
// ============================================================

const $ = (sel) => document.querySelector(sel);

let capturedBlob = null;
let capturedObjectUrl = null;

document.addEventListener("DOMContentLoaded", async () => {
  wireNav();
  wireCapture();
  wireReview();
  wireSettings();

  registerServiceWorker();

  try {
    await Auth.init();
  } catch (e) {
    console.error("Falha ao inicializar autenticação:", e);
  }

  updateAuthUi();
  await renderHome();

  // Se voltamos de um login por redirecionamento (ex.: token expirado no
  // meio de um envio), tenta reenviar automaticamente qualquer nota que
  // ficou pendente, sem exigir que a pessoa toque em nada.
  if (Auth.isLoggedIn()) {
    retryPending(true);
  }

  window.addEventListener("online", () => retryPending(true));
});

// ---------------------------------------------------------------
// Navegação
// ---------------------------------------------------------------
function showView(id) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  $(id).classList.add("active");
  $("#nav-home").classList.toggle("active", id === "#view-home");
  $("#nav-settings").classList.toggle("active", id === "#view-settings");
}

function wireNav() {
  $("#nav-home").addEventListener("click", async () => {
    showView("#view-home");
    await renderHome();
  });
  $("#nav-settings").addEventListener("click", () => {
    showView("#view-settings");
    loadSettingsIntoForm();
  });
  $("#btn-open-settings").addEventListener("click", () => {
    showView("#view-settings");
    loadSettingsIntoForm();
  });
}

// ---------------------------------------------------------------
// Toast
// ---------------------------------------------------------------
function showToast(message, isError = false, duration = 3600) {
  const host = $("#toast-host");
  const el = document.createElement("div");
  el.className = "toast" + (isError ? " error" : "");
  el.textContent = message;
  host.appendChild(el);
  setTimeout(() => el.remove(), duration);
}

// ---------------------------------------------------------------
// Captura
// ---------------------------------------------------------------
function wireCapture() {
  $("#btn-nova-nota").addEventListener("click", () => {
    resetCaptureStage();
    showView("#view-capture");
  });

  $("#btn-cancel-capture").addEventListener("click", () => {
    resetCaptureStage();
    showView("#view-home");
  });

  $("#input-camera").addEventListener("change", (e) => handleFileChosen(e.target.files[0]));
  $("#input-gallery").addEventListener("change", (e) => handleFileChosen(e.target.files[0]));
}

function resetCaptureStage() {
  $("#capture-stage-pick").classList.remove("hidden");
  $("#capture-stage-processing").classList.add("hidden");
  $("#input-camera").value = "";
  $("#input-gallery").value = "";
  if (capturedObjectUrl) URL.revokeObjectURL(capturedObjectUrl);
  capturedObjectUrl = null;
  capturedBlob = null;
}

async function handleFileChosen(file) {
  if (!file) return;
  capturedBlob = file;
  capturedObjectUrl = URL.createObjectURL(file);

  $("#capture-stage-pick").classList.add("hidden");
  $("#capture-stage-processing").classList.remove("hidden");
  $("#processing-preview-img").src = capturedObjectUrl;
  setOcrProgress(0, "Lendo a nota fiscal…");

  let fields = { data: "", numero: "", cnpj: "", razao: "", valor: "", pagamento: "" };
  try {
    const text = await Ocr.recognize(file, (m) => {
      if (m.status === "recognizing text") {
        setOcrProgress(Math.round((m.progress || 0) * 100), "Lendo a nota fiscal…");
      } else if (m.status) {
        setOcrProgress(null, ocrStatusLabel(m.status));
      }
    });
    fields = Ocr.parseFields(text);
  } catch (err) {
    console.error("OCR falhou:", err);
    showToast("Não consegui ler a nota automaticamente — preencha os campos manualmente.", true);
  }

  openReview(fields);
}

function ocrStatusLabel(status) {
  const map = {
    "loading tesseract core": "Preparando leitor de texto…",
    "initializing tesseract": "Preparando leitor de texto…",
    "loading language traineddata": "Carregando idioma…",
    "initializing api": "Quase lá…",
    "recognizing text": "Lendo a nota fiscal…",
  };
  return map[status] || "Processando…";
}

function setOcrProgress(pct, label) {
  if (pct !== null) $("#ocr-progress-fill").style.width = pct + "%";
  if (label) $("#ocr-progress-label").textContent = label;
}

// ---------------------------------------------------------------
// Revisão
// ---------------------------------------------------------------
function wireReview() {
  $("#btn-confirmar-salvar").addEventListener("click", confirmAndSave);
  $("#btn-descartar").addEventListener("click", () => {
    resetCaptureStage();
    showView("#view-home");
  });
}

function openReview(fields) {
  $("#review-photo").src = capturedObjectUrl;
  $("#f-data").value = fields.data || "";
  $("#f-numero").value = fields.numero || "";
  $("#f-cnpj").value = fields.cnpj || "";
  $("#f-razao").value = fields.razao || "";
  $("#f-valor").value = fields.valor || "";
  $("#f-pagamento").value = fields.pagamento || "";
  $("#f-categoria").value = "";

  const settings = Storage.getSettings();
  const datalist = $("#categorias-sugeridas");
  datalist.innerHTML = "";
  settings.categorias.forEach((c) => {
    const opt = document.createElement("option");
    opt.value = c;
    datalist.appendChild(opt);
  });

  markUncertainFields(fields);
  showView("#view-review");
}

function markUncertainFields(fields) {
  const map = { data: "field-data", numero: "field-numero", cnpj: "field-cnpj", razao: "field-razao", valor: "field-valor" };
  Object.entries(map).forEach(([key, elId]) => {
    $("#" + elId).classList.toggle("warn", !fields[key]);
  });
}

function gatherFieldsFromForm() {
  return {
    data: $("#f-data").value,
    numero: $("#f-numero").value.trim(),
    cnpj: $("#f-cnpj").value.trim(),
    razao: $("#f-razao").value.trim(),
    valor: $("#f-valor").value.trim(),
    pagamento: $("#f-pagamento").value,
    categoria: $("#f-categoria").value.trim(),
  };
}

async function confirmAndSave() {
  const fields = gatherFieldsFromForm();
  const thumbnail = await makeThumbnail(capturedBlob).catch(() => null);

  const receipt = await Storage.addReceipt({
    fields,
    photoBlob: capturedBlob,
    thumbnail,
    status: "pending",
  });

  // Salva as categorias novas como sugestão futura.
  if (fields.categoria) {
    const settings = Storage.getSettings();
    if (!settings.categorias.includes(fields.categoria)) {
      settings.categorias.push(fields.categoria);
      Storage.saveSettings(settings);
    }
  }

  resetCaptureStage();
  showView("#view-saving");
  setSaveProgress(0, "Enviando a foto para o OneDrive…");

  const outcome = await trySyncOne(receipt.id, (pct, label) => setSaveProgress(pct, label));

  showView("#view-home");
  await renderHome();

  if (outcome.ok) {
    showToast("Nota fiscal salva com sucesso.");
  } else if (outcome.reason === "redirect") {
    // saiu para autenticação interativa; nada a fazer aqui
  } else {
    showToast(outcome.message || "Não consegui enviar agora. A nota ficou salva e vou tentar de novo.", true);
  }
}

function setSaveProgress(pct, label) {
  if (pct !== null) $("#save-progress-fill").style.width = pct + "%";
  if (label) $("#save-progress-label").textContent = label;
}

// ---------------------------------------------------------------
// Sincronização com o Microsoft Graph
// ---------------------------------------------------------------
async function trySyncOne(id, onProgress) {
  const settings = Storage.getSettings();

  if (!Storage.isConfigured()) {
    await Storage.updateReceipt(id, { status: "error", errorMessage: "Configure o Excel e o OneDrive em Configurações." });
    return { ok: false, message: "Configure o Excel e o OneDrive em Configurações antes de enviar." };
  }
  if (!Auth.isLoggedIn()) {
    await Storage.updateReceipt(id, { status: "error", errorMessage: "Conecte sua conta Microsoft em Configurações." });
    return { ok: false, message: "Conecte sua conta Microsoft em Configurações antes de enviar." };
  }

  const receipt = await Storage.getReceipt(id);
  if (!receipt || !receipt.photoBlob) {
    return { ok: false, message: "Não encontrei a foto desta nota para reenviar." };
  }

  try {
    const token = await Auth.getToken();
    if (!token) return { ok: false, reason: "redirect" }; // login interativo em andamento

    const filename = Graph.suggestFileName(receipt.fields);
    if (onProgress) onProgress(10, "Enviando a foto para o OneDrive…");
    await Graph.uploadPhoto(settings, receipt.photoBlob, filename, token, (pct) => {
      if (onProgress) onProgress(10 + Math.round(pct * 0.6), "Enviando a foto para o OneDrive…");
    });

    if (onProgress) onProgress(80, "Adicionando linha na planilha…");
    await Graph.addExcelRow(settings, receipt.fields, token);

    if (onProgress) onProgress(100, "Concluído.");
    await Storage.updateReceipt(id, { status: "synced", errorMessage: null, photoBlob: null });
    return { ok: true };
  } catch (err) {
    console.error("Falha ao sincronizar nota:", err);
    await Storage.updateReceipt(id, { status: "error", errorMessage: err.message || "Falha ao enviar." });
    return { ok: false, message: err.message || "Falha ao enviar." };
  }
}

async function retryPending(silent = false) {
  if (!Storage.isConfigured() || !Auth.isLoggedIn()) return;
  const pending = await Storage.getPendingReceipts();
  if (pending.length === 0) return;

  let successCount = 0;
  for (const r of pending) {
    const outcome = await trySyncOne(r.id, () => {});
    if (outcome.ok) successCount++;
    if (outcome.reason === "redirect") break;
  }
  await renderHome();
  if (!silent || successCount > 0) {
    if (successCount > 0) showToast(`${successCount} nota(s) pendente(s) enviada(s) com sucesso.`);
  }
}

// ---------------------------------------------------------------
// Lista da tela inicial
// ---------------------------------------------------------------
async function renderHome() {
  const all = await Storage.getAllReceipts();
  const list = $("#receipt-list");
  const empty = $("#empty-state");
  list.innerHTML = "";

  if (all.length === 0) {
    empty.classList.remove("hidden");
  } else {
    empty.classList.add("hidden");
    all.forEach((r) => list.appendChild(renderReceiptRow(r)));
  }

  const pending = all.filter((r) => r.status === "pending" || r.status === "error");
  const banner = $("#pending-banner");
  const btn = $("#btn-retry-pending");
  if (pending.length > 0) {
    banner.classList.remove("hidden");
    btn.textContent = `Tentar enviar ${pending.length} nota(s) pendente(s)`;
    btn.onclick = () => retryPending(false);
  } else {
    banner.classList.add("hidden");
  }

  $("#settings-pending-info").textContent =
    pending.length > 0 ? `${pending.length} nota(s) aguardando envio.` : "Nenhuma nota pendente de envio.";
}

function renderReceiptRow(r) {
  const row = document.createElement("div");
  row.className = "receipt-row";

  const img = document.createElement("img");
  img.className = "thumb";
  img.alt = "";
  if (r.thumbnail) img.src = r.thumbnail;

  const info = document.createElement("div");
  info.className = "info";
  const estab = document.createElement("div");
  estab.className = "estab";
  estab.textContent = r.fields.razao || "Estabelecimento não identificado";
  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = [formatDateBR(r.fields.data), r.fields.categoria].filter(Boolean).join(" · ");
  info.append(estab, meta);

  const valor = document.createElement("div");
  valor.className = "valor num";
  valor.textContent = r.fields.valor ? `R$ ${r.fields.valor}` : "";

  const chip = document.createElement("span");
  chip.className = "chip " + (r.status === "synced" ? "ok" : r.status === "pending" ? "pending" : "error");
  chip.textContent = r.status === "synced" ? "Enviada" : r.status === "pending" ? "Pendente" : "Falhou";

  row.append(img, info, valor, chip);

  if (r.status === "error" || r.status === "pending") {
    row.style.cursor = "pointer";
    row.addEventListener("click", async () => {
      showToast("Tentando enviar novamente…");
      const outcome = await trySyncOne(r.id, () => {});
      await renderHome();
      if (outcome.ok) showToast("Nota enviada com sucesso.");
      else if (outcome.reason !== "redirect") showToast(outcome.message || "Ainda não consegui enviar.", true);
    });
  }

  return row;
}

function formatDateBR(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  if (!y || !m || !d) return iso;
  return `${d}/${m}/${y}`;
}

async function makeThumbnail(blob) {
  const bitmap = await createImageBitmap(blob);
  const maxW = 160;
  const scale = Math.min(1, maxW / bitmap.width);
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const ctx = canvas.getContext("2d");
  ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/jpeg", 0.7);
}

// ---------------------------------------------------------------
// Configurações
// ---------------------------------------------------------------
function wireSettings() {
  $("#btn-salvar-config").addEventListener("click", () => {
    const settings = {
      excelPath: $("#s-excel-path").value.trim(),
      excelTable: $("#s-excel-table").value.trim(),
      oneDriveFolder: $("#s-onedrive-folder").value.trim(),
      categorias: $("#s-categorias").value.split(",").map((s) => s.trim()).filter(Boolean),
    };
    Storage.saveSettings(settings);
    const msg = $("#config-saved-msg");
    msg.textContent = "Configurações salvas.";
    setTimeout(() => (msg.textContent = ""), 2500);
  });

  $("#btn-auth-toggle").addEventListener("click", async () => {
    if (Auth.isLoggedIn()) {
      await Auth.logout();
    } else {
      if (APP_CONFIG.clientId === "COLE_AQUI_O_CLIENT_ID") {
        showToast("Configure o Client ID do Azure AD em js/config.js antes de entrar.", true);
        return;
      }
      await Auth.login();
    }
  });
}

function loadSettingsIntoForm() {
  const s = Storage.getSettings();
  $("#s-excel-path").value = s.excelPath;
  $("#s-excel-table").value = s.excelTable;
  $("#s-onedrive-folder").value = s.oneDriveFolder;
  $("#s-categorias").value = s.categorias.join(", ");
  updateAuthUi();
}

function updateAuthUi() {
  const btn = $("#btn-auth-toggle");
  if (Auth.isLoggedIn()) {
    const acc = Auth.getAccount();
    $("#auth-name").textContent = acc.name || "Conectado";
    $("#auth-email").textContent = acc.username || "";
    btn.textContent = "Sair";
  } else {
    $("#auth-name").textContent = "Não conectado";
    $("#auth-email").textContent = "";
    btn.textContent = "Entrar";
  }
}

// ---------------------------------------------------------------
// Service worker (app shell instalável, funciona mesmo com rede instável)
// ---------------------------------------------------------------
function registerServiceWorker() {
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.register("service-worker.js").catch((e) => console.warn("SW falhou:", e));
  }
}

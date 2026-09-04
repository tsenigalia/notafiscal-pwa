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
let capturedImageHash = null;
let currentDupInfo = null; // resultado da checagem de duplicata da nota em revisão

// Quão parecidas duas fotos precisam ser (em bits diferentes, de 64) para
// disparar o aviso de duplicata por imagem. Duas fotos tiradas à mão da
// MESMA nota (ângulo/enquadramento/luz levemente diferentes a cada vez)
// costumam variar bem mais do que se imagina — um limiar apertado deixa
// passar duplicatas reais. 18/64 (~28%) é mais tolerante a isso; ainda
// assim é heurístico, então pode precisar de ajuste com o uso real.
const DUP_HASH_THRESHOLD = 18;

document.addEventListener("DOMContentLoaded", async () => {
  wireNav();
  wireCapture();
  wireCategoria();
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
  capturedImageHash = null;
  currentDupInfo = null;
}

async function handleFileChosen(file) {
  if (!file) return;
  capturedBlob = file;
  capturedObjectUrl = URL.createObjectURL(file);

  $("#capture-stage-pick").classList.add("hidden");
  $("#capture-stage-processing").classList.remove("hidden");
  $("#processing-preview-img").src = capturedObjectUrl;
  setOcrProgress(0, "Lendo a nota fiscal…");

  // O OCR é só uma ajuda: se ele falhar por qualquer motivo (foto
  // ilegível, modelo não carregou, etc.), seguimos para a revisão com
  // os campos em branco — a pessoa sempre pode preencher/corrigir na
  // tela seguinte, e a nota nunca fica bloqueada por causa disso.
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

  // Hash da foto para a checagem de duplicata abaixo — nunca bloqueia o
  // fluxo se falhar (ex.: navegador sem suporte a createImageBitmap).
  try {
    capturedImageHash = await Ocr.computeImageHash(file);
  } catch (err) {
    console.warn("Não foi possível calcular o hash da imagem:", err);
    capturedImageHash = null;
  }

  const dupInfo = await findPossibleDuplicate(fields, capturedImageHash).catch((err) => {
    console.warn("Checagem de nota duplicada falhou:", err);
    return null;
  });

  openReview(fields, dupInfo);
}

// Compara com as notas já registradas neste aparelho (enviadas ou ainda
// pendentes) para avisar sobre uma possível duplicata — mesma nota
// fotografada duas vezes por engano. Não bloqueia nada: é só um aviso na
// tela de revisão, e a pessoa decide se confirma mesmo assim.
async function findPossibleDuplicate(fields, imageHash) {
  const all = await Storage.getAllReceipts();

  // Sinal mais forte: mesmo CNPJ + mesmo número da nota já registrados.
  if (fields.cnpj && fields.numero) {
    const sameDoc = all.find(
      (r) => r.fields && r.fields.cnpj === fields.cnpj && r.fields.numero === fields.numero
    );
    if (sameDoc) return { receipt: sameDoc, reason: "campos" };
  }

  // Sinal por imagem: pega o caso de fotografar a mesma nota de novo
  // mesmo quando o OCR não leu CNPJ/número (ou leu diferente por engano).
  if (imageHash) {
    let best = null,
      bestDist = Infinity;
    for (const r of all) {
      if (!r.imageHash) continue;
      const dist = Ocr.hammingDistanceHex(imageHash, r.imageHash);
      if (dist < bestDist) {
        bestDist = dist;
        best = r;
      }
    }
    if (best && bestDist <= DUP_HASH_THRESHOLD) return { receipt: best, reason: "foto" };
  }

  return null;
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
  $("#btn-confirmar-salvar").addEventListener("click", async () => {
    // Se a checagem encontrou uma provável duplicata, pede confirmação
    // explícita antes de seguir — a pessoa decide, o app não bloqueia nem
    // deixa passar batido.
    if (currentDupInfo) {
      const quiseguir = await askDuplicateConfirmation(currentDupInfo);
      if (!quiseguir) return; // fica na tela de revisão para conferir/corrigir
    }
    confirmAndSave();
  });
  $("#btn-descartar").addEventListener("click", () => {
    resetCaptureStage();
    showView("#view-home");
  });
  $("#dup-modal-nao").addEventListener("click", () => resolveDuplicateModal(false));
  $("#dup-modal-sim").addEventListener("click", () => resolveDuplicateModal(true));
}

// Resolvida pelo botão Sim/Não do modal — ver askDuplicateConfirmation.
let resolveDuplicateModal = () => {};

function askDuplicateConfirmation(dupInfo) {
  $("#dup-modal-text").textContent = describeDupInfo(dupInfo);
  $("#dup-modal").classList.remove("hidden");
  return new Promise((resolve) => {
    resolveDuplicateModal = (proceed) => {
      $("#dup-modal").classList.add("hidden");
      resolve(proceed);
    };
  });
}

function openReview(fields, dupInfo) {
  currentDupInfo = dupInfo || null;
  $("#review-photo").src = capturedObjectUrl;
  $("#f-data").value = fields.data || "";
  $("#f-numero").value = fields.numero || "";
  $("#f-cnpj").value = fields.cnpj || "";
  $("#f-razao").value = fields.razao || "";
  $("#f-valor").value = fields.valor || "";
  $("#f-pagamento").value = fields.pagamento || "";
  resetCategoriaField();

  markUncertainFields(fields);
  renderDupBanner(dupInfo);
  showView("#view-review");
}

// ---------------------------------------------------------------
// Categoria (lista fixa vinda de js/categorias.js, com opção "Outra")
// ---------------------------------------------------------------
const CATEGORIA_OUTRA_VALUE = "__outra__";

function wireCategoria() {
  const select = $("#f-categoria");
  select.innerHTML = "";
  select.appendChild(new Option("Selecione…", ""));
  (typeof CATEGORIAS_PADRAO !== "undefined" ? CATEGORIAS_PADRAO : []).forEach((c) => {
    select.appendChild(new Option(c, c));
  });
  select.appendChild(new Option("Outra (digitar)…", CATEGORIA_OUTRA_VALUE));

  select.addEventListener("change", () => {
    const isOutra = select.value === CATEGORIA_OUTRA_VALUE;
    $("#f-categoria-outra").classList.toggle("hidden", !isOutra);
    if (isOutra) $("#f-categoria-outra").focus();
  });
}

function resetCategoriaField() {
  $("#f-categoria").value = "";
  $("#f-categoria-outra").value = "";
  $("#f-categoria-outra").classList.add("hidden");
}

function markUncertainFields(fields) {
  const map = { data: "field-data", numero: "field-numero", cnpj: "field-cnpj", razao: "field-razao", valor: "field-valor" };
  Object.entries(map).forEach(([key, elId]) => {
    $("#" + elId).classList.toggle("warn", !fields[key]);
  });
}

// Frase compartilhada pelo banner (informativo, na revisão) e pelo modal
// de confirmação (que pede a decisão explícita antes de salvar).
function describeDupInfo(dupInfo) {
  const r = dupInfo.receipt;
  const quando = r.createdAt
    ? new Date(r.createdAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })
    : "antes";
  const estab = (r.fields && r.fields.razao) || "sem nome identificado";
  const motivo =
    dupInfo.reason === "foto"
      ? "a foto é muito parecida com a de uma nota já registrada"
      : "o número da nota e o CNPJ já foram registrados antes";
  return `Encontrei uma nota parecida — ${estab}, ${quando} — ${motivo}. Deseja continuar mesmo assim?`;
}

function renderDupBanner(dupInfo) {
  const banner = $("#dup-banner");
  if (!dupInfo) {
    banner.classList.add("hidden");
    return;
  }
  $("#dup-banner-text").textContent = describeDupInfo(dupInfo);
  banner.classList.remove("hidden");
}

function gatherFieldsFromForm() {
  const categoriaSelect = $("#f-categoria").value;
  const categoria =
    categoriaSelect === CATEGORIA_OUTRA_VALUE ? $("#f-categoria-outra").value.trim() : categoriaSelect;
  return {
    data: $("#f-data").value,
    numero: $("#f-numero").value.trim(),
    cnpj: $("#f-cnpj").value.trim(),
    razao: $("#f-razao").value.trim(),
    valor: $("#f-valor").value.trim(),
    pagamento: $("#f-pagamento").value,
    categoria,
  };
}

// Confirmar sempre salva a nota localmente e tenta enviar — mesmo que
// nenhum campo tenha sido preenchido. Não há validação que bloqueie o
// botão: uma nota incompleta ainda é melhor que uma nota perdida.
async function confirmAndSave() {
  const fields = gatherFieldsFromForm();
  const thumbnail = await makeThumbnail(capturedBlob).catch(() => null);

  // Guardamos a foto como ArrayBuffer (+ o tipo MIME), não como Blob/File
  // direto. O IndexedDB do Safari/iOS tem um bug conhecido em que um Blob
  // gravado volta com 0 bytes ao ser lido de volta (mais comum em PWA
  // instalado na tela de início) — sem erro nenhum, o app "conclui" o
  // envio normalmente e nenhum arquivo chega no OneDrive. ArrayBuffer não
  // sofre desse problema.
  const photoBuffer = await capturedBlob.arrayBuffer();
  const photoType = capturedBlob.type || "image/jpeg";

  const receipt = await Storage.addReceipt({
    fields,
    photoBuffer,
    photoType,
    imageHash: capturedImageHash,
    thumbnail,
    status: "pending",
    photoUploaded: false,
    rowAdded: false,
  });

  resetCaptureStage();
  showView("#view-saving");
  setSaveProgress(0, "Enviando a foto e a linha da planilha…");

  const outcome = await trySyncOne(receipt.id, (pct, label) => setSaveProgress(pct, label));

  showView("#view-home");
  await renderHome();

  if (outcome.ok) {
    showToast("Nota fiscal salva com sucesso.");
  } else if (outcome.reason === "redirect") {
    // saiu para autenticação interativa; nada a fazer aqui
  } else {
    showToast(outcome.message || "Não consegui enviar tudo agora. A nota ficou salva e vou tentar de novo.", true);
  }
}

function setSaveProgress(pct, label) {
  if (pct !== null) $("#save-progress-fill").style.width = pct + "%";
  if (label) $("#save-progress-label").textContent = label;
}

// ---------------------------------------------------------------
// Sincronização com o Microsoft Graph
// ---------------------------------------------------------------
// Foto e linha da planilha são tratadas como duas operações
// independentes: uma falhar não impede a outra de ser tentada, e cada
// uma só é repetida numa nova tentativa se ainda não tiver dado certo
// antes (evita duplicar foto/linha quando parte do envio já funcionou).
// Isso garante o que a Thais pediu: mesmo com campos não reconhecidos
// pelo OCR, uma linha (ainda que incompleta) sempre é criada na
// planilha, e a foto sempre é guardada no OneDrive.
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
  if (!receipt) {
    return { ok: false, message: "Não encontrei esta nota para reenviar." };
  }

  let token;
  try {
    token = await Auth.getToken();
  } catch (err) {
    console.error("Falha ao obter token:", err);
    await Storage.updateReceipt(id, { status: "error", errorMessage: err.message || "Falha na autenticação." });
    return { ok: false, message: err.message || "Falha na autenticação." };
  }
  if (!token) return { ok: false, reason: "redirect" }; // login interativo em andamento

  let photoOk = receipt.photoUploaded === true;
  let rowOk = receipt.rowAdded === true;
  const errors = [];

  // 1) Foto no OneDrive (pula se uma tentativa anterior já enviou).
  if (!photoOk) {
    // photoBuffer é o formato atual (ArrayBuffer); photoBlob é mantido só
    // para notas antigas que já estavam salvas antes dessa mudança.
    const photoBlob = receipt.photoBuffer
      ? new Blob([receipt.photoBuffer], { type: receipt.photoType || "image/jpeg" })
      : receipt.photoBlob || null;
    if (!photoBlob || !photoBlob.size) {
      errors.push("Foto não encontrada localmente para reenviar. Tire a foto novamente.");
    } else {
      try {
        if (onProgress) onProgress(10, "Enviando a foto para o OneDrive…");
        const filename = receipt.photoFilename || Graph.suggestFileName(receipt.fields);
        await Graph.uploadPhoto(settings, photoBlob, filename, token, (pct) => {
          if (onProgress) onProgress(10 + Math.round(pct * 0.5), "Enviando a foto para o OneDrive…");
        });
        photoOk = true;
        await Storage.updateReceipt(id, { photoUploaded: true, photoFilename: filename });
      } catch (err) {
        console.error("Falha ao enviar a foto:", err);
        errors.push(err.message || "Falha ao enviar a foto.");
      }
    }
  }

  // 2) Linha na planilha (pula se uma tentativa anterior já criou) —
  // tentada mesmo que o envio da foto acima tenha falhado.
  if (!rowOk) {
    try {
      if (onProgress) onProgress(70, "Adicionando linha na planilha…");
      await Graph.addExcelRow(settings, receipt.fields, token);
      rowOk = true;
      await Storage.updateReceipt(id, { rowAdded: true });
    } catch (err) {
      console.error("Falha ao adicionar linha na planilha:", err);
      errors.push(err.message || "Falha ao adicionar linha na planilha.");
    }
  }

  if (photoOk && rowOk) {
    if (onProgress) onProgress(100, "Concluído.");
    await Storage.updateReceipt(id, { status: "synced", errorMessage: null, photoBlob: null, photoBuffer: null });
    return { ok: true };
  }

  const message = errors.join(" ") || "Falha ao enviar.";
  await Storage.updateReceipt(id, { status: "error", errorMessage: message });
  return { ok: false, message };
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

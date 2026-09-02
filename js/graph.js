// ============================================================
// graph.js
// Duas operações no Microsoft Graph:
//  1) adicionar uma linha na tabela do Excel configurada;
//  2) enviar a foto original para a pasta do OneDrive configurada.
// Os caminhos (arquivo Excel, tabela, pasta) vêm das Configurações.
//
// Importante: os dois passos acima são independentes um do outro
// (ver trySyncOne em app.js) — mesmo que o OCR não tenha reconhecido
// todos os campos, ainda assim uma linha (possivelmente incompleta)
// deve ser criada na planilha, e a foto deve ser guardada no OneDrive.
// ============================================================

const Graph = (() => {
  const BASE = "https://graph.microsoft.com/v1.0";

  function encodePath(path) {
    const clean = path.replace(/^\/+|\/+$/g, "");
    return clean.split("/").map(encodeURIComponent).join("/");
  }

  async function graphFetch(url, token, options = {}) {
    const res = await fetch(url, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(options.headers || {}),
      },
    });
    if (!res.ok) {
      let detail = "";
      try {
        const body = await res.json();
        detail = body?.error?.message || "";
      } catch (e) {}
      throw new Error(`Falha na chamada ao Microsoft Graph (${res.status}). ${detail}`);
    }
    return res;
  }

  // Converte o texto do campo "valor" para número. Retorna `null` (não
  // uma string vazia ou texto não numérico) quando o campo não foi
  // preenchido ou não é um número válido — colunas do Excel formatadas
  // como número/moeda podem rejeitar a linha inteira se receberem uma
  // string vazia ou um texto qualquer no lugar de um número.
  function parseValorNumero(valorStr) {
    if (valorStr === 0) return 0;
    if (!valorStr) return null;
    let clean = String(valorStr).trim().replace(/[R$\s]/gi, "");
    // Só tratamos como "vírgula decimal brasileira" se houver vírgula.
    // "1.234,56" -> "1234.56" ; "1234,56" -> "1234.56" ; "1234.56" fica igual.
    if (clean.includes(",")) {
      clean = clean.replace(/\./g, "").replace(",", ".");
    }
    const n = parseFloat(clean);
    return isNaN(n) ? null : n;
  }

  // Campos de texto: string vazia é seguro. `null` explícito quando não
  // há valor (evita mandar "" para colunas que o Excel tenta tipar).
  function textOrNull(v) {
    return v ? v : null;
  }

  async function addExcelRow({ excelPath, excelTable }, fields, token) {
    const encoded = encodePath(excelPath);
    const url = `${BASE}/me/drive/root:/${encoded}:/workbook/tables('${encodeURIComponent(excelTable)}')/rows/add`;

    const row = [
      textOrNull(fields.data),
      textOrNull(fields.numero),
      textOrNull(fields.cnpj),
      textOrNull(fields.razao),
      parseValorNumero(fields.valor),
      textOrNull(fields.pagamento),
      textOrNull(fields.categoria),
    ];

    await graphFetch(url, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ values: [row] }),
    });
  }

  function suggestFileName(fields) {
    const datePart = fields.data || new Date().toISOString().slice(0, 10);
    const namePart = (fields.razao || "nota-fiscal")
      .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
      .replace(/[^a-zA-Z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "nota-fiscal";
    return `${datePart}_${namePart}_${Date.now()}.jpg`;
  }

  async function uploadPhoto({ oneDriveFolder }, blob, filename, token, onProgress) {
    const encodedFolder = encodePath(oneDriveFolder);
    const encodedFile = encodeURIComponent(filename);

    // Sessão de upload: robusta para fotos de qualquer tamanho vindas da câmera do iPhone.
    const sessionUrl = `${BASE}/me/drive/root:/${encodedFolder}/${encodedFile}:/createUploadSession`;
    const sessionRes = await graphFetch(sessionUrl, token, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item: { "@microsoft.graph.conflictBehavior": "rename" } }),
    });
    const session = await sessionRes.json();
    const uploadUrl = session.uploadUrl;

    const CHUNK_SIZE = 5 * 1024 * 1024; // múltiplo de 320 KiB, como exige o Graph
    const total = blob.size;
    let offset = 0;

    while (offset < total) {
      const end = Math.min(offset + CHUNK_SIZE, total);
      const chunk = blob.slice(offset, end);
      const res = await fetch(uploadUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(end - offset),
          "Content-Range": `bytes ${offset}-${end - 1}/${total}`,
        },
        body: chunk,
      });
      if (!res.ok && res.status !== 202) {
        throw new Error(`Falha ao enviar a foto para o OneDrive (${res.status}).`);
      }
      offset = end;
      if (onProgress) onProgress(Math.round((offset / total) * 100));
    }
  }

  return { addExcelRow, uploadPhoto, suggestFileName };
})();

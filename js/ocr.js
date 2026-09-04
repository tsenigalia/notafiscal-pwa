// ============================================================
// ocr.js
// Roda o OCR direto no navegador (Tesseract.js, sem servidor) e
// tenta extrair os campos de uma nota/cupom fiscal brasileiro a
// partir do texto reconhecido. É heurística por natureza: campo
// não identificado fica em branco, o fluxo nunca trava, e a
// pessoa confirma/corrige tudo na tela de revisão.
// ============================================================

const Ocr = (() => {
  // Worker do Tesseract é reaproveitado entre notas (evita recarregar o
  // modelo de idioma a cada foto) e configurado para tratar a imagem como
  // um único bloco de texto (PSM 6), o que costuma funcionar bem melhor
  // do que o modo automático em fotos de cupons/notas fiscais.
  let workerPromise = null;
  let progressCallback = null;

  async function getWorker() {
    if (!workerPromise) {
      workerPromise = Tesseract.createWorker("por", 1, {
        logger: (m) => {
          if (progressCallback) progressCallback(m);
        },
      }).then(async (worker) => {
        try {
          await worker.setParameters({
            tessedit_pageseg_mode: Tesseract.PSM ? Tesseract.PSM.SINGLE_BLOCK : "6",
          });
        } catch (e) {
          console.warn("Não foi possível ajustar parâmetros do Tesseract:", e);
        }
        return worker;
      });
    }
    return workerPromise;
  }

  // Converte a foto para tons de cinza e estica o contraste antes do OCR.
  // Fotos de cupons fiscais (impressão térmica desbotada, sombra do
  // celular, iluminação ruim) ganham bastante precisão com isso. Se algo
  // der errado aqui, cai de volta para a imagem original — o OCR nunca
  // deve travar por causa do pré-processamento.
  async function preprocessImage(file) {
    const bitmap = await createImageBitmap(file);
    const maxSide = 2200;
    const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
    const w = Math.max(1, Math.round(bitmap.width * scale));
    const h = Math.max(1, Math.round(bitmap.height * scale));

    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);

    const imgData = ctx.getImageData(0, 0, w, h);
    const d = imgData.data;

    let min = 255,
      max = 0;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const g = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
      gray[p] = g;
      if (g < min) min = g;
      if (g > max) max = g;
    }
    const range = Math.max(1, max - min);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = ((gray[p] - min) / range) * 255;
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(imgData, 0, 0);

    const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", 0.92));
    return blob || file;
  }

  async function recognize(imageFile, onProgress) {
    progressCallback = onProgress || null;

    let input = imageFile;
    try {
      input = await preprocessImage(imageFile);
    } catch (e) {
      console.warn("Pré-processamento de imagem falhou, uso a foto original:", e);
      input = imageFile;
    }

    try {
      const worker = await getWorker();
      const { data } = await worker.recognize(input);
      return data.text || "";
    } finally {
      progressCallback = null;
    }
  }

  function stripAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function parseDate(text) {
    // Procura preferencialmente uma data perto de uma palavra que indique
    // emissão. Cobre variações que o OCR costuma produzir ("emissao",
    // "emitida em", "dt emissao", etc.) e evita confundir com datas de
    // validade/vencimento/entrada que aparecem em outra linha do cupom.
    const lines = text.split(/\n/);
    const dateRe = /(\d{2})[\/\-.](\d{2})[\/\-.](\d{2,4})/;
    const emissKeywordRe = /(emiss|emitid|dt\.?\s*emiss)/;
    const avoidKeywordRe = /(valid|vencim|entrada|previs)/;

    for (let i = 0; i < lines.length; i++) {
      const norm = stripAccents(lines[i]).toLowerCase();
      if (!emissKeywordRe.test(norm) || avoidKeywordRe.test(norm)) continue;

      const m = lines[i].match(dateRe);
      if (m) {
        const iso = toIsoDate(m);
        if (iso) return iso;
      }
      // Em cupons estreitos o rótulo e o valor às vezes saem em linhas
      // separadas pelo OCR — tenta a linha seguinte antes de desistir.
      if (lines[i + 1]) {
        const m2 = lines[i + 1].match(dateRe);
        if (m2) {
          const iso2 = toIsoDate(m2);
          if (iso2) return iso2;
        }
      }
    }

    // Sem palavra-chave localizável: olha todas as datas válidas do texto
    // e prefere uma que não esteja numa linha de validade/vencimento —
    // melhor do que simplesmente pegar a primeira data que aparece.
    const candidates = [];
    for (const line of lines) {
      const norm = stripAccents(line).toLowerCase();
      const m = line.match(dateRe);
      if (m) {
        const iso = toIsoDate(m);
        if (iso) candidates.push({ iso, avoid: avoidKeywordRe.test(norm) });
      }
    }
    const preferred = candidates.find((c) => !c.avoid);
    if (preferred) return preferred.iso;
    return candidates.length ? candidates[0].iso : "";
  }

  function toIsoDate(m) {
    let [, dd, mm, yyyy] = m;
    if (yyyy.length === 2) yyyy = "20" + yyyy;
    const d = parseInt(dd, 10), mo = parseInt(mm, 10);
    if (d < 1 || d > 31 || mo < 1 || mo > 12) return "";
    return `${yyyy}-${mm.padStart(2, "0")}-${dd.padStart(2, "0")}`;
  }

  function parseCnpj(text) {
    const m = text.match(/\d{2}\.?\d{3}\.?\d{3}\/?\d{4}-?\d{2}/);
    if (!m) return "";
    const digits = m[0].replace(/\D/g, "");
    if (digits.length !== 14) return "";
    return `${digits.slice(0, 2)}.${digits.slice(2, 5)}.${digits.slice(5, 8)}/${digits.slice(8, 12)}-${digits.slice(12)}`;
  }

  function parseNumero(text) {
    const lines = text.split(/\n/);
    const keywordRe = /(n[ºo°.]?\s*(?:da\s*)?nf[- ]?e?|numero|nro\.?|n[ºo°]\s*doc)/i;
    for (const line of lines) {
      if (keywordRe.test(stripAccents(line).toLowerCase())) {
        const m = line.match(/(\d{3,12})/);
        if (m) return m[1].replace(/^0+(?=\d)/, "");
      }
    }
    return "";
  }

  function moneyToFloat(str) {
    // aceita formatos "1.234,56" ou "1234,56" ou "1234.56"
    let clean = str.replace(/[^\d.,]/g, "");
    if (clean.includes(",") && clean.includes(".")) {
      clean = clean.replace(/\./g, "").replace(",", ".");
    } else if (clean.includes(",")) {
      clean = clean.replace(",", ".");
    }
    const v = parseFloat(clean);
    return isNaN(v) ? null : v;
  }

  function parseValorTotal(text) {
    const lines = text.split(/\n/);
    const moneyRe = /(\d{1,3}(?:\.\d{3})*,\d{2}|\d+,\d{2})/;
    const priorityRe = /(valor\s*total|total\s*a\s*pagar|total\s*r\$|total\s*geral|^total\b)/;

    let best = null;
    for (const line of lines) {
      const norm = stripAccents(line).toLowerCase();
      if (priorityRe.test(norm)) {
        const m = line.match(moneyRe);
        if (m) {
          const v = moneyToFloat(m[1]);
          if (v !== null) return v.toFixed(2).replace(".", ",");
        }
      }
    }
    // fallback: maior valor monetário encontrado no texto inteiro
    const all = [...text.matchAll(new RegExp(moneyRe, "g"))];
    for (const m of all) {
      const v = moneyToFloat(m[1]);
      if (v !== null && (best === null || v > best)) best = v;
    }
    return best !== null ? best.toFixed(2).replace(".", ",") : "";
  }

  function cleanRazaoLine(line) {
    return line.replace(/\s{2,}/g, " ").trim();
  }

  // Linhas de cabeçalho que aparecem em quase todo cupom/nota, mas nunca
  // são o nome do estabelecimento — sem filtrar isso, a heurística abaixo
  // (primeira linha "parecida com nome") frequentemente pegava uma dessas
  // em vez do nome real, principalmente quando o nome vem em logo/fonte
  // estilizada que o OCR lê mal e a frase de cabeçalho — impressa em fonte
  // normal — sai mais limpa.
  const razaoBoilerplateRe =
    /(cupom fiscal|nota fiscal|documento auxiliar|via do (cliente|estabelecimento|consumidor)|extrato n[ãa]o fiscal|sat[- ]?cf-?e|nfc-?e|consumidor|cnpj|^ie[:.]|endere[çc]o|telefone|^tel[:.]|^cep[:.]|www\.|https?:)/i;

  function parseRazaoSocial(text) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);

    // 1) Rótulo explícito ("Razão Social:", "Nome Fantasia:", etc.) — mais
    // confiável quando presente, comum em DANFE/NFC-e.
    const labelRe = /(raz[aã]o\s*social|nome\s*fantasia|estabelecimento)\s*[:\-]\s*(.+)/i;
    for (const line of lines.slice(0, 12)) {
      const m = line.match(labelRe);
      if (m && m[2] && m[2].trim().length >= 4) {
        return cleanRazaoLine(m[2]);
      }
    }

    // 2) Sem rótulo: primeira linha que parece nome de empresa entre as
    // primeiras do cupom, ignorando as frases de cabeçalho padrão.
    for (const line of lines.slice(0, 8)) {
      if (razaoBoilerplateRe.test(line)) continue;
      const digitsOnly = line.replace(/\D/g, "");
      const letters = line.replace(/[^a-zA-ZÀ-ÿ]/g, "");
      if (letters.length >= 4 && digitsOnly.length < letters.length) {
        return cleanRazaoLine(line);
      }
    }
    return "";
  }

  function parsePagamento(text) {
    const norm = stripAccents(text).toLowerCase();
    if (/\bpix\b/.test(norm)) return "Pix";
    if (/cart[ãa]o.*credito|credito.*cart[ãa]o|\bcredito\b/.test(norm)) return "Cartão de crédito";
    if (/cart[ãa]o.*debito|debito.*cart[ãa]o|\bdebito\b/.test(norm)) return "Cartão de débito";
    if (/\bdinheiro\b/.test(norm)) return "Dinheiro";
    if (/\bboleto\b/.test(norm)) return "Boleto";
    return "";
  }

  function parseFields(text) {
    return {
      data: parseDate(text),
      numero: parseNumero(text),
      cnpj: parseCnpj(text),
      razao: parseRazaoSocial(text),
      valor: parseValorTotal(text),
      pagamento: parsePagamento(text),
    };
  }

  // ---------- Hash perceptual da foto (para avisar sobre duplicata) ----------
  // dHash simples: reduz a foto a uma grade pequena em tons de cinza e
  // registra, pixel a pixel, se ele é mais claro ou mais escuro que o
  // vizinho da direita. O resultado (64 bits, guardado como hex) muda
  // pouco entre duas fotos praticamente iguais da mesma nota, mesmo com
  // diferença de enquadramento/luz — não precisa ser perfeito, só bom o
  // suficiente para pegar "fotografei a mesma nota de novo por engano".
  async function computeImageHash(file) {
    const bitmap = await createImageBitmap(file);
    const w = 9,
      h = 8;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.drawImage(bitmap, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);

    const gray = [];
    for (let i = 0; i < data.length; i += 4) {
      gray.push(0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2]);
    }

    let bits = "";
    for (let row = 0; row < h; row++) {
      for (let col = 0; col < w - 1; col++) {
        bits += gray[row * w + col] > gray[row * w + col + 1] ? "1" : "0";
      }
    }
    let hex = "";
    for (let i = 0; i < bits.length; i += 4) {
      hex += parseInt(bits.slice(i, i + 4).padEnd(4, "0"), 2).toString(16);
    }
    return hex;
  }

  // Quantos bits diferem entre dois hashes (0 = idênticos, 64 = opostos).
  function hammingDistanceHex(hexA, hexB) {
    if (!hexA || !hexB || hexA.length !== hexB.length) return Infinity;
    let dist = 0;
    for (let i = 0; i < hexA.length; i++) {
      let x = parseInt(hexA[i], 16) ^ parseInt(hexB[i], 16);
      while (x) {
        dist += x & 1;
        x >>= 1;
      }
    }
    return dist;
  }

  return { recognize, parseFields, computeImageHash, hammingDistanceHex };
})();

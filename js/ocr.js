// ============================================================
// ocr.js
// Roda o OCR direto no navegador (Tesseract.js, sem servidor) e
// tenta extrair os campos de uma nota/cupom fiscal brasileiro a
// partir do texto reconhecido. É heurística por natureza: campo
// não identificado fica em branco, o fluxo nunca trava, e a
// pessoa confirma/corrige tudo na tela de revisão.
// ============================================================

const Ocr = (() => {
  async function recognize(imageFile, onProgress) {
    const { data } = await Tesseract.recognize(imageFile, "por", {
      logger: (m) => {
        if (onProgress) onProgress(m);
      },
    });
    return data.text || "";
  }

  function stripAccents(str) {
    return str.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  }

  function parseDate(text) {
    // Procura preferencialmente uma data perto da palavra "emiss".
    const lines = text.split(/\n/);
    const dateRe = /(\d{2})[\/\-.](\d{2})[\/\-.](\d{2,4})/;

    for (const line of lines) {
      const norm = stripAccents(line).toLowerCase();
      if (norm.includes("emiss")) {
        const m = line.match(dateRe);
        if (m) return toIsoDate(m);
      }
    }
    const m = text.match(dateRe);
    return m ? toIsoDate(m) : "";
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

  function parseRazaoSocial(text) {
    const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
    for (const line of lines.slice(0, 6)) {
      const digitsOnly = line.replace(/\D/g, "");
      const letters = line.replace(/[^a-zA-ZÀ-ÿ]/g, "");
      if (letters.length >= 4 && digitsOnly.length < letters.length) {
        return line.replace(/\s{2,}/g, " ").trim();
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

  return { recognize, parseFields };
})();

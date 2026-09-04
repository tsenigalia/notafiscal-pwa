// ============================================================
// storage.js
// Configurações do usuário (localStorage) + histórico/fila de
// envio das notas fiscais (IndexedDB), para nunca perder uma
// nota já fotografada mesmo se a conexão falhar.
// ============================================================

const Storage = (() => {
  const SETTINGS_KEY = "nf_settings_v1";
  const DB_NAME = "notasfiscais-db";
  const DB_VERSION = 1;
  const STORE = "receipts";

  // ---------- Configurações ----------
  function getSettings() {
    try {
      const raw = localStorage.getItem(SETTINGS_KEY);
      if (!raw) return { excelPath: "", excelTable: "", oneDriveFolder: "" };
      const parsed = JSON.parse(raw);
      return {
        excelPath: parsed.excelPath || "",
        excelTable: parsed.excelTable || "",
        oneDriveFolder: parsed.oneDriveFolder || "",
      };
    } catch (e) {
      return { excelPath: "", excelTable: "", oneDriveFolder: "" };
    }
  }

  function saveSettings(settings) {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  }

  function isConfigured() {
    const s = getSettings();
    return Boolean(s.excelPath && s.excelTable && s.oneDriveFolder);
  }

  // ---------- IndexedDB ----------
  let dbPromise = null;

  function openDb() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(STORE)) {
          const store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeMode) {
    const db = await openDb();
    return db.transaction(STORE, storeMode).objectStore(STORE);
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  async function addReceipt(receipt) {
    const store = await tx("readwrite");
    const record = { id: uuid(), createdAt: Date.now(), ...receipt };
    return new Promise((resolve, reject) => {
      const req = store.add(record);
      req.onsuccess = () => resolve(record);
      req.onerror = () => reject(req.error);
    });
  }

  async function updateReceipt(id, patch) {
    const store = await tx("readwrite");
    return new Promise((resolve, reject) => {
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const current = getReq.result;
        if (!current) return resolve(null);
        const updated = { ...current, ...patch };
        // valor null explicito = remover o campo (usado para descartar a
        // foto original depois que já foi sincronizada, e economizar espaço)
        Object.keys(patch).forEach((k) => {
          if (patch[k] === null) delete updated[k];
        });
        const putReq = store.put(updated);
        putReq.onsuccess = () => resolve(updated);
        putReq.onerror = () => reject(putReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async function getReceipt(id) {
    const store = await tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  async function deleteReceipt(id) {
    const store = await tx("readwrite");
    return new Promise((resolve, reject) => {
      const req = store.delete(id);
      req.onsuccess = () => resolve(true);
      req.onerror = () => reject(req.error);
    });
  }

  async function getAllReceipts() {
    const store = await tx("readonly");
    return new Promise((resolve, reject) => {
      const req = store.getAll();
      req.onsuccess = () => {
        const all = req.result || [];
        all.sort((a, b) => b.createdAt - a.createdAt);
        resolve(all);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async function getPendingReceipts() {
    const all = await getAllReceipts();
    return all.filter((r) => r.status === "pending" || r.status === "error");
  }

  return {
    getSettings,
    saveSettings,
    isConfigured,
    addReceipt,
    updateReceipt,
    getReceipt,
    deleteReceipt,
    getAllReceipts,
    getPendingReceipts,
  };
})();

// ============================================================
// storage.js
// Configurações do usuário (localStorage) + histórico/fila de
// envio das notas fiscais (IndexedDB), para nunca perder uma
// nota já fotografada mesmo se a conexão falhar.
//
// A partir da v2, os dados ficam em DOIS object stores:
//   - "receipts": só metadados (campos da nota, status, hash da
//     imagem, miniatura pequena) — leve, rápido de listar.
//   - "photos": só a foto original (ArrayBuffer, potencialmente
//     vários MB) — só é lida quando realmente precisamos enviar
//     a foto para o OneDrive.
// Antes dessa mudança, tudo ficava junto em "receipts", e
// qualquer leitura de lista (tela inicial, checagem de nota
// duplicada) carregava também as fotos de TODAS as notas ainda
// não sincronizadas — inclusive as antigas, acumuladas de testes
// anteriores. Isso é o que travava o app logo depois de ler a
// nota: virou uma leitura pesada de vários MB no meio do fluxo.
// ============================================================

const Storage = (() => {
  const SETTINGS_KEY = "nf_settings_v1";
  const DB_NAME = "notasfiscais-db";
  const DB_VERSION = 2;
  const STORE = "receipts";
  const PHOTO_STORE = "photos";
  const PHOTO_FIELDS = ["photoBuffer", "photoType", "photoBlob"];

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
      req.onupgradeneeded = (event) => {
        const db = req.result;
        const tx = req.transaction;
        let store;
        if (!db.objectStoreNames.contains(STORE)) {
          store = db.createObjectStore(STORE, { keyPath: "id" });
          store.createIndex("status", "status", { unique: false });
          store.createIndex("createdAt", "createdAt", { unique: false });
        } else {
          store = tx.objectStore(STORE);
        }
        if (!db.objectStoreNames.contains(PHOTO_STORE)) {
          db.createObjectStore(PHOTO_STORE, { keyPath: "id" });
        }
        const photoStore = tx.objectStore(PHOTO_STORE);

        // Migração v1 -> v2: tira a foto (pesada) de dentro de cada
        // registro de "receipts" e move para "photos", guardando só
        // metadados leves em "receipts".
        if (event.oldVersion < 2) {
          store.openCursor().onsuccess = (e) => {
            const cursor = e.target.result;
            if (!cursor) return;
            const record = cursor.value;
            const hasPhoto = PHOTO_FIELDS.some((f) => record[f] !== undefined);
            if (hasPhoto) {
              const photoRecord = { id: record.id };
              PHOTO_FIELDS.forEach((f) => {
                if (record[f] !== undefined) photoRecord[f] = record[f];
                delete record[f];
              });
              photoStore.put(photoRecord);
              cursor.update(record);
            }
            cursor.continue();
          };
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return dbPromise;
  }

  async function tx(storeNames, mode) {
    const db = await openDb();
    return db.transaction(storeNames, mode);
  }

  function uuid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function reqToPromise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function splitReceipt(receipt) {
    const meta = {};
    const photo = {};
    Object.keys(receipt).forEach((k) => {
      if (PHOTO_FIELDS.includes(k)) photo[k] = receipt[k];
      else meta[k] = receipt[k];
    });
    return { meta, photo };
  }

  async function addReceipt(receipt) {
    const { meta, photo } = splitReceipt(receipt);
    const record = { id: uuid(), createdAt: Date.now(), ...meta };
    const t = await tx([STORE, PHOTO_STORE], "readwrite");
    const metaStore = t.objectStore(STORE);
    const photoStore = t.objectStore(PHOTO_STORE);
    metaStore.add(record);
    if (Object.keys(photo).length) {
      photoStore.put({ id: record.id, ...photo });
    }
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve({ ...record, ...photo });
      t.onerror = () => reject(t.error);
    });
  }

  // Lê e regrava dentro da MESMA transação (get -> put encadeados via
  // onsuccess, nunca com um "await" entre os dois) — é o jeito seguro de
  // fazer read-modify-write em IndexedDB sem risco da transação fechar
  // sozinha no meio do caminho em navegadores mais antigos (inclusive
  // Safari/iOS mais velhos).
  async function updateReceipt(id, patch) {
    const { meta: metaPatch, photo: photoPatch } = splitReceipt(patch);
    const t = await tx([STORE, PHOTO_STORE], "readwrite");
    const metaStore = t.objectStore(STORE);
    const photoStore = t.objectStore(PHOTO_STORE);

    let updatedMeta = null;

    return new Promise((resolve, reject) => {
      if (Object.keys(metaPatch).length) {
        const getReq = metaStore.get(id);
        getReq.onsuccess = () => {
          const current = getReq.result;
          if (current) {
            updatedMeta = { ...current, ...metaPatch };
            Object.keys(metaPatch).forEach((k) => {
              if (metaPatch[k] === null) delete updatedMeta[k];
            });
            metaStore.put(updatedMeta);
          }
        };
        getReq.onerror = () => reject(getReq.error);
      }

      if (Object.keys(photoPatch).length) {
        const getPhotoReq = photoStore.get(id);
        getPhotoReq.onsuccess = () => {
          const currentPhoto = getPhotoReq.result || { id };
          const updatedPhoto = { ...currentPhoto, ...photoPatch };
          Object.keys(photoPatch).forEach((k) => {
            if (photoPatch[k] === null) delete updatedPhoto[k];
          });
          const stillHasPhoto = PHOTO_FIELDS.some((f) => updatedPhoto[f] !== undefined);
          if (stillHasPhoto) photoStore.put(updatedPhoto);
          else photoStore.delete(id);
        };
        getPhotoReq.onerror = () => reject(getPhotoReq.error);
      }

      t.oncomplete = () => {
        if (updatedMeta !== null) return resolve(updatedMeta);
        if (Object.keys(photoPatch).length) {
          getReceipt(id).then(resolve, reject);
          return;
        }
        resolve(null);
      };
      t.onerror = () => reject(t.error);
    });
  }

  // Metadados + foto, junto — usado quando vamos de fato enviar a
  // nota (precisa do ArrayBuffer da foto).
  async function getReceipt(id) {
    const t = await tx([STORE, PHOTO_STORE], "readonly");
    const metaStore = t.objectStore(STORE);
    const photoStore = t.objectStore(PHOTO_STORE);
    const [meta, photo] = await Promise.all([
      reqToPromise(metaStore.get(id)),
      reqToPromise(photoStore.get(id)),
    ]);
    if (!meta) return null;
    return { ...meta, ...(photo || {}) };
  }

  async function deleteReceipt(id) {
    const t = await tx([STORE, PHOTO_STORE], "readwrite");
    t.objectStore(STORE).delete(id);
    t.objectStore(PHOTO_STORE).delete(id);
    return new Promise((resolve, reject) => {
      t.oncomplete = () => resolve(true);
      t.onerror = () => reject(t.error);
    });
  }

  // Só metadados (sem a foto) — rápido, usado para listar a tela
  // inicial e para checar nota duplicada. Nunca carrega o
  // ArrayBuffer da foto de nenhuma nota.
  async function getAllReceipts() {
    const t = await tx([STORE], "readonly");
    const store = t.objectStore(STORE);
    const all = (await reqToPromise(store.getAll())) || [];
    all.sort((a, b) => b.createdAt - a.createdAt);
    return all;
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

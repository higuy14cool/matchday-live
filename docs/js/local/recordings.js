// Broadcast recordings live in IndexedDB: big enough for a whole match,
// unlike localStorage, and they survive a reload in this browser.

const DB_NAME = 'matchday-recordings';
const STORE = 'videos';

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('Could not open the video store'));
  });
  return dbPromise;
}

async function withStore(mode, run) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const store = tx.objectStore(STORE);
    let result;
    try {
      result = run(store);
    } catch (err) {
      reject(err);
      return;
    }
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error || new Error('Video store error'));
    tx.onabort = () => reject(tx.error || new Error('Video store aborted'));
  });
}

export async function saveRecording(gameId, blob) {
  await withStore('readwrite', store => store.put(blob, gameId));
}

export async function getRecording(gameId) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const request = tx.objectStore(STORE).get(gameId);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => reject(request.error);
  });
}

export async function deleteRecording(gameId) {
  await withStore('readwrite', store => store.delete(gameId));
}

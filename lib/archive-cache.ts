// IndexedDB cache for the bookmark archive. The data Web Worker (lib/data-worker.ts) renders the
// cached copy instantly, then revalidates against /api/archive with If-None-Match: the daily sync
// changes the archive at most once a day, so almost every page load becomes a 304 instead of a
// ~12 MB download. Works in both the Web Worker and the main thread (sign-out clears it).
//
// Every call is best-effort: IndexedDB can be missing or throw (private windows, blocked storage,
// quota), and the app must still load straight from the network when it does.

const DB_NAME = "xbookmarks-archive";
// Bump to drop entries written in an older shape.
const DB_VERSION = 1;
const STORE = "archive";
const KEY = "current";

export type CachedArchive = {
  etag: string;
  payload: unknown;
  storedAt: number;
};

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (db.objectStoreNames.contains(STORE)) db.deleteObjectStore(STORE);
      db.createObjectStore(STORE);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error("archive cache blocked"));
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = op(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  } finally {
    db.close();
  }
}

export async function readArchiveCache(): Promise<CachedArchive | null> {
  try {
    const entry = (await run("readonly", (s) => s.get(KEY))) as CachedArchive | undefined;
    return entry && typeof entry.etag === "string" && entry.payload ? entry : null;
  } catch {
    return null;
  }
}

export async function writeArchiveCache(etag: string, payload: unknown): Promise<void> {
  try {
    await run("readwrite", (s) => s.put({ etag, payload, storedAt: Date.now() } satisfies CachedArchive, KEY));
  } catch {
    // Quota/blocked storage: the next load just fetches the full archive again.
  }
}

// Called on sign-out and on a 401 so the private archive doesn't outlive the session on this device.
export async function clearArchiveCache(): Promise<void> {
  try {
    await run("readwrite", (s) => s.delete(KEY));
  } catch {
    // Nothing cached or storage unavailable.
  }
}

// IndexedDB persistence: sessions, settings, imports; JSON backup/restore.
const DB_NAME = 'treadmill-lab', DB_VER = 1;
let dbp = null;
function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('sessions')) { const s = db.createObjectStore('sessions', { keyPath: 'id' }); s.createIndex('startedAt', 'startedAt'); }
      if (!db.objectStoreNames.contains('settings')) db.createObjectStore('settings', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('imports')) { const s = db.createObjectStore('imports', { keyPath: 'id' }); s.createIndex('startedAt', 'startedAt'); }
    };
    req.onsuccess = () => resolve(req.result); req.onerror = () => reject(req.error);
  });
  return dbp;
}
function tx(store, mode, fn) {
  return open().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode); const s = t.objectStore(store); let out;
    try { out = fn(s); } catch (e) { reject(e); return; }
    t.oncomplete = () => resolve(out && out.result !== undefined ? out.result : out); t.onerror = () => reject(t.error); t.onabort = () => reject(t.error);
  }));
}
export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export const store = {
  async getSettings() { try { const r = await tx('settings', 'readonly', s => s.get('main')); return r ? r.value : null; } catch (e) { return null; } },
  async saveSettings(value) { return tx('settings', 'readwrite', s => s.put({ key: 'main', value })); },
  async putSession(session) { if (!session.id) session.id = uid(); session.updatedAt = Date.now(); await tx('sessions', 'readwrite', s => s.put(session)); return session.id; },
  async getSession(id) { return tx('sessions', 'readonly', s => s.get(id)); },
  async deleteSession(id) { return tx('sessions', 'readwrite', s => s.delete(id)); },
  async listSessions() { const all = await tx('sessions', 'readonly', s => s.getAll()); return (all || []).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); },
  /** Lightweight list (no heavy arrays) for UI lists. */
  async listSessionSummaries() { const all = await this.listSessions(); return all.map(({ rr, features, hrLive, smo2, ...rest }) => ({ ...rest, hasSmo2: !!(smo2 && smo2.series && smo2.series.length), nFeatures: features ? features.length : 0 })); },
  async putImport(imp) { if (!imp.id) imp.id = uid(); await tx('imports', 'readwrite', s => s.put(imp)); return imp.id; },
  async listImports() { const all = await tx('imports', 'readonly', s => s.getAll()); return (all || []).sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0)); },
  async getImport(id) { return tx('imports', 'readonly', s => s.get(id)); },
  async deleteImport(id) { return tx('imports', 'readwrite', s => s.delete(id)); },
  async exportAll() { return { app: 'treadmill-lab', version: 1, exportedAt: new Date().toISOString(), settings: await this.getSettings(), sessions: await this.listSessions(), imports: await this.listImports() }; },
  async importAll(backup, { merge = true } = {}) {
    if (!backup || backup.app !== 'treadmill-lab') throw new Error('not a Treadmill Lab backup');
    if (!merge) { await this.clearAll(); }
    if (backup.settings) await this.saveSettings(backup.settings);
    for (const s of backup.sessions || []) await tx('sessions', 'readwrite', st => st.put(s));
    for (const i of backup.imports || []) await tx('imports', 'readwrite', st => st.put(i));
    return { sessions: (backup.sessions || []).length, imports: (backup.imports || []).length };
  },
  async clearAll() { await tx('sessions', 'readwrite', s => s.clear()); await tx('imports', 'readwrite', s => s.clear()); await tx('settings', 'readwrite', s => s.clear()); },
};

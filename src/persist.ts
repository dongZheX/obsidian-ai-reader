/* Per-file persistence: chat history + parsed-block cache, stored as JSON under
 * the plugin's cache dir. Ported from loadChat/saveChat/loadCache/saveCache. */
import { App } from "obsidian";
import { Block, ChatMessage } from "./types";

export interface ChatBundle { version: number; date: string; messages: ChatMessage[]; }

export class Persist {
  constructor(private app: App, private pluginId: string) {}

  private dir(): string { return this.app.vault.configDir + "/plugins/" + this.pluginId + "/cache"; }
  private key(path: string): string { return path.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 120) + "_" + hash(path); }
  private chatPath(path: string): string { return this.dir() + "/" + this.key(path) + "-chat.json"; }
  private blockPath(path: string): string { return this.dir() + "/" + this.key(path) + "-blocks.json"; }
  // The in-vault synced copy lives in a normal vault folder so the user's vault
  // sync (Obsidian Sync, iCloud, git, …) carries it across machines.
  private syncPath(folder: string, path: string): string { return folder.replace(/\/+$/, "") + "/" + this.key(path) + ".json"; }

  private async ensureDir() {
    const a = this.app.vault.adapter;
    if (!(await a.exists(this.dir()))) { try { await a.mkdir(this.dir()); } catch (e) {} }
  }
  // Create each segment of an in-vault folder path (adapter.mkdir is one level).
  private async ensureVaultDir(folder: string) {
    const a = this.app.vault.adapter;
    const parts = folder.replace(/\/+$/, "").split("/").filter(Boolean);
    let cur = "";
    for (const seg of parts) { cur = cur ? cur + "/" + seg : seg; if (!(await a.exists(cur))) { try { await a.mkdir(cur); } catch (e) {} } }
  }

  async loadChat(path: string): Promise<ChatMessage[] | null> {
    const b = await this.loadChatBundle(path);
    return b ? b.messages : null;
  }
  async loadChatBundle(path: string): Promise<ChatBundle | null> {
    try {
      const p = this.chatPath(path);
      if (!(await this.app.vault.adapter.exists(p))) return null;
      const obj = JSON.parse(await this.app.vault.adapter.read(p));
      return Array.isArray(obj.messages) ? { version: obj.version || 1, date: obj.date || "", messages: obj.messages } : null;
    } catch (e) { return null; }
  }
  async saveChat(path: string, hist: ChatMessage[]): Promise<void> {
    try { await this.ensureDir(); await this.app.vault.adapter.write(this.chatPath(path), JSON.stringify({ version: 1, date: new Date().toISOString(), messages: hist })); } catch (e) {}
  }

  // ---- synced (in-vault) copy ----
  async loadSyncedBundle(folder: string, path: string): Promise<ChatBundle | null> {
    try {
      const p = this.syncPath(folder, path);
      if (!(await this.app.vault.adapter.exists(p))) return null;
      const obj = JSON.parse(await this.app.vault.adapter.read(p));
      return Array.isArray(obj.messages) ? { version: obj.version || 1, date: obj.date || "", messages: obj.messages } : null;
    } catch (e) { return null; }
  }
  async saveSynced(folder: string, path: string, hist: ChatMessage[]): Promise<void> {
    try { await this.ensureVaultDir(folder); await this.app.vault.adapter.write(this.syncPath(folder, path), JSON.stringify({ version: 1, date: new Date().toISOString(), source: path, messages: hist }, null, 2)); } catch (e) {}
  }

  async loadBlocks(path: string, mtime: number): Promise<Block[] | null> {
    try {
      const p = this.blockPath(path);
      if (!(await this.app.vault.adapter.exists(p))) return null;
      const obj = JSON.parse(await this.app.vault.adapter.read(p));
      if (obj.mtime && mtime && obj.mtime !== mtime) return null; // stale
      return Array.isArray(obj.blocks) ? obj.blocks : null;
    } catch (e) { return null; }
  }
  async saveBlocks(path: string, mtime: number, blocks: Block[]): Promise<void> {
    try { await this.ensureDir(); await this.app.vault.adapter.write(this.blockPath(path), JSON.stringify({ version: 1, mtime, blocks })); } catch (e) {}
  }
}

// Pick the newer of two chat bundles by ISO `date` (local vs the in-vault synced
// copy). Null-safe; ties keep the local copy. Pure so it's unit-testable.
export function newerBundle(local: ChatBundle | null, synced: ChatBundle | null): { bundle: ChatBundle | null; fromSync: boolean } {
  if (!synced) return { bundle: local, fromSync: false };
  if (!local) return { bundle: synced, fromSync: true };
  const ls = Date.parse(local.date || "") || 0;
  const ss = Date.parse(synced.date || "") || 0;
  return ss > ls ? { bundle: synced, fromSync: true } : { bundle: local, fromSync: false };
}

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

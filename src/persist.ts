/* Per-file persistence: chat history + parsed-block cache, stored as JSON under
 * the plugin's cache dir. Ported from loadChat/saveChat/loadCache/saveCache. */
import { App } from "obsidian";
import { Block, ChatMessage } from "./types";

export class Persist {
  constructor(private app: App, private pluginId: string) {}

  private dir(): string { return this.app.vault.configDir + "/plugins/" + this.pluginId + "/cache"; }
  private key(path: string): string { return path.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 120) + "_" + hash(path); }
  private chatPath(path: string): string { return this.dir() + "/" + this.key(path) + "-chat.json"; }
  private blockPath(path: string): string { return this.dir() + "/" + this.key(path) + "-blocks.json"; }

  private async ensureDir() {
    const a = this.app.vault.adapter;
    if (!(await a.exists(this.dir()))) { try { await a.mkdir(this.dir()); } catch (e) {} }
  }

  async loadChat(path: string): Promise<ChatMessage[] | null> {
    try {
      const p = this.chatPath(path);
      if (!(await this.app.vault.adapter.exists(p))) return null;
      const obj = JSON.parse(await this.app.vault.adapter.read(p));
      return Array.isArray(obj.messages) ? obj.messages : null;
    } catch (e) { return null; }
  }
  async saveChat(path: string, hist: ChatMessage[]): Promise<void> {
    try { await this.ensureDir(); await this.app.vault.adapter.write(this.chatPath(path), JSON.stringify({ version: 1, date: new Date().toISOString(), messages: hist })); } catch (e) {}
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

function hash(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

/* "存为笔记": append the conversation to a sibling "<title> — AI Reader.md"
 * note (or create it), ported in spirit from _appendOrCreateNote. */
import { App, TFile, normalizePath } from "obsidian";
import { ChatMessage } from "./types";

function clean(md: string): string {
  // drop annotation directives; keep [B<id>] citations as plain markers
  return (md || "")
    .replace(/\[\[(?:hl|note):B?\d+(?:\|[^\]]*)?\]\]/g, "")
    .replace(/\[\[fig:B?\d+\]\]/g, "");
}

function convoToMarkdown(hist: ChatMessage[]): string {
  const parts: string[] = [];
  for (const m of hist) {
    if (m.role === "user") parts.push("**问：** " + String(m.content));
    else if (m.role === "assistant") parts.push(clean(String(m.content)));
  }
  return parts.join("\n\n");
}

export async function saveConversationToNote(app: App, source: TFile, hist: ChatMessage[], model: string): Promise<TFile> {
  const base = source.basename;
  const folder = source.parent ? source.parent.path : "";
  const targetPath = normalizePath((folder ? folder + "/" : "") + base + " — AI Reader.md");
  const footer = "\n\n<small>— AI Reader · " + (model || "") + " · " + new Date().toLocaleString() + "</small>\n";
  const body = convoToMarkdown(hist) + footer;

  const existing = app.vault.getAbstractFileByPath(targetPath);
  if (existing instanceof TFile) {
    const old = await app.vault.read(existing);
    await app.vault.modify(existing, old + "\n\n---\n\n" + body);
    return existing;
  }
  const header = "# AI Reader — [[" + base + "]]\n\n";
  return await app.vault.create(targetPath, header + body);
}

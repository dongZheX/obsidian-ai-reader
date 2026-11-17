/* Copy the built plugin into the vault's plugins folder.
 * Usage: node scripts/deploy.mjs [vaultPluginDir]
 * Defaults to ~/dongzhe-md/.obsidian/plugins/obsidian-ai-reader */
import { cpSync, mkdirSync, existsSync } from "fs";
import { homedir } from "os";
import { join } from "path";

const dest = process.argv[2] || join(homedir(), "dongzhe-md/.obsidian/plugins/obsidian-ai-reader");
mkdirSync(dest, { recursive: true });
for (const f of ["manifest.json", "main.js", "styles.css"]) {
  if (!existsSync(f)) { console.error("missing " + f + " — run `npm run build` first"); process.exit(1); }
  cpSync(f, join(dest, f));
}
console.log("deployed to " + dest);

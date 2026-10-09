// The extension can't import outside its own folder, so copy the shared modules in.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = path.join(root, "extension", "lib");
fs.mkdirSync(lib, { recursive: true });
for (const [from, to] of [["public/rules.js", "rules.js"], ["personas.js", "personas.js"]]) {
  fs.copyFileSync(path.join(root, from), path.join(lib, to));
  console.log(`copied ${from} -> extension/lib/${to}`);
}

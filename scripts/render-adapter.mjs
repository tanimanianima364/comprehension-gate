import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const defaultRoot = path.resolve(scriptDirectory, "..");
const args = process.argv.slice(2);
const provider = args.shift();

if (!new Set(["cursor", "kiro"]).has(provider)) {
  fail("Usage: node scripts/render-adapter.mjs <cursor|kiro> [--root PATH] [--output PATH] [--force]");
}

let pluginRoot = defaultRoot;
let outputPath = null;
let force = false;

while (args.length > 0) {
  const flag = args.shift();
  if (flag === "--root") {
    pluginRoot = path.resolve(requiredValue(flag));
  } else if (flag === "--output") {
    outputPath = path.resolve(requiredValue(flag));
  } else if (flag === "--force") {
    force = true;
  } else {
    fail(`Unknown option: ${flag}`);
  }
}

const templatePath = path.join(defaultRoot, "adapters", provider, "hooks.json");
const template = JSON.parse(fs.readFileSync(templatePath, "utf8"));
const rendered = replaceRoot(template, pluginRoot);
const serialized = `${JSON.stringify(rendered, null, 2)}\n`;

if (!outputPath) {
  process.stdout.write(serialized);
} else {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, serialized, {
    encoding: "utf8",
    flag: force ? "w" : "wx",
    mode: 0o600
  });
  process.stdout.write(`Wrote ${provider} adapter to ${outputPath}\n`);
}

function replaceRoot(value, root) {
  if (typeof value === "string") {
    return value.replaceAll("__COMPREHENSION_GATE_ROOT__", root);
  }
  if (Array.isArray(value)) {
    return value.map(item => replaceRoot(item, root));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, replaceRoot(item, root)])
    );
  }
  return value;
}

function requiredValue(flag) {
  const value = args.shift();
  if (!value) {
    fail(`${flag} requires a value.`);
  }
  return value;
}

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

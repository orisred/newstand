/* eslint-env node */
// Deploys an app config with the customer portal's API URL taken from that config's application_url.
// Extensions get no environment, so the URL is a constant in Portal.jsx; it's set for the deploy and
// put back after, so the source always holds the dev app's URL. Usage: node scripts/deploy-app.mjs
// <config> [shopify app deploy flags], where <config> names shopify.app.<config>.toml.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const [config, ...flags] = process.argv.slice(2);
const fail = (message) => {
  console.error(message);
  process.exit(1);
};
if (!config) fail("Name the config, for example: node scripts/deploy-app.mjs cake-zine");
const toml = readFileSync(`shopify.app.${config}.toml`, "utf8");
if (/^\s*[^#\s].*PLACEHOLDER/m.test(toml)) fail(`shopify.app.${config}.toml still has a PLACEHOLDER value.`);
const appUrl = toml.match(/^application_url\s*=\s*"(https:\/\/[^"]+)"/m)?.[1];
if (!appUrl) fail(`No https application_url in shopify.app.${config}.toml.`);

const file = "extensions/customer-portal/src/Portal.jsx";
const source = readFileSync(file, "utf8");
const line = /^const API = '[^']*';$/m;
if (!line.test(source)) fail(`No "const API = '...';" line in ${file}.`);
const deployed = source.replace(line, `const API = '${appUrl}/api/portal';`);

writeFileSync(file, deployed);
console.log(`Portal API for this deploy: ${appUrl}/api/portal`);
try {
  const result = spawnSync("npx", ["shopify", "app", "deploy", "--config", config, ...flags], { stdio: "inherit" });
  process.exitCode = result.status ?? 1;
} finally {
  writeFileSync(file, source);
}

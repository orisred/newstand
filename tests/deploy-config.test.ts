/// <reference types="vite/client" />
import { describe, expect, it } from "vitest";
import portal from "../extensions/customer-portal/src/Portal.jsx?raw";
import production from "../shopify.app.cake-zine.toml?raw";
import dev from "../shopify.app.toml?raw";

const urlOf = (toml: string) => toml.match(/^application_url\s*=\s*"([^"]+)"/m)?.[1];
const from = (toml: string, start: string) => toml.slice(toml.indexOf(start));

describe("app configs", () => {
  it("the portal source points at the dev app; scripts/deploy-app.mjs sets it for production", () => {
    expect(portal).toContain(`const API = '${urlOf(dev)}/api/portal';`);
  });

  it("production has the dev app's webhooks and scopes, without the cart rule or Flow", () => {
    expect(from(production, "[webhooks]")).toBe(from(dev, "[webhooks]"));
    const directories = production.match(/^extension_directories\s*=\s*\[(.*)\]/m)?.[1] ?? "";
    expect(directories).toContain("extensions/plan-picker");
    expect(directories).toContain("extensions/customer-portal");
    expect(directories).not.toMatch(/one-plan-per-cart|flow-triggers|\*/);
  });
});

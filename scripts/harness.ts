/**
 * The runner every e2e and domain script shares: one check signature that
 * compares against a literal, polling for writes that land after the
 * screen, operator sign-in, menu lookup, and the pass/fail exit.
 */
import { chromium, type Page } from "playwright";
import { db, menuItems, modifierGroups, modifiers } from "../src/db";

export const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3000";
export const SHOT_DIR = process.env.E2E_SHOT_DIR ?? "/tmp";

let failures = 0;

/** Compared as JSON, so the expected literal reads the way a failure prints it. */
export function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${ok ? "" : ` — expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
  if (!ok) failures++;
}

/** Polls until `fn` holds or `ms` passes, then answers one last time. */
export async function eventually(fn: () => Promise<boolean>, ms = 6_000): Promise<boolean> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 250));
  }
  return fn();
}

/** The sandbox's pre-installed Chromium; the playwright package's pinned build may not match it. */
export function launchBrowser() {
  return chromium.launch({ executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium" });
}

export type Account = { email: string; password: string; name: string };

/**
 * Opens `path` as an operator: creates the first account through setup on a
 * fresh store, signs in otherwise, and lands back on `path`.
 */
export async function signIn(page: Page, account: Account, path = "/admin"): Promise<void> {
  await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
  const setup = page.url().includes("/admin/setup");
  if (!setup && !page.url().includes("/admin/login")) return;
  if (setup) await page.fill('input[name="name"]', account.name);
  await page.fill('input[name="email"]', account.email);
  await page.fill('input[name="password"]', account.password);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/admin$/, { timeout: 20_000 });
  if (path !== "/admin") await page.goto(`${BASE}${path}`, { waitUntil: "networkidle" });
}

/** Menu item and modifier ids by name, as the seed names them. */
export async function menuLookup() {
  const [items, groups, mods] = await Promise.all([
    db.select().from(menuItems),
    db.select().from(modifierGroups),
    db.select().from(modifiers),
  ]);
  const found = <T>(what: string, row: T | undefined): T => {
    if (row === undefined) throw new Error(`${what} is not on the seeded menu`);
    return row;
  };
  const item = (name: string) => found(name, items.find((i) => i.name === name)).id;
  const pick = (group: string, name: string) => {
    const groupId = found(group, groups.find((g) => g.name === group)).id;
    return found(`${group}: ${name}`, mods.find((m) => m.groupId === groupId && m.name === name)).id;
  };
  return { item, pick };
}

/** Runs a script's checks and exits 0 only if every one passed and nothing threw. */
export function run(main: () => Promise<void>): void {
  main().then(
    () => {
      console.log(failures === 0 ? "\nALL PASSED" : `\n${failures} FAILED`);
      process.exit(failures === 0 ? 0 : 1);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}

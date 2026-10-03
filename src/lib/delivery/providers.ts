import { z } from "zod";
import { doordashDrive } from "./doordash-drive";
import type { CourierProvider, CourierProviderId } from "./types";
import { uberDirect } from "./uber-direct";

const set = z.string().min(1);

const uberEnv = z
  .object({
    UBER_DIRECT_CUSTOMER_ID: set,
    UBER_DIRECT_CLIENT_ID: set,
    UBER_DIRECT_CLIENT_SECRET: set,
    UBER_DIRECT_WEBHOOK_SIGNING_KEY: set,
    UBER_DIRECT_TOKEN_URL: z.url().optional(),
    UBER_DIRECT_SANDBOX: z.string().optional(),
  })
  .transform((e) =>
    uberDirect({
      customerId: e.UBER_DIRECT_CUSTOMER_ID,
      clientId: e.UBER_DIRECT_CLIENT_ID,
      clientSecret: e.UBER_DIRECT_CLIENT_SECRET,
      webhookSigningKey: e.UBER_DIRECT_WEBHOOK_SIGNING_KEY,
      tokenUrl: e.UBER_DIRECT_TOKEN_URL ?? "https://auth.uber.com/oauth/v2/token",
      sandbox: e.UBER_DIRECT_SANDBOX === "1",
    }),
  );

const doordashEnv = z
  .object({
    DOORDASH_DRIVE_DEVELOPER_ID: set,
    DOORDASH_DRIVE_KEY_ID: set,
    DOORDASH_DRIVE_SIGNING_SECRET: set,
    DOORDASH_DRIVE_WEBHOOK_AUTH: set,
  })
  .transform((e) =>
    doordashDrive({
      developerId: e.DOORDASH_DRIVE_DEVELOPER_ID,
      keyId: e.DOORDASH_DRIVE_KEY_ID,
      signingSecret: e.DOORDASH_DRIVE_SIGNING_SECRET,
      webhookAuth: e.DOORDASH_DRIVE_WEBHOOK_AUTH,
    }),
  );

const ENV = [
  { prefix: "UBER_DIRECT_", schema: uberEnv },
  { prefix: "DOORDASH_DRIVE_", schema: doordashEnv },
];

let providers: CourierProvider[] | undefined;

/** Providers with complete credentials in the environment; the rest are absent. */
export function courierProviders(): CourierProvider[] {
  providers ??= ENV.flatMap(({ prefix, schema }) => {
    const parsed = schema.safeParse(process.env);
    if (parsed.success) return [parsed.data];
    if (Object.keys(process.env).some((k) => k.startsWith(prefix) && process.env[k])) {
      const missing = parsed.error.issues.map((i) => i.path.join(".")).join(", ");
      console.warn(`Courier provider ignored, check ${missing}`);
    }
    return [];
  });
  return providers;
}

export function courierProvider(id: CourierProviderId): CourierProvider | undefined {
  return courierProviders().find((p) => p.id === id);
}

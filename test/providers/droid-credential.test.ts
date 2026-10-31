import { createCipheriv, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Synthetic. No real Factory credential, key, or account data appears here.
const REFRESH_TOKEN = "SENTINEL-DROID-REFRESH-TOKEN-never-read";
const EMAIL = "sentinel-droid-user@example.invalid";
const FUTURE = Math.floor(Date.now() / 1000) + 3600;
const PAST = Math.floor(Date.now() / 1000) - 3600;
const OPTIONS = { allowKeychainPrompt: false, refreshCredentials: false };
const PROMPT_OPTIONS = { allowKeychainPrompt: true, refreshCredentials: false };

const originalEnv = { XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
let directory: string;
let factoryDir: string;
let platformDescriptor: PropertyDescriptor | undefined;

beforeEach(() => {
  vi.resetModules();
  directory = mkdtempSync(join(tmpdir(), "quota-axi-droid-credential-"));
  factoryDir = join(directory, ".factory");
  mkdirSync(factoryDir, { recursive: true });
  process.env.XDG_CACHE_HOME = join(directory, "cache");
  platformDescriptor = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  vi.doUnmock("../../src/lib/process.js");
  vi.resetModules();
  if (platformDescriptor)
    Object.defineProperty(process, "platform", platformDescriptor);
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(directory, { recursive: true, force: true });
});

function jwt(claims: Record<string, unknown>): string {
  const part = (value: unknown) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${part({ alg: "none" })}.${part(claims)}.synthetic-signature`;
}

/** Encrypts a bundle the way the Droid CLI does: `iv:tag:ciphertext`, base64. */
function encrypt(bundle: unknown, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([
    cipher.update(JSON.stringify(bundle), "utf8"),
    cipher.final(),
  ]);
  return [iv, cipher.getAuthTag(), body]
    .map((part) => part.toString("base64"))
    .join(":");
}

function bundleWith(
  token: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    access_token: token,
    refresh_token: REFRESH_TOKEN,
    active_organization_id: "org-1",
    whoami: { email: EMAIL },
    ...extra,
  };
}

function writeStore(name: string, content: string): void {
  writeFileSync(join(factoryDir, name), content, { mode: 0o600 });
}

const env = () => ({ FACTORY_HOME_OVERRIDE: directory });

async function credentialModule() {
  return import("../../src/providers/droid-credential.js");
}

function mockSecurity(options: { key?: Buffer; missing?: boolean }): {
  calls: string[][];
} {
  const calls: string[][] = [];
  vi.doMock("../../src/lib/process.js", () => ({
    execFileText: vi.fn(async (command: string, args: string[]) => {
      calls.push(args);
      if (command !== "security") throw new Error(`unexpected ${command}`);
      if (options.missing || !options.key)
        throw Object.assign(new Error("not found"), { code: 44 });
      if (!args.includes("-w")) return "keychain item metadata\n";
      return `${options.key.toString("base64")}\n`;
    }),
  }));
  return { calls };
}

describe("Droid key-file credential source", () => {
  it("decrypts the stored bundle and keeps only the access token, refreshability, and a non-secret identity", async () => {
    const key = randomBytes(32);
    const token = jwt({ sub: "user-1", org_id: "org-1", exp: FUTURE });
    writeStore("auth.v2.key", key.toString("base64"));
    writeStore("auth.v2.file", encrypt(bundleWith(token), key));
    const { createDroidKeyfileSource } = await credentialModule();

    const resolution = await createDroidKeyfileSource(env()).resolve(OPTIONS);

    expect(resolution).toEqual({
      status: "resolved",
      credential: token,
      kind: "session",
      identity: "user-1\0org-1",
      expired: false,
      refreshable: true,
    });
    const serialized = JSON.stringify(resolution);
    expect(serialized).not.toContain(REFRESH_TOKEN);
    expect(serialized).not.toContain(EMAIL);
  });

  it("marks a token past its exp as expired and still refreshable, never exchanging the refresh token", async () => {
    const key = randomBytes(32);
    const token = jwt({ sub: "user-1", org_id: "org-1", exp: PAST });
    writeStore("auth.v2.key", key.toString("base64"));
    writeStore("auth.v2.file", encrypt(bundleWith(token), key));
    const { createDroidKeyfileSource } = await credentialModule();

    const resolution = await createDroidKeyfileSource(env()).resolve(OPTIONS);

    expect(resolution).toMatchObject({
      status: "resolved",
      expired: true,
      refreshable: true,
    });
  });

  it("gives a token that names no user no cache identity", async () => {
    const key = randomBytes(32);
    writeStore("auth.v2.key", key.toString("base64"));
    writeStore("auth.v2.file", encrypt(bundleWith("opaque-token"), key));
    const { createDroidKeyfileSource } = await credentialModule();

    const resolution = await createDroidKeyfileSource(env()).resolve(OPTIONS);

    expect(resolution).toMatchObject({ status: "resolved", identity: "" });
  });

  it("is absent when no store exists and when a store has no key beside it", async () => {
    const { createDroidKeyfileSource } = await credentialModule();
    expect(await createDroidKeyfileSource(env()).resolve(OPTIONS)).toEqual({
      status: "absent",
    });
    writeStore("auth.v2.file", "aaaa:bbbb:cccc");
    expect(await createDroidKeyfileSource(env()).resolve(OPTIONS)).toEqual({
      status: "absent",
    });
  });

  it("reports a store the key cannot decrypt as structurally invalid, without echoing it", async () => {
    const token = jwt({ sub: "user-1", org_id: "org-1", exp: FUTURE });
    writeStore("auth.v2.key", randomBytes(32).toString("base64"));
    writeStore("auth.v2.file", encrypt(bundleWith(token), randomBytes(32)));
    const { createDroidKeyfileSource } = await credentialModule();

    const resolution = await createDroidKeyfileSource(env()).resolve(OPTIONS);

    expect(resolution).toEqual({
      status: "structurally_invalid",
      error: "droid_auth_undecryptable",
    });
  });

  it("rejects a key that is not 32 bytes", async () => {
    writeStore("auth.v2.key", Buffer.from("short").toString("base64"));
    writeStore("auth.v2.file", "aaaa:bbbb:cccc");
    const { createDroidKeyfileSource } = await credentialModule();
    expect(await createDroidKeyfileSource(env()).resolve(OPTIONS)).toEqual({
      status: "structurally_invalid",
      error: "droid_key_invalid",
    });
  });
});

describe("Droid Keychain credential source", () => {
  const token = jwt({ sub: "user-1", org_id: "org-1", exp: FUTURE });

  async function keychain() {
    const key = randomBytes(32);
    writeStore("auth.v2.loginkeychain", encrypt(bundleWith(token), key));
    const security = mockSecurity({ key });
    const { createDroidKeychainSource } = await credentialModule();
    return { source: createDroidKeychainSource(env()), security };
  }

  it("is absent off macOS without probing the Keychain", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const { source, security } = await keychain();
    expect(await source.resolve(PROMPT_OPTIONS)).toEqual({ status: "absent" });
    expect(security.calls).toEqual([]);
  });

  it("is absent when no login-Keychain store file exists", async () => {
    const security = mockSecurity({ key: randomBytes(32) });
    const { createDroidKeychainSource } = await credentialModule();
    expect(
      await createDroidKeychainSource(env()).resolve(PROMPT_OPTIONS),
    ).toEqual({ status: "absent" });
    expect(security.calls).toEqual([]);
  });

  it("skips a present Keychain key without a prompt grant and never reads the secret", async () => {
    const { source, security } = await keychain();
    expect(await source.resolve(OPTIONS)).toEqual({
      status: "skipped",
      error: "keychain_prompt_required",
    });
    expect(security.calls.some((args) => args.includes("-w"))).toBe(false);
  });

  it("stays presence-only for auth even when a prompt is allowed", async () => {
    const { source, security } = await keychain();
    expect(await source.resolve(PROMPT_OPTIONS, true)).toMatchObject({
      status: "skipped",
      error: "keychain_prompt_required",
    });
    expect(security.calls.some((args) => args.includes("-w"))).toBe(false);
  });

  it("reads the key once granted, decrypts the bundle, and records the grant", async () => {
    const { source, security } = await keychain();

    const first = await source.resolve(PROMPT_OPTIONS);
    expect(first).toMatchObject({
      status: "resolved",
      credential: token,
      kind: "session",
      identity: "user-1\0org-1",
    });
    expect(security.calls.some((args) => args.includes("-w"))).toBe(true);
    expect(
      existsSync(join(directory, "cache", "quota-axi")) ||
        existsSync(join(directory, "cache")),
    ).toBe(true);

    // The recorded grant lets a later run read without the flag.
    const second = await source.resolve(OPTIONS);
    expect(second).toMatchObject({ status: "resolved", credential: token });
  });

  it("reports a missing Keychain item as absent", async () => {
    writeStore(
      "auth.v2.loginkeychain",
      encrypt(bundleWith(token), randomBytes(32)),
    );
    mockSecurity({ missing: true });
    const { createDroidKeychainSource } = await credentialModule();
    expect(
      await createDroidKeychainSource(env()).resolve(PROMPT_OPTIONS),
    ).toEqual({ status: "absent" });
  });
});

describe("Droid API-key credential source", () => {
  it("selects the exported key with its own non-reversible identity kind", async () => {
    const { createDroidApiKeySource } = await credentialModule();
    expect(
      await createDroidApiKeySource({
        FACTORY_API_KEY: " fk-synthetic-1 ",
      }).resolve(OPTIONS),
    ).toMatchObject({
      status: "resolved",
      credential: "fk-synthetic-1",
      kind: "api_key",
      refreshable: false,
      expired: false,
    });
  });

  it("treats a blank variable as absent", async () => {
    const { createDroidApiKeySource } = await credentialModule();
    expect(
      await createDroidApiKeySource({ FACTORY_API_KEY: "   " }).resolve(
        OPTIONS,
      ),
    ).toEqual({ status: "absent" });
    expect(await createDroidApiKeySource({}).resolve(OPTIONS)).toEqual({
      status: "absent",
    });
  });
});

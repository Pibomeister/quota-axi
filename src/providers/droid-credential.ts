import { createDecipheriv } from "node:crypto";
import { chmodSync, existsSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  collapseHome,
  droidKeychainAccessMarkerPath,
  ensurePrivateParent,
  readBoundedFile,
} from "../lib/fs.js";
import { traceInput } from "../lib/input-trace.js";
import { execFileText } from "../lib/process.js";
import { usableLiteralSecret } from "../lib/secret.js";
import type { ProviderOptions } from "../types.js";

/**
 * Factory's Droid CLI stores one sign-in bundle, AES-256-GCM encrypted as
 * `base64(iv):base64(tag):base64(ciphertext)`, in `~/.factory`. The 32-byte key
 * is either a macOS login Keychain item (`auth.v2.loginkeychain`, service
 * `Factory CLI`, account `auth-encryption-key-security-cli`) or a sibling
 * `auth.v2.key` file beside `auth.v2.file`. The decrypted bundle is JSON with a
 * WorkOS `access_token`, a `refresh_token`, and account fields.
 *
 * quota-axi reads `access_token` and `active_organization_id` only: a JSON
 * reviver drops every other key (the `whoami` profile carries an email) while
 * the bundle is parsed. `refresh_token` survives as `true`; its presence alone
 * decides soft expiry versus sign-out, and its value is never held, exchanged,
 * logged, or cached. The access token is sent to Factory's own usage endpoint
 * and nowhere else.
 */
export const DROID_KEYCHAIN_SOURCE = "cli-keychain";
export const DROID_KEYFILE_SOURCE = "cli-keyfile";
export const DROID_API_KEY_SOURCE = "env:FACTORY_API_KEY";
export const DROID_KEYCHAIN_SERVICE = "Factory CLI";
export const DROID_KEYCHAIN_ACCOUNT = "auth-encryption-key-security-cli";

const KEYCHAIN_PROMPT_TIMEOUT_MS = 60_000;
const KEYCHAIN_PRESENCE_TIMEOUT_MS = 5_000;
const KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE = 44;
const STORE_LIMIT_BYTES = 64 * 1024;
const KEY_BYTES = 32;
const IV_BYTES = 16;
const TAG_BYTES = 16;

const BUNDLE_KEYS = new Set([
  "access_token",
  "refresh_token",
  "active_organization_id",
]);

export type DroidLocalResolution =
  | {
      status: "resolved";
      credential: string;
      /** `session` is a stored WorkOS token; `api_key` is `FACTORY_API_KEY`. */
      kind: "session" | "api_key";
      /** Non-secret account discriminator; hashed before any use. */
      identity: string;
      /** Advisory only: the stored token's own `exp` has passed. */
      expired: boolean;
      refreshable: boolean;
    }
  | { status: "absent" }
  | { status: "structurally_invalid"; error: string }
  | { status: "read_error"; error: string }
  | { status: "skipped"; error: string };

export type DroidCredentialSource = {
  name: string;
  /** Display location for `auth`; never a credential value. */
  location(): string;
  resolve(
    options: Pick<ProviderOptions, "allowKeychainPrompt">,
    presenceOnly?: boolean,
  ): Promise<DroidLocalResolution>;
};

type Environment = Readonly<Record<string, string | undefined>>;

export function droidConfigDir(environment: Environment = process.env): string {
  const base =
    environment.FACTORY_HOME_OVERRIDE ||
    environment.HOME ||
    environment.USERPROFILE ||
    homedir();
  return join(base, ".factory");
}

export function isDroidKeychainSourceSupported(): boolean {
  return process.platform === "darwin";
}

/**
 * The CLI's login-Keychain store. Presence is free; the key read is gated by
 * `--allow-keychain-prompt` or the recorded grant marker, like the Claude,
 * Cursor, and Muse Keychain sources.
 */
export function createDroidKeychainSource(
  environment: Environment = process.env,
  readKey: typeof readKeychainKey = readKeychainKey,
): DroidCredentialSource {
  const path = () => join(droidConfigDir(environment), "auth.v2.loginkeychain");
  return {
    name: DROID_KEYCHAIN_SOURCE,
    location: () => collapseHome(path()),
    async resolve(options, presenceOnly) {
      if (!isDroidKeychainSourceSupported()) return { status: "absent" };
      const file = await readStore(path());
      if (file.status !== "ok") return file.resolution;
      const presence = await keychainItemPresence();
      if (presence === "missing") return { status: "absent" };
      if (presenceOnly || !(options.allowKeychainPrompt || hasAccessMarker())) {
        return {
          status: "skipped",
          error:
            presence === "present"
              ? "keychain_prompt_required"
              : "keychain_presence_check_failed",
        };
      }
      const key = await readKey();
      if (key.status !== "ok") return key.resolution;
      writeAccessMarkerBestEffort();
      return resolveBundle(file.text, key.key);
    },
  };
}

/** The CLI's key-file fallback: `auth.v2.file` decrypted by `auth.v2.key`. */
export function createDroidKeyfileSource(
  environment: Environment = process.env,
): DroidCredentialSource {
  const file = () => join(droidConfigDir(environment), "auth.v2.file");
  const keyFile = () => join(droidConfigDir(environment), "auth.v2.key");
  return {
    name: DROID_KEYFILE_SOURCE,
    location: () => collapseHome(file()),
    async resolve() {
      const store = await readStore(file());
      if (store.status !== "ok") return store.resolution;
      const keyText = await readStore(keyFile());
      if (keyText.status !== "ok") {
        // A store with no key beside it cannot be decrypted by anyone; the
        // CLI treats that as no credential here, not as a broken one.
        return keyText.resolution.status === "absent"
          ? { status: "absent" }
          : keyText.resolution;
      }
      const key = parseKey(keyText.text);
      if (!key)
        return { status: "structurally_invalid", error: "droid_key_invalid" };
      return resolveBundle(store.text, key);
    },
  };
}

/** The explicitly exported `FACTORY_API_KEY`, read on the same footing. */
export function createDroidApiKeySource(
  environment: Environment = process.env,
): DroidCredentialSource {
  return {
    name: DROID_API_KEY_SOURCE,
    location: () => "FACTORY_API_KEY",
    resolve() {
      const raw = environment.FACTORY_API_KEY;
      // A blank variable selects nothing rather than reporting a broken key.
      if (raw === undefined || raw.trim().length === 0)
        return Promise.resolve({ status: "absent" });
      const credential = usableLiteralSecret(raw.trim());
      return Promise.resolve(
        credential === undefined
          ? { status: "structurally_invalid", error: "factory_api_key_invalid" }
          : {
              status: "resolved",
              credential,
              kind: "api_key",
              identity: credential,
              expired: false,
              refreshable: false,
            },
      );
    },
  };
}

type StoreRead =
  | { status: "ok"; text: string }
  | { status: "failed"; resolution: DroidLocalResolution };

async function readStore(path: string): Promise<StoreRead> {
  let bytes: Buffer;
  try {
    bytes = await readBoundedFile(path, STORE_LIMIT_BYTES);
  } catch (error) {
    return {
      status: "failed",
      resolution:
        errorCode(error) === "ENOENT"
          ? { status: "absent" }
          : { status: "read_error", error: "droid_auth_read_error" },
    };
  }
  if (bytes.byteLength > STORE_LIMIT_BYTES)
    return {
      status: "failed",
      resolution: {
        status: "structurally_invalid",
        error: "droid_auth_too_large",
      },
    };
  return { status: "ok", text: bytes.toString("utf8").trim() };
}

function parseKey(text: string): Uint8Array | undefined {
  const key = Buffer.from(text.trim(), "base64");
  return key.length === KEY_BYTES ? new Uint8Array(key) : undefined;
}

/** Decrypts `iv:tag:ciphertext` (each base64) and returns the JSON text. */
function decrypt(text: string, key: Uint8Array): string | undefined {
  const parts = text.split(":");
  if (parts.length !== 3) return undefined;
  const [iv, tag, ciphertext] = parts.map(
    (part) => new Uint8Array(Buffer.from(part, "base64")),
  ) as [Uint8Array, Uint8Array, Uint8Array];
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) return undefined;
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      new Uint8Array(decipher.update(ciphertext)),
      new Uint8Array(decipher.final()),
    ]).toString("utf8");
  } catch {
    return undefined;
  }
}

function resolveBundle(text: string, key: Uint8Array): DroidLocalResolution {
  const json = decrypt(text, key);
  if (json === undefined)
    return {
      status: "structurally_invalid",
      error: "droid_auth_undecryptable",
    };
  let bundle: unknown;
  try {
    bundle = JSON.parse(json, (name, value: unknown) => {
      if (name === "" || BUNDLE_KEYS.has(name))
        return name === "refresh_token" ? true : value;
      return undefined;
    });
  } catch {
    return { status: "structurally_invalid", error: "droid_auth_invalid" };
  }
  const record =
    bundle !== null && typeof bundle === "object" && !Array.isArray(bundle)
      ? (bundle as Record<string, unknown>)
      : undefined;
  const credential = usableLiteralSecret(record?.access_token);
  if (record === undefined || credential === undefined)
    return { status: "structurally_invalid", error: "droid_auth_invalid" };
  const claims = tokenClaims(credential);
  const subject = typeof claims?.sub === "string" ? claims.sub : undefined;
  const organization =
    typeof record.active_organization_id === "string"
      ? record.active_organization_id
      : typeof claims?.org_id === "string"
        ? claims.org_id
        : "";
  // A session token that names no user cannot be told apart from another
  // account's, so it earns no cache identity: the empty string is rejected
  // upstream and the reading is neither cached nor served stale.
  const identity = subject ? `${subject}\0${organization}` : "";
  const exp = typeof claims?.exp === "number" ? claims.exp : undefined;
  return {
    status: "resolved",
    credential,
    kind: "session",
    identity,
    expired: exp !== undefined && exp * 1000 <= Date.now(),
    refreshable: Object.hasOwn(record, "refresh_token"),
  };
}

/** Public JWT claims only (`sub`, `org_id`, `exp`); the signature is not checked. */
function tokenClaims(token: string): Record<string, unknown> | undefined {
  const payload = token.split(".")[1];
  if (!payload) return undefined;
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(payload, "base64url").toString("utf8"),
    );
    return parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

type KeychainItemPresence = "present" | "missing" | "unknown";

async function keychainItemPresence(): Promise<KeychainItemPresence> {
  try {
    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        DROID_KEYCHAIN_ACCOUNT,
        "-s",
        DROID_KEYCHAIN_SERVICE,
      ],
      KEYCHAIN_PRESENCE_TIMEOUT_MS,
    );
    return "present";
  } catch (error) {
    return isKeychainItemNotFound(error) ? "missing" : "unknown";
  }
}

type KeyRead =
  | { status: "ok"; key: Uint8Array }
  | { status: "failed"; resolution: DroidLocalResolution };

export async function readKeychainKey(): Promise<KeyRead> {
  let secret: string;
  try {
    secret = await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        DROID_KEYCHAIN_ACCOUNT,
        "-w",
        "-s",
        DROID_KEYCHAIN_SERVICE,
      ],
      KEYCHAIN_PROMPT_TIMEOUT_MS,
    );
  } catch (error) {
    if (isKeychainItemNotFound(error))
      return { status: "failed", resolution: { status: "absent" } };
    const failure = error as { killed?: boolean; signal?: string | null };
    return {
      status: "failed",
      resolution: {
        status: "skipped",
        error:
          failure.killed || failure.signal
            ? "keychain_prompt_timeout"
            : "keychain_access_denied",
      },
    };
  }
  const key = parseKey(secret);
  return key
    ? { status: "ok", key }
    : {
        status: "failed",
        resolution: {
          status: "structurally_invalid",
          error: "droid_keychain_invalid",
        },
      };
}

function hasAccessMarker(): boolean {
  const marker = droidKeychainAccessMarkerPath(
    DROID_KEYCHAIN_SERVICE,
    DROID_KEYCHAIN_ACCOUNT,
  );
  traceInput(marker);
  return existsSync(marker);
}

function writeAccessMarkerBestEffort(): void {
  try {
    const file = droidKeychainAccessMarkerPath(
      DROID_KEYCHAIN_SERVICE,
      DROID_KEYCHAIN_ACCOUNT,
    );
    if (existsSync(file)) return;
    ensurePrivateParent(file);
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, "granted\n", { mode: 0o600 });
    chmodSync(temp, 0o600);
    renameSync(temp, file);
    chmodSync(file, 0o600);
  } catch {
    return;
  }
}

function isKeychainItemNotFound(error: unknown): boolean {
  return (
    (error as { code?: number | string | null }).code ===
    KEYCHAIN_ITEM_NOT_FOUND_EXIT_CODE
  );
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : undefined;
}

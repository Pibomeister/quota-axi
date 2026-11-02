import { createHash } from "node:crypto";

/**
 * The cache identity the Factory Droid reading this process produced belongs
 * to, or `undefined` when nothing has claimed one yet.
 *
 * A Droid reading belongs to one Factory user inside one organization, and the
 * credential that answered is the only local thing naming them. The cache
 * writer reads this stamp rather than deriving an identity for itself, so a
 * snapshot is reused only for the account that produced it.
 */
let readingContextId: string | undefined;

/** Claims the identity a snapshot written from here on belongs to. */
export function publishDroidReadingContextId(contextId: string): void {
  readingContextId = contextId;
}

/** Drop any previously published identity so a later reading cannot inherit it. */
export function clearDroidReadingContextId(): void {
  readingContextId = undefined;
}

export function droidReadingContextId(): string | undefined {
  return readingContextId;
}

/**
 * Opaque SHA-256 of an account identity the credential itself carries: the
 * `sub` and `org_id` claims of a stored session token, which stay the same
 * across the short-lived token's rotation. The claims do not enter the cache,
 * are not rendered, and are not logged: only this digest is, and it cannot be
 * reversed.
 *
 * A token the Droid CLI has since rotated therefore still reaches its own
 * stale snapshot, while a different user or organization is a cache miss and
 * never a cross-attribution.
 */
export function droidCacheContextId(identity: string): string {
  const identityDigest = createHash("sha256")
    .update(`droid-identity-v1\0${identity}`)
    .digest("hex");
  return createHash("sha256").update(`droid\0${identityDigest}`).digest("hex");
}

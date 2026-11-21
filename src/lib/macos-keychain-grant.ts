/**
 * "Always Allow" updates a Keychain item's ACL and does not add `apple-tool:`
 * to its partition list. The next `/usr/bin/security` value read is rejected
 * by that partition check and prompts again. After a successful value read,
 * add `apple-tool:` beside the partitions already there. Never drop one, and
 * never pass the keychain password (`-k`) or the secret.
 */

const ACL_TIMEOUT_MS = 5_000;
const PARTITION_TIMEOUT_MS = 60_000;
const APPLE_TOOL_PARTITION = "apple-tool:";
const PARTITION_TOKEN =
  /^(?:apple-tool:|apple:|teamid:[A-Z0-9]{10}|cdhash:[0-9a-fA-F]{40})$/;
const PARTITION_TOKEN_IN_TEXT =
  /apple-tool:|apple:|teamid:[A-Z0-9]{10}|cdhash:[0-9a-fA-F]{40}/g;

type SecurityRun = (
  args: readonly string[],
  timeoutMs: number,
) => Promise<string>;

type PasswordSelector = {
  service: string;
  account: string;
  keychainPath?: string;
};

const attempts = new Map<string, Promise<void>>();

/** Drops in-process repair memory. Tests use this so cases do not share a grant. */
export function resetAppleToolGrantAttempts(): void {
  attempts.clear();
}

export async function finishSecurityValueRead(
  platform: NodeJS.Platform,
  command: string,
  args: readonly string[],
  run: SecurityRun,
): Promise<void> {
  if (platform !== "darwin" || !isSecurityCommand(command)) return;
  const selector = genericPasswordValueSelector(args);
  if (!selector) return;
  const key = JSON.stringify([
    selector.service,
    selector.account,
    selector.keychainPath ?? "",
  ]);
  const existing = attempts.get(key);
  if (existing) {
    await existing;
    return;
  }

  let resolveAttempt = (): void => undefined;
  let rejectAttempt = (_error: unknown): void => undefined;
  const attempt = new Promise<void>((resolve, reject) => {
    resolveAttempt = resolve;
    rejectAttempt = reject;
  });
  void attempt.catch(() => undefined);
  attempts.set(key, attempt);
  try {
    await rememberAppleToolGrant(selector, run);
    resolveAttempt();
  } catch (error) {
    if (attempts.get(key) === attempt) attempts.delete(key);
    rejectAttempt(error);
    throw error;
  }
}

async function rememberAppleToolGrant(
  selector: PasswordSelector,
  run: SecurityRun,
): Promise<void> {
  const dump = await readAclDump(selector, run);
  const found = findPartitionList(dump, selector);
  if (
    found.status !== "list" ||
    found.partitions.includes(APPLE_TOOL_PARTITION)
  )
    return;
  const next = [
    APPLE_TOOL_PARTITION,
    ...found.partitions.filter((token) => token !== APPLE_TOOL_PARTITION),
  ];
  const setArgs = [
    "set-generic-password-partition-list",
    "-a",
    selector.account,
    "-s",
    selector.service,
    "-S",
    next.join(","),
  ];
  const keychainPath = selector.keychainPath ?? found.keychainPath;
  if (keychainPath) setArgs.push(keychainPath);
  await run(setArgs, PARTITION_TIMEOUT_MS);
}

async function readAclDump(
  selector: PasswordSelector,
  run: SecurityRun,
): Promise<string> {
  if (selector.keychainPath)
    return run(["dump-keychain", "-a", selector.keychainPath], ACL_TIMEOUT_MS);
  const listed = await run(["list-keychains"], ACL_TIMEOUT_MS);
  const paths = listedKeychainPaths(listed);
  if (paths.length === 0) throw new Error("keychain list unavailable");
  return run(["dump-keychain", "-a", ...paths], ACL_TIMEOUT_MS);
}

function listedKeychainPaths(output: string): string[] {
  const paths: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const path = /^\s*"(\/[^"\n]+)"\s*$/.exec(line)?.[1];
    if (!path) return [];
    if (!paths.includes(path)) paths.push(path);
  }
  return paths;
}

type PartitionHit =
  | { status: "skip" }
  | { status: "list"; partitions: string[]; keychainPath?: string };

function findPartitionList(
  dump: string,
  selector: PasswordSelector,
): PartitionHit {
  const hits: PartitionHit[] = [];
  for (const record of dump.split(/(?=^keychain: )/m)) {
    if (!record.trim()) continue;
    if (attribute(record, "svce") !== selector.service) continue;
    if (attribute(record, "acct") !== selector.account) continue;
    const keychainPath = recordKeychainPath(record);
    if (selector.keychainPath && keychainPath !== selector.keychainPath)
      continue;
    const partitions = partitionsFromRecord(record);
    if (!partitions) {
      hits.push({ status: "skip" });
      continue;
    }
    hits.push({ status: "list", partitions, keychainPath });
  }
  if (hits.length !== 1 || hits[0]?.status !== "list")
    return { status: "skip" };
  return hits[0];
}

function partitionsFromRecord(record: string): string[] | undefined {
  const entries = record.split(/\n[ \t]*entry \d+:[ \t]*\n/).slice(1);
  const descriptions: string[] = [];
  for (const entry of entries) {
    if (!authorizesPartition(entry)) continue;
    const description = /^[ \t]*description:[ \t]*(.*)$/m
      .exec(entry)?.[1]
      ?.trim();
    if (!description) return undefined;
    descriptions.push(description);
  }
  if (descriptions.length === 0) return undefined;
  const tokens: string[] = [];
  for (const description of descriptions) {
    const parsed = parsePartitionDescription(description);
    if (!parsed) return undefined;
    tokens.push(...parsed);
  }
  return unique(tokens);
}

function authorizesPartition(entry: string): boolean {
  const line = /^[ \t]*authorizations \([^)]*\):[ \t]*(.+)$/m.exec(entry)?.[1];
  if (!line) return false;
  return line.split(",").some((part) => part.trim() === "partition_id");
}

function parsePartitionDescription(description: string): string[] | undefined {
  const text = description.replace(/^"(.*)"$/, "$1").trim();
  const direct = text.split(",").map((token) => token.trim());
  if (direct.length > 0 && direct.every((token) => PARTITION_TOKEN.test(token)))
    return unique(direct);
  if (/^(?:[0-9a-fA-F]{2})+$/.test(text)) {
    const found = Buffer.from(text, "hex")
      .toString("latin1")
      .match(PARTITION_TOKEN_IN_TEXT);
    if (found && found.length > 0) return unique(found);
  }
  return undefined;
}

function unique(tokens: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function attribute(record: string, name: string): string | undefined {
  const raw = new RegExp(`^[ \\t]*"${name}"<blob>=(.+)$`, "m").exec(
    record,
  )?.[1];
  return metadataValue(raw);
}

function metadataValue(raw: string | undefined): string | undefined {
  if (!raw || raw.length > 8192) return undefined;
  if (raw === "<NULL>" || raw === "<null>") return "";
  const hex = /^0x((?:[0-9a-fA-F]{2})+)(?:\s|$)/.exec(raw)?.[1];
  if (hex) return Buffer.from(hex, "hex").toString("utf8");
  return /^"(.*)"$/.exec(raw)?.[1];
}

function recordKeychainPath(record: string): string | undefined {
  const match = /^keychain:\s*(?:"(\/[^"\n]+)"|(\/\S+))/m.exec(record);
  return match?.[1] ?? match?.[2];
}

function genericPasswordValueSelector(
  args: readonly string[],
): PasswordSelector | undefined {
  if (args[0] !== "find-generic-password") return undefined;
  let service: string | undefined;
  let account: string | undefined;
  let valueRead = false;
  let keychainPath: string | undefined;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === undefined) return undefined;
    if (arg === "-w" || arg === "-g") {
      valueRead = true;
      continue;
    }
    if (arg === "-a" || arg === "-s") {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("-")) return undefined;
      index += 1;
      if (arg === "-a") account = value;
      else service = value;
      continue;
    }
    if (
      arg.startsWith("-") ||
      keychainPath !== undefined ||
      !arg.startsWith("/")
    )
      return undefined;
    keychainPath = arg;
  }
  if (!valueRead || !service || !account) return undefined;
  return {
    service,
    account,
    ...(keychainPath ? { keychainPath } : {}),
  };
}

function isSecurityCommand(command: string): boolean {
  return command === "security" || command.endsWith("/security");
}

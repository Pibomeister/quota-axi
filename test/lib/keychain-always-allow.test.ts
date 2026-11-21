import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetAppleToolGrantAttempts } from "../../src/lib/macos-keychain-grant.js";
import { execFileText } from "../../src/lib/process.js";

/**
 * Models the macOS defect: "Always Allow" returns the secret and records an
 * ACL entry, but the partition list stays without `apple-tool:`, so the next
 * `security` value read prompts again. The fake never touches a real keychain.
 */
const { execFile } = vi.hoisted(() => ({ execFile: vi.fn() }));

vi.mock("node:child_process", () => ({ execFile }));

const platform = Object.getOwnPropertyDescriptor(process, "platform");
const keychain = "/fixture/Library/Keychains/login.keychain-db";

type World = {
  partitions: string[];
  prompts: number;
  commands: string[];
  setCalls: string[][];
  sawSecretArgument: boolean;
  failSets: number;
  description: "list" | "hex" | "garbage" | "none";
  extraRecord: boolean;
};

function createWorld(overrides: Partial<World> = {}): World {
  return {
    partitions: ["teamid:NKUJUXUJ3B"],
    prompts: 0,
    commands: [],
    setCalls: [],
    sawSecretArgument: false,
    failSets: 0,
    description: "list",
    extraRecord: false,
    ...overrides,
  };
}

function descriptionText(world: World): string | undefined {
  if (world.description === "none") return undefined;
  if (world.description === "garbage") return "not-a-partition";
  const list = world.partitions.join(",");
  if (world.description === "hex" && !world.partitions.includes("apple-tool:"))
    return Buffer.from(`\0${list}\0`, "latin1").toString("hex");
  return list;
}

function record(
  service: string,
  account: string,
  path: string,
  description: string | undefined,
): string {
  const partition =
    description === undefined
      ? ""
      : `    entry 2:
        authorizations (1): partition_id
        don't-require-password
        description: ${description}
        applications: <null>
`;
  return `keychain: "${path}"
version: 512
class: "genp"
attributes:
    "acct"<blob>="${account}"
    "svce"<blob>="${service}"
access: 3 entries
    entry 0:
        authorizations (1): encrypt
        don't-require-password
        description: <key>
        applications: <null>
${partition}`;
}

function install(world: World, service: string, account: string): void {
  execFile.mockImplementation(
    (
      command: string,
      args: string[],
      _options: unknown,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      world.commands.push(command);
      if (args.some((arg) => arg.includes("secret-value")))
        world.sawSecretArgument = true;
      const finish = (error: Error | null, stdout = ""): void => {
        callback(error, stdout, "");
      };
      if (args[0] === "list-keychains") {
        finish(null, `    "${keychain}"\n`);
        return undefined;
      }
      if (args[0] === "dump-keychain") {
        if (!args.includes("-a") || args.includes("-d")) {
          finish(new Error("ACL dump must request access lists and no data"));
          return undefined;
        }
        const description = descriptionText(world);
        let dump = record(service, account, keychain, description);
        if (world.extraRecord) {
          dump += record(
            service,
            account,
            "/fixture/Library/Keychains/other.keychain-db",
            "teamid:Q6L2SF6YDW",
          );
        }
        finish(null, dump);
        return undefined;
      }
      if (args[0] === "set-generic-password-partition-list") {
        world.setCalls.push(args);
        if (args.includes("-k")) {
          finish(new Error("keychain password must not be passed"));
          return undefined;
        }
        if (world.failSets > 0) {
          world.failSets -= 1;
          finish(new Error("partition update dismissed"));
          return undefined;
        }
        const list = args[args.indexOf("-S") + 1];
        if (!list) {
          finish(new Error("missing partition list"));
          return undefined;
        }
        world.partitions = list.split(",");
        finish(null, "");
        return undefined;
      }
      if (args[0] === "find-generic-password" && args.includes("-w")) {
        if (!world.partitions.includes("apple-tool:")) world.prompts += 1;
        // Always Allow returns the secret and does not change the partition list.
        finish(null, "secret-value\n");
        return undefined;
      }
      if (args[0] === "find-generic-password") {
        finish(null, "metadata\n");
        return undefined;
      }
      finish(new Error(`unexpected security command ${args.join(" ")}`));
      return undefined;
    },
  );
}

const claudeRead = [
  "find-generic-password",
  "-a",
  "fixture-user",
  "-w",
  "-s",
  "Claude Code-credentials",
  keychain,
];

beforeEach(() => {
  execFile.mockReset();
  resetAppleToolGrantAttempts();
  Object.defineProperty(process, "platform", { value: "darwin" });
});

afterEach(() => {
  if (platform) Object.defineProperty(process, "platform", platform);
});

describe("macOS Keychain Always Allow", () => {
  it("does not prompt the next value read after Always Allow left apple-tool off the partition list", async () => {
    const world = createWorld();
    install(world, "Claude Code-credentials", "fixture-user");

    await expect(execFileText("security", claudeRead, 1000)).resolves.toBe(
      "secret-value\n",
    );
    await expect(execFileText("security", claudeRead, 1000)).resolves.toBe(
      "secret-value\n",
    );

    expect(world.prompts).toBe(1);
    expect(world.partitions).toEqual(["apple-tool:", "teamid:NKUJUXUJ3B"]);
    expect(world.setCalls).toHaveLength(1);
    expect(world.setCalls[0]).not.toContain("-k");
    expect(world.setCalls[0]).toContain(keychain);
    expect(
      world.commands.every((command) => command === "/usr/bin/security"),
    ).toBe(true);
    expect(world.sawSecretArgument).toBe(false);
  });

  it("repairs an unpinned item after reading the search-list ACLs", async () => {
    const world = createWorld();
    install(world, "cursor-access-token", "cursor-user");
    const args = [
      "find-generic-password",
      "-s",
      "cursor-access-token",
      "-a",
      "cursor-user",
      "-w",
    ];

    await execFileText("security", args, 1000);
    await execFileText("security", args, 1000);

    expect(world.prompts).toBe(1);
    expect(world.partitions).toEqual(["apple-tool:", "teamid:NKUJUXUJ3B"]);
    expect(
      execFile.mock.calls.some(([, args]) => args[0] === "list-keychains"),
    ).toBe(true);
  });

  it("reads a hex-encoded partition plist without dropping the vendor team id", async () => {
    const world = createWorld({ description: "hex" });
    install(world, "Factory CLI", "auth-encryption-key-security-cli");
    const args = [
      "find-generic-password",
      "-a",
      "auth-encryption-key-security-cli",
      "-w",
      "-s",
      "Factory CLI",
      keychain,
    ];

    await execFileText("/usr/bin/security", args, 1000);

    expect(world.partitions).toEqual(["apple-tool:", "teamid:NKUJUXUJ3B"]);
  });

  it("does not replace a partition list it cannot parse", async () => {
    const world = createWorld({ description: "garbage" });
    install(world, "copilot-cli", "https://github.com:octocat");
    const args = [
      "find-generic-password",
      "-s",
      "copilot-cli",
      "-a",
      "https://github.com:octocat",
      "-w",
    ];

    await expect(execFileText("security", args, 1000)).resolves.toBe(
      "secret-value\n",
    );

    expect(world.setCalls).toHaveLength(0);
    expect(world.partitions).toEqual(["teamid:NKUJUXUJ3B"]);
  });

  it("does not edit an item that has no partition list", async () => {
    const world = createWorld({ description: "none" });
    install(world, "ai.meta.dev.credentials", "meta");

    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        "meta",
        "-w",
        "-s",
        "ai.meta.dev.credentials",
      ],
      1000,
    );

    expect(world.setCalls).toHaveLength(0);
  });

  it("does not edit when two items share the service and account", async () => {
    const world = createWorld({ extraRecord: true });
    install(world, "Claude Code-credentials", "fixture-user");

    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-w",
        "-s",
        "Claude Code-credentials",
      ],
      1000,
    );

    expect(world.setCalls).toHaveLength(0);
    expect(world.partitions).toEqual(["teamid:NKUJUXUJ3B"]);
  });

  it("leaves a list that already grants apple-tool unchanged", async () => {
    const world = createWorld({
      partitions: ["apple-tool:", "teamid:NKUJUXUJ3B"],
    });
    install(world, "Claude Code-credentials", "fixture-user");

    await execFileText("security", claudeRead, 1000);
    await execFileText("security", claudeRead, 1000);

    expect(world.prompts).toBe(0);
    expect(world.setCalls).toHaveLength(0);
  });

  it("returns the secret when the partition update fails and retries later", async () => {
    const world = createWorld({ failSets: 1 });
    install(world, "Claude Code-credentials", "fixture-user");

    await expect(execFileText("security", claudeRead, 1000)).resolves.toBe(
      "secret-value\n",
    );
    expect(world.partitions).toEqual(["teamid:NKUJUXUJ3B"]);

    await execFileText("security", claudeRead, 1000);
    await execFileText("security", claudeRead, 1000);

    expect(world.prompts).toBe(2);
    expect(world.partitions).toEqual(["apple-tool:", "teamid:NKUJUXUJ3B"]);
  });

  it("does not treat a presence check as consent to change the partition list", async () => {
    const world = createWorld();
    install(world, "Claude Code-credentials", "fixture-user");

    await execFileText(
      "security",
      [
        "find-generic-password",
        "-a",
        "fixture-user",
        "-s",
        "Claude Code-credentials",
      ],
      1000,
    );

    expect(world.prompts).toBe(0);
    expect(world.setCalls).toHaveLength(0);
    expect(world.commands).toEqual(["/usr/bin/security"]);
  });

  it("does not rewrite or repair Keychain commands off macOS", async () => {
    Object.defineProperty(process, "platform", { value: "linux" });
    const world = createWorld();
    install(world, "Claude Code-credentials", "fixture-user");

    await execFileText("security", claudeRead, 1000);
    await execFileText("security", claudeRead, 1000);

    expect(world.commands).toEqual(["security", "security"]);
    expect(world.setCalls).toHaveLength(0);
    expect(world.prompts).toBe(2);
  });
});

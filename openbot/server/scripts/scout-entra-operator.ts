import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, isAbsolute, parse, resolve } from "node:path";
import { createDatabase } from "../src/db/client";
import {
  createEntraIdentityOperator,
  EntraOperatorError,
  parseEntraIdentityRequest,
} from "../src/scout/entra-operator";
import { createEntraIdentityStore } from "../src/scout/entra-operator-store";

type Arguments =
  | { mode: "preview"; request: string; plan: string }
  | { mode: "apply"; plan: string; approve: string };
export function parseEntraOperatorArguments(input: string[]): Arguments {
  const args = [...input];
  const mode = args[0]?.startsWith("--") ? "preview" : args.shift();
  if (mode !== "preview" && mode !== "apply")
    throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
  const values = new Map<string, string>();
  while (args.length) {
    const key = args.shift();
    const value = args.shift();
    if (
      !key ||
      !value ||
      values.has(key) ||
      value.length > 1000 ||
      ![
        "--plan",
        ...(mode === "preview" ? ["--request"] : ["--approve"]),
      ].includes(key)
    )
      throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
    values.set(key, value);
  }
  const plan = values.get("--plan");
  const request = values.get("--request");
  const approve = values.get("--approve");
  if (
    !plan ||
    !isAbsolute(plan) ||
    (mode === "preview" && (!request || !isAbsolute(request))) ||
    (mode === "apply" && (!approve || !/^[a-f0-9]{64}$/.test(approve)))
  )
    throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
  return mode === "preview"
    ? { mode, request: request as string, plan }
    : { mode, plan, approve: approve as string };
}

async function protectedParent(path: string) {
  // Native Windows DACL enforcement is absent. Fail closed rather than treating POSIX bits as it.
  if (process.platform !== "linux" || !isAbsolute(path))
    throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
  let current = dirname(resolve(path));
  for (;;) {
    const stat = await lstat(current);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.mode & 0o022) !== 0 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    )
      throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
    if (current === parse(current).root) return;
    current = dirname(current);
  }
}
async function readProtectedJson(path: string): Promise<unknown> {
  await protectedParent(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await file.stat();
    if (
      !stat.isFile() ||
      stat.size > 65_536 ||
      (stat.mode & 0o077) !== 0 ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.())
    )
      throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
    return await readBoundedEntraJson(file);
  } finally {
    await file.close();
  }
}
/** Enforce the read bound even if a protected file grows after its stat check. */
export async function readBoundedEntraJson(file: {
  read(
    buffer: Buffer,
    offset: number,
    length: number,
    position: null,
  ): Promise<{ bytesRead: number }>;
}): Promise<unknown> {
  const buffer = Buffer.alloc(65_537);
  let length = 0;
  while (length < buffer.length) {
    const { bytesRead } = await file.read(
      buffer,
      length,
      buffer.length - length,
      null,
    );
    if (bytesRead === 0) break;
    length += bytesRead;
  }
  if (length > 65_536) throw new EntraOperatorError("ENTRA_INPUT_REFUSED");
  return JSON.parse(buffer.subarray(0, length).toString("utf8"));
}
async function writeProtectedJson(path: string, value: unknown) {
  await protectedParent(path);
  const file = await open(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await file.sync();
  } finally {
    await file.close();
  }
}

/** No URL, key, password, contact or SQL error is ever written to stdout/stderr. */
export async function runEntraOperator(
  args: string[],
  environment: Record<string, string | undefined> = process.env,
) {
  const parsed = parseEntraOperatorArguments(args);
  if (
    environment.SCOUT_RUNTIME_MODE !== "owned" ||
    !environment.MICROSOFT_OAUTH_TENANT_ID ||
    !environment.DATABASE_URL ||
    environment.OPENBOT_ORGANIZATION_AUTH_URL
  )
    throw new EntraOperatorError("ENTRA_TARGET_REFUSED");
  const input = await readProtectedJson(
    parsed.mode === "preview" ? parsed.request : parsed.plan,
  );
  if (parsed.mode === "preview") parseEntraIdentityRequest(input);
  const database = createDatabase(environment.DATABASE_URL, { max: 1 });
  try {
    const operator = createEntraIdentityOperator(
      createEntraIdentityStore(database),
      { tenantId: environment.MICROSOFT_OAUTH_TENANT_ID },
    );
    if (parsed.mode === "preview") {
      const { plan, digest } = await operator.preview(input);
      await writeProtectedJson(parsed.plan, plan);
      return {
        mode: "preview",
        digest,
        expiresAt: plan.expiresAt,
        effect: plan.effect,
      };
    }
    return { mode: "apply", ...(await operator.apply(input, parsed.approve)) };
  } finally {
    await database.$client.end({ timeout: 5 });
  }
}
if (import.meta.main) {
  try {
    console.info(JSON.stringify(await runEntraOperator(process.argv.slice(2))));
  } catch (error) {
    console.error(
      JSON.stringify({
        code:
          error instanceof EntraOperatorError
            ? error.code
            : "ENTRA_OPERATOR_FAILED",
      }),
    );
    process.exitCode = 1;
  }
}

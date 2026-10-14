/* Minimal CLI helpers shared by pipeline scripts. */

export interface ParsedArgs {
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv = process.argv.slice(2)): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg?.startsWith('--')) continue;
    const [name, inline] = arg.slice(2).split('=', 2) as [string, string | undefined];
    if (inline !== undefined) flags[name] = inline;
    else if (argv[i + 1] && !argv[i + 1]!.startsWith('--')) flags[name] = argv[++i]!;
    else flags[name] = true;
  }
  return { flags };
}

export function requireString(args: ParsedArgs, name: string): string {
  const v = args.flags[name];
  if (typeof v !== 'string' || v.trim() === '') fail(`Укажите --${name} <значение>`);
  return v.trim();
}

export function hasFlag(args: ParsedArgs, name: string): boolean {
  return args.flags[name] === true || args.flags[name] === 'true';
}

export class CliError extends Error {}

export function fail(message: string): never {
  throw new CliError(message);
}

export const log = {
  info: (m: string) => console.log(`  ${m}`),
  ok: (m: string) => console.log(`✔ ${m}`),
  warn: (m: string) => console.warn(`⚠ ${m}`),
  err: (m: string) => console.error(`✖ ${m}`),
  step: (m: string) => console.log(`\n▸ ${m}`),
};

/** Runs a script body and maps failures to exit codes (0 ok, 1 check failed, 2 usage/env error). */
export async function run(main: () => Promise<number | void>): Promise<void> {
  try {
    const code = (await main()) ?? 0;
    process.exitCode = code;
  } catch (err) {
    if (err instanceof CliError) {
      log.err(err.message);
      process.exitCode = 2;
    } else {
      log.err(err instanceof Error ? err.stack ?? err.message : String(err));
      process.exitCode = 1;
    }
  }
}

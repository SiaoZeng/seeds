// `sd setup` — provider integration scaffolding.
//
// Step 1 (seeds-2774) shipped the command shell — argument + flag plumbing, the
// recipe registry shape, and `--list` / `--check` / `--remove` / `--json`
// dispatch. seeds-89d2 added the `pi` recipe alongside the pi-aware onboarding
// marker variant.
//
// Mirrors mulch's `ml setup` shape so the two extensions feel like siblings.

import { existsSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import chalk from "chalk";
import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { outputJson, printSuccess } from "../output.ts";
import { PI_PACKAGE_NAME, runOnboard } from "./onboard.ts";

export interface RecipeResult {
	success: boolean;
	message: string;
}

export interface ProviderRecipe {
	install(cwd: string): Promise<RecipeResult>;
	check(cwd: string): Promise<RecipeResult>;
	remove(cwd: string): Promise<RecipeResult>;
}

// ── Pi (pi-coding-agent) ────────────────────────────────────
//
// `sd setup pi` wires the in-tree `@os-eco/pi-seeds` extension
// (extensions/pi/index.ts) into a project's pi-coding-agent runtime by:
//   1. Adding `@os-eco/seeds-cli` to `.pi/settings.json` → packages so pi
//      auto-loads the extension on every session (no global install needed).
//   2. Refreshing the CLAUDE.md / AGENTS.md seeds section to the short
//      pi-aware variant — the extension handles prime / status / tools /
//      autocomplete / commands on lifecycle events, so the prose only needs
//      to point at the manual CLI escape hatches.
// Both legs are idempotent and reversible (`--remove`). Marker suffix `:pi`
// on the schema marker doubles as install-state detection: a re-run of
// `sd onboard` after `sd setup pi` keeps the pi variant because
// isPiInstalled() reads `.pi/settings.json`.

function piSettingsPath(cwd: string): string {
	return join(cwd, ".pi", "settings.json");
}

interface PiSettings {
	packages?: unknown[];
	[key: string]: unknown;
}

function packageEntryMatches(entry: unknown): boolean {
	if (entry === PI_PACKAGE_NAME) return true;
	if (typeof entry === "object" && entry !== null) {
		const source = (entry as { source?: unknown }).source;
		return source === PI_PACKAGE_NAME;
	}
	return false;
}

async function readPiSettings(path: string): Promise<PiSettings> {
	if (!existsSync(path)) return {};
	const raw = await readFile(path, "utf-8");
	const trimmed = raw.trim();
	if (trimmed.length === 0) return {};
	return JSON.parse(raw) as PiSettings;
}

const piRecipe: ProviderRecipe = {
	async install(cwd) {
		const settingsPath = piSettingsPath(cwd);
		const settings = await readPiSettings(settingsPath);
		const packages = Array.isArray(settings.packages) ? [...settings.packages] : [];
		const alreadyHasPackage = packages.some(packageEntryMatches);

		if (!alreadyHasPackage) {
			packages.push(PI_PACKAGE_NAME);
			settings.packages = packages;
			await mkdir(dirname(settingsPath), { recursive: true });
			await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
		}

		// Refresh the CLAUDE.md / AGENTS.md snippet to the pi-aware variant.
		// Variant is forced rather than auto-detected via isPiInstalled() so the
		// refresh isn't a no-op on first install when the settings file isn't
		// yet visible to a concurrent stat() race.
		await runOnboard({ cwd, variant: "pi", silent: true });

		if (alreadyHasPackage) {
			return { success: true, message: "Pi integration already installed." };
		}
		return {
			success: true,
			message: "Installed Pi integration: .pi/settings.json + CLAUDE.md pi marker.",
		};
	},

	async check(cwd) {
		const settingsPath = piSettingsPath(cwd);
		if (!existsSync(settingsPath)) {
			return { success: false, message: ".pi/settings.json not found." };
		}
		let settings: PiSettings;
		try {
			settings = await readPiSettings(settingsPath);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			return {
				success: false,
				message: `.pi/settings.json is not valid JSON: ${msg}`,
			};
		}
		const packages = Array.isArray(settings.packages) ? settings.packages : [];
		if (!packages.some(packageEntryMatches)) {
			return {
				success: false,
				message: `.pi/settings.json exists but does not list "${PI_PACKAGE_NAME}" in packages.`,
			};
		}
		return {
			success: true,
			message: `Pi integration installed (.pi/settings.json lists ${PI_PACKAGE_NAME}).`,
		};
	},

	async remove(cwd) {
		const settingsPath = piSettingsPath(cwd);
		let removedPackage = false;

		if (existsSync(settingsPath)) {
			let settings: PiSettings;
			try {
				settings = await readPiSettings(settingsPath);
			} catch {
				// Malformed JSON — bail rather than overwrite user state.
				return {
					success: false,
					message: ".pi/settings.json is not valid JSON; refusing to modify.",
				};
			}
			if (Array.isArray(settings.packages)) {
				const before = settings.packages.length;
				const filtered = settings.packages.filter((p) => !packageEntryMatches(p));
				removedPackage = filtered.length < before;
				if (filtered.length === 0) {
					delete settings.packages;
				} else {
					settings.packages = filtered;
				}
			}

			if (Object.keys(settings).length === 0) {
				// Settings would become an empty object — delete the file instead so
				// `sd setup pi --check` reports "not found" rather than "exists but
				// missing package".
				await unlink(settingsPath);
			} else {
				await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
			}
		}

		// Revert CLAUDE.md / AGENTS.md to the standalone snippet. Variant is
		// forced rather than auto-detected because the settings file may have
		// just been deleted but the FS cache could still report stale.
		await runOnboard({ cwd, variant: undefined, silent: true });

		if (!removedPackage) {
			return { success: true, message: "No pi integration found; nothing to remove." };
		}
		return {
			success: true,
			message: "Removed pi integration: .pi/settings.json + CLAUDE.md reverted.",
		};
	},
};

export const BUILTIN_RECIPES: Record<string, ProviderRecipe> = {
	pi: piRecipe,
};

export const BUILTIN_PROVIDER_NAMES: string[] = Object.keys(BUILTIN_RECIPES).sort();

interface SetupOptions {
	check?: boolean;
	remove?: boolean;
	list?: boolean;
	json?: boolean;
}

async function emitError(msg: string, jsonMode: boolean): Promise<void> {
	if (jsonMode) {
		await outputJson({ success: false, command: "setup", error: msg });
	} else {
		console.error(chalk.red(`Error: ${msg}`));
	}
	process.exitCode = 1;
}

async function runList(jsonMode: boolean): Promise<void> {
	const providers = BUILTIN_PROVIDER_NAMES.map((name) => ({ name, source: "builtin" as const }));

	if (jsonMode) {
		await outputJson({ success: true, command: "setup", action: "list", providers });
		return;
	}

	if (providers.length === 0) {
		console.log(chalk.dim("No providers available yet."));
		return;
	}

	console.log(chalk.bold("Available providers:"));
	const labelWidth = Math.max(...providers.map((p) => p.name.length), 6);
	for (const p of providers) {
		console.log(`  ${chalk.green("✓")} ${p.name.padEnd(labelWidth)}  built-in`);
	}
}

async function runProvider(
	provider: string,
	options: SetupOptions,
	jsonMode: boolean,
): Promise<void> {
	const recipe = BUILTIN_RECIPES[provider];
	if (!recipe) {
		await emitError(
			`Unknown provider "${provider}". Run \`sd setup --list\` to see available providers.`,
			jsonMode,
		);
		return;
	}

	const action = options.check ? "check" : options.remove ? "remove" : "install";
	const cwd = process.cwd();

	let result: RecipeResult;
	try {
		if (options.check) {
			result = await recipe.check(cwd);
		} else if (options.remove) {
			result = await recipe.remove(cwd);
		} else {
			result = await recipe.install(cwd);
		}
	} catch (err) {
		// A recipe that throws (instead of returning a RecipeResult) would
		// otherwise surface as a raw stack trace. Reshape to the same outcome
		// as a returned failure so users see a one-line, formatted error.
		const msg = err instanceof Error ? err.message : String(err);
		result = {
			success: false,
			message: `recipe "${provider}" ${action} threw: ${msg}`,
		};
	}

	if (jsonMode) {
		await outputJson({
			success: result.success,
			command: "setup",
			provider,
			action,
			message: result.message,
		});
	} else if (result.success) {
		printSuccess(result.message);
	} else if (options.check) {
		console.log(chalk.yellow(`✖ ${result.message}`));
	} else {
		console.error(chalk.red(`Error: ${result.message}`));
	}

	if (!result.success) process.exitCode = 1;
}

export function register(program: Command): void {
	const builtinHint = BUILTIN_PROVIDER_NAMES.length
		? `built-in: ${BUILTIN_PROVIDER_NAMES.join(", ")}`
		: "no built-in providers yet";

	program
		.command("setup")
		.argument("[provider]", `agent provider (${builtinHint})`)
		.description("Install seeds integration for an agent provider")
		.option("--check", "verify provider integration is installed")
		.option("--remove", "remove provider integration")
		.option("--list", "list available providers")
		.option("--json", "output as JSON")
		.action(async (provider: string | undefined, options: SetupOptions) => {
			const jsonMode = options.json === true;

			// Surface a consistent "Not in a seeds project" error early when
			// .seeds/ is missing. Mirrors the precondition every other sd
			// mutation honors.
			try {
				await findSeedsDir();
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await emitError(msg, jsonMode);
				return;
			}

			if (options.list) {
				await runList(jsonMode);
				return;
			}

			if (!provider) {
				await emitError("Specify a provider or use --list.", jsonMode);
				return;
			}

			await runProvider(provider, options, jsonMode);
		});
}

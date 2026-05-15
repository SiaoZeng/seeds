// `sd setup` — provider integration scaffolding.
//
// Step 1 (seeds-2774) ships the command shell — argument + flag plumbing, the
// recipe registry shape, and `--list` / `--check` / `--remove` / `--json`
// dispatch. No built-in recipes ship in this step; seeds-89d2 adds the `pi`
// recipe alongside the pi-aware onboarding marker variant.
//
// Mirrors mulch's `ml setup` shape so the two extensions feel like siblings.

import chalk from "chalk";
import type { Command } from "commander";
import { findSeedsDir } from "../config.ts";
import { outputJson, printSuccess } from "../output.ts";

export interface RecipeResult {
	success: boolean;
	message: string;
}

export interface ProviderRecipe {
	install(cwd: string): Promise<RecipeResult>;
	check(cwd: string): Promise<RecipeResult>;
	remove(cwd: string): Promise<RecipeResult>;
}

// No built-in recipes ship in step 1. seeds-89d2 adds the `pi` recipe.
export const BUILTIN_RECIPES: Record<string, ProviderRecipe> = {};

export const BUILTIN_PROVIDER_NAMES: string[] = Object.keys(BUILTIN_RECIPES).sort();

interface SetupOptions {
	check?: boolean;
	remove?: boolean;
	list?: boolean;
	json?: boolean;
}

function emitError(msg: string, jsonMode: boolean): void {
	if (jsonMode) {
		outputJson({ success: false, command: "setup", error: msg });
	} else {
		console.error(chalk.red(`Error: ${msg}`));
	}
	process.exitCode = 1;
}

async function runList(jsonMode: boolean): Promise<void> {
	const providers = BUILTIN_PROVIDER_NAMES.map((name) => ({ name, source: "builtin" as const }));

	if (jsonMode) {
		outputJson({ success: true, command: "setup", action: "list", providers });
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
		emitError(
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
		outputJson({
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
				emitError(msg, jsonMode);
				return;
			}

			if (options.list) {
				await runList(jsonMode);
				return;
			}

			if (!provider) {
				emitError("Specify a provider or use --list.", jsonMode);
				return;
			}

			await runProvider(provider, options, jsonMode);
		});
}

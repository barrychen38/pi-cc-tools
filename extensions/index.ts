import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	ToolExecutionComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

type TextBlock = { type: string; text?: string };
type TextResult = { content: readonly TextBlock[] };
type RenderContext = {
	cwd: string;
	isPartial: boolean;
	isError: boolean;
};

type SettingsFile = {
	toolBackground?: "default" | "transparent" | "outlines" | "border";
	expandedPreviewMaxLines?: number;
};

const EMPTY_TEXT = "";
const DEFAULT_EXPANDED_LINES = 2_000;
const GENERIC_RENDERER_PATCH = Symbol.for("pi-cc-tools:minimal-renderer");
const TOOL_BACKGROUND_KEYS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;

// ── thinking state ──
let thinkStartMs = 0;
let thinkActive = false;

function formatThinkDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

// ── caches ──
const settingsCache = new Map<string, SettingsFile>();
const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function createBuiltInTools(cwd: string) {
	return {
		read: createReadTool(cwd),
		bash: createBashTool(cwd),
		edit: createEditTool(cwd),
		write: createWriteTool(cwd),
		find: createFindTool(cwd),
		grep: createGrepTool(cwd),
		ls: createLsTool(cwd),
	};
}

function getBuiltInTools(cwd: string) {
	let tools = toolCache.get(cwd);
	if (!tools) {
		tools = createBuiltInTools(cwd);
		toolCache.set(cwd, tools);
	}
	return tools;
}

function getHomeDirectory(): string {
	return process.env.HOME || homedir();
}

function readSettings(cwd: string): SettingsFile {
	const key = resolve(cwd);
	const cached = settingsCache.get(key);
	if (cached) return cached;

	const home = getHomeDirectory();
	const paths = [
		join(home, ".pi", "settings.json"),
		join(home, ".pi", "agent", "settings.json"),
		join(key, ".pi", "settings.json"),
	];
	const merged: SettingsFile = {};
	for (const path of paths) {
		try {
			if (!existsSync(path)) continue;
			const value: unknown = JSON.parse(readFileSync(path, "utf8"));
			if (value && typeof value === "object") Object.assign(merged, value);
		} catch {
			// An invalid optional settings file must not prevent pi from starting.
		}
	}
	settingsCache.set(key, merged);
	return merged;
}

function setThemeBackground(theme: Theme, key: string, value: string): void {
	const themeValue = theme as unknown as {
		bgColors?: Map<string, string> | Record<string, string>;
	};
	if (themeValue.bgColors instanceof Map) {
		themeValue.bgColors.set(key, value);
	} else if (themeValue.bgColors && typeof themeValue.bgColors === "object") {
		themeValue.bgColors[key] = value;
	}
}

function applyToolBackground(theme: Theme, cwd: string): void {
	const mode = readSettings(cwd).toolBackground;
	if (!mode || mode === "default") return;

	// Keep transparent/outlines styles free of full-width native backgrounds.
	// The compact renderer intentionally does not add horizontal rules; this
	// leaves the existing color and theme choices without the old render patch.
	for (const key of TOOL_BACKGROUND_KEYS) {
		setThemeBackground(theme, key, "\x1b[49m");
	}
}

function configureMinimalUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	applyToolBackground(ctx.ui.theme, ctx.cwd);
	ctx.ui.setWorkingIndicator({ frames: [] });
	ctx.ui.setWorkingMessage(EMPTY_TEXT);
	ctx.ui.setWorkingVisible(false);
}

function emptyText(): Text {
	return new Text(EMPTY_TEXT, 0, 0);
}

function oneLine(value: unknown, max = 72): string {
	if (typeof value !== "string") return "";
	const normalized = value.replace(/\s+/g, " ").trim();
	if (normalized.length <= max) return normalized;
	return `${normalized.slice(0, Math.max(0, max - 3))}...`;
}

function stringArg(args: unknown, key: string): string {
	if (!args || typeof args !== "object") return "";
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "string" ? value : "";
}

function numberArg(args: unknown, key: string): number | undefined {
	if (!args || typeof args !== "object") return undefined;
	const value = (args as Record<string, unknown>)[key];
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function shortPath(cwd: string, value: unknown): string {
	if (typeof value !== "string" || value.length === 0) return "...";

	const absolute = resolve(cwd, value);
	const relativePath = relative(cwd, absolute);
	if (!relativePath || (!relativePath.startsWith("..") && !isAbsolute(relativePath))) {
		return relativePath || ".";
	}

	const home = getHomeDirectory();
	if (absolute === home) return "~";
	if (absolute.startsWith(`${home}/`)) return `~${absolute.slice(home.length)}`;
	return value;
}

function statusDot(context: RenderContext, theme: Theme): string {
	if (context.isError) return theme.fg("error", "●");
	if (context.isPartial) return theme.fg("muted", "○");
	return theme.fg("success", "●");
}

function renderCallLine(label: string, summary: string, theme: Theme, context: RenderContext): Text {
	const title = theme.fg("toolTitle", theme.bold(label));
	const suffix = summary ? ` ${theme.fg("accent", summary)}` : "";
	return new Text(`${statusDot(context, theme)} ${title}${suffix}`, 0, 0);
}

function textBlocks(result: TextResult): string[] {
	const blocks: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
			blocks.push(block.text);
		}
	}
	return blocks;
}

function firstTextLine(result: TextResult): string {
	for (const text of textBlocks(result)) {
		const start = text.search(/\S/);
		if (start < 0) continue;
		const newline = text.indexOf("\n", start);
		const end = newline < 0 ? text.length : newline;
		const line = text.slice(start, end).trimEnd();
		if (line) return line;
	}
	return "Tool failed";
}

function takeLines(text: string, maxLines: number): { text: string; truncated: boolean } {
	const normalized = text.replace(/\r/g, "").trim();
	if (!normalized) return { text: EMPTY_TEXT, truncated: false };

	let start = 0;
	let lineCount = 0;
	while (lineCount < maxLines) {
		const newline = normalized.indexOf("\n", start);
		lineCount++;
		if (newline < 0) return { text: normalized, truncated: false };
		start = newline + 1;
	}

	return {
		text: `${normalized.slice(0, Math.max(0, start - 1)).trimEnd()}\n…`,
		truncated: start < normalized.length,
	};
}

function expandedText(result: TextResult, maxLines: number): string {
	const blocks = textBlocks(result);
	if (blocks.length === 0) return EMPTY_TEXT;

	let output = EMPTY_TEXT;
	for (const block of blocks) {
		const next = output ? `${output}\n${block}` : block;
		const limited = takeLines(next, maxLines);
		output = limited.text;
		if (limited.truncated) break;
	}
	return output;
}

function branchBlock(content: string, theme: Theme): string {
	const rule = theme.fg("borderMuted", "└─");
	const continuation = theme.fg("borderMuted", "│");
	return content
		.split("\n")
		.map((line, index) => index === 0 ? `${rule} ${line}` : `${continuation}  ${line}`)
		.join("\n");
}

function renderMinimalResult(
	result: TextResult,
	expanded: boolean,
	theme: Theme,
	context: RenderContext,
): Text {
	if (context.isPartial) return emptyText();

	const settings = readSettings(context.cwd);
	const maxLines = typeof settings.expandedPreviewMaxLines === "number" && settings.expandedPreviewMaxLines > 0
		? Math.floor(settings.expandedPreviewMaxLines)
		: DEFAULT_EXPANDED_LINES;

	if (context.isError) {
		const raw = expanded ? expandedText(result, maxLines) : firstTextLine(result);
		if (!raw) return emptyText();
		return new Text(branchBlock(theme.fg("error", raw), theme), 0, 0);
	}

	if (!expanded) {
		const total = textBlocks(result).reduce((sum, b) => sum + b.split("\n").length, 0);
		if (total === 0) return emptyText();
		const label = `${total} line${total === 1 ? "" : "s"}`;
		return new Text(branchBlock(theme.fg("muted", label), theme), 0, 0);
	}

	const raw = expandedText(result, maxLines);
	if (!raw) return emptyText();
	return new Text(branchBlock(theme.fg("toolOutput", raw), theme), 0, 0);
}

type DiffSummary = { added: number; removed: number; newFile: boolean };

const WRITE_EDIT_DIFF = Symbol.for("pi-cc-tools:write-edit-diff");

function renderWriteEditResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	if (context.isPartial) return emptyText();

	const summary = (result as unknown as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] as DiffSummary | undefined;

	if (context.isError) {
		const raw = options.expanded
			? expandedText(result, DEFAULT_EXPANDED_LINES)
			: firstTextLine(result);
		if (!raw) return emptyText();
		return new Text(branchBlock(theme.fg("error", raw), theme), 0, 0);
	}

	if (!options.expanded) {
		if (!summary) return renderMinimalResult(result, options.expanded, theme, context);
		const parts: string[] = [];
		if (summary.newFile) parts.push(theme.fg("muted", "new file"));
		if (summary.added > 0) parts.push(theme.fg("success", `+${summary.added}`));
		if (summary.removed > 0) parts.push(theme.fg("error", `-${summary.removed}`));
		if (summary.added === 0 && summary.removed === 0) parts.push(theme.fg("muted", "unchanged"));
		if (parts.length === 0) return emptyText();
		return new Text(branchBlock(parts.join(" "), theme), 0, 0);
	}

	const raw = expandedText(result, DEFAULT_EXPANDED_LINES);
	if (!raw) return emptyText();
	return new Text(branchBlock(theme.fg("toolOutput", raw), theme), 0, 0);
}

function renderBuiltinResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	return renderMinimalResult(result, options.expanded, theme, context);
}

function genericLabel(name: string): string {
	if (/^mcp(?:__|:|[-_])/.test(name)) return "MCP";
	const words = name.replace(/[_-]+/g, " ").trim();
	if (!words) return "Tool";
	return words[0].toUpperCase() + words.slice(1);
}

function genericSummary(args: unknown): string {
	// todo tool: show action + subject
	const action = stringArg(args, "action");
	if (action) {
		const subject = stringArg(args, "subject");
		return subject ? `${action}: ${oneLine(subject, 56)}` : action;
	}
	// ask_user_question: show the question text
	const question = stringArg(args, "question");
	if (question) return oneLine(question, 72);
	// generic: first non-empty known key
	for (const key of ["path", "file_path", "command", "pattern", "query", "url", "name"]) {
		const value = stringArg(args, key);
		if (value) return oneLine(value);
	}
	return EMPTY_TEXT;
}

function renderGenericResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	if (context.isPartial) return emptyText();

	if (context.isError) {
		const raw = options.expanded
			? expandedText(result, DEFAULT_EXPANDED_LINES)
			: firstTextLine(result);
		if (!raw) return emptyText();
		return new Text(branchBlock(theme.fg("error", raw), theme), 0, 0);
	}

	if (!options.expanded) {
		// Show the first line of output — more useful than line counts for
		// todo, ask_user_question, and other MCP/custom tools.
		const first = firstTextLine(result);
		if (!first || first === "Tool failed") return emptyText();
		return new Text(branchBlock(theme.fg("muted", oneLine(first, 120)), theme), 0, 0);
	}

	const raw = expandedText(result, DEFAULT_EXPANDED_LINES);
	if (!raw) return emptyText();
	return new Text(branchBlock(theme.fg("toolOutput", raw), theme), 0, 0);
}

function patchUnknownToolRendering(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
	if (prototype[GENERIC_RENDERER_PATCH]) return;

	const originalCall = prototype.getCallRenderer;
	if (typeof originalCall === "function") {
		prototype.getCallRenderer = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (name === "read" || name === "bash" || name === "write" || name === "edit" || name === "find" || name === "grep" || name === "ls") {
				return Reflect.apply(originalCall, this, []);
			}
			return (args: unknown, theme: Theme, context: RenderContext) =>
				renderCallLine(genericLabel(name), genericSummary(args), theme, context);
		};
	}

	const originalResult = prototype.getResultRenderer;
	if (typeof originalResult === "function") {
		prototype.getResultRenderer = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (name === "read" || name === "bash" || name === "write" || name === "edit" || name === "find" || name === "grep" || name === "ls") {
				return Reflect.apply(originalResult, this, []);
			}
			return (result: TextResult, options: { expanded: boolean }, theme: Theme, context: RenderContext) =>
				renderGenericResult(result, options, theme, context);
		};
	}

	Object.defineProperty(prototype, GENERIC_RENDERER_PATCH, { value: true });
}

function registerBuiltInTools(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const tools = getBuiltInTools(cwd);

	pi.registerTool({
		name: "read",
		label: "read",
		description: tools.read.description,
		parameters: tools.read.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).read.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			let summary = shortPath(context.cwd, stringArg(args, "path"));
			const offset = numberArg(args, "offset");
			const limit = numberArg(args, "limit");
			if (offset !== undefined || limit !== undefined) {
				const range = [offset !== undefined ? `offset=${offset}` : "", limit !== undefined ? `limit=${limit}` : ""]
					.filter(Boolean)
					.join(", ");
				summary += ` (${range})`;
			}
			return renderCallLine("Read", summary, theme, context);
		},
		renderResult: renderBuiltinResult,
	});

	pi.registerTool({
		name: "bash",
		label: "bash",
		description: tools.bash.description,
		parameters: tools.bash.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const command = oneLine(stringArg(args, "command"), 96) || "...";
			const timeout = numberArg(args, "timeout");
			const suffix = timeout === undefined ? "" : ` (timeout ${timeout}s)`;
			return renderCallLine("Bash", `$ ${command}${suffix}`, theme, context);
		},
		renderResult: renderBuiltinResult,
	});

	pi.registerTool({
		name: "grep",
		label: "grep",
		description: tools.grep.description,
		parameters: tools.grep.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).grep.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const pattern = oneLine(stringArg(args, "pattern"), 48) || "...";
			const path = shortPath(context.cwd, stringArg(args, "path") || ".");
			const glob = stringArg(args, "glob");
			const suffix = glob ? ` (${oneLine(glob, 32)})` : "";
			return renderCallLine("Grep", `/${pattern}/ in ${path}${suffix}`, theme, context);
		},
		renderResult: renderBuiltinResult,
	});

	pi.registerTool({
		name: "find",
		label: "find",
		description: tools.find.description,
		parameters: tools.find.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).find.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const pattern = oneLine(stringArg(args, "pattern"), 48) || "...";
			const path = shortPath(context.cwd, stringArg(args, "path") || ".");
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : ` (limit ${limit})`;
			return renderCallLine("Find", `${pattern} in ${path}${suffix}`, theme, context);
		},
		renderResult: renderBuiltinResult,
	});

	pi.registerTool({
		name: "ls",
		label: "ls",
		description: tools.ls.description,
		parameters: tools.ls.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).ls.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const path = shortPath(context.cwd, stringArg(args, "path") || ".");
			const limit = numberArg(args, "limit");
			const suffix = limit === undefined ? "" : ` (limit ${limit})`;
			return renderCallLine("List", `${path}${suffix}`, theme, context);
		},
		renderResult: renderBuiltinResult,
	});

	pi.registerTool({
		name: "write",
		label: "write",
		description: tools.write.description,
		parameters: tools.write.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const fp = stringArg(params, "path");
			const absPath = resolve(ctx.cwd, fp);
			let oldLines = 0;
			try {
				if (existsSync(absPath)) oldLines = readFileSync(absPath, "utf-8").split("\n").length;
			} catch { /* new file */ }

			const result = await getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);

			const newLines = String(stringArg(params, "content")).split("\n").length;
			(result as unknown as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] = {
				added: Math.max(0, newLines - oldLines),
				removed: Math.max(0, oldLines - newLines),
				newFile: oldLines === 0,
			} satisfies DiffSummary;
			return result;
		},
		renderCall(args, theme, context) {
			return renderCallLine("Write", shortPath(context.cwd, stringArg(args, "path")), theme, context);
		},
		renderResult: renderWriteEditResult,
	});

	pi.registerTool({
		name: "edit",
		label: "edit",
		description: tools.edit.description,
		parameters: tools.edit.parameters,
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const fp = stringArg(params, "path");
			const absPath = resolve(ctx.cwd, fp);
			let oldLines = 0;
			try {
				if (existsSync(absPath)) oldLines = readFileSync(absPath, "utf-8").split("\n").length;
			} catch { /* new file */ }

			const result = await getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);

			let newLines = 0;
			try {
				if (existsSync(absPath)) newLines = readFileSync(absPath, "utf-8").split("\n").length;
			} catch { /* file may not exist after edit */ }

			(result as unknown as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] = {
				added: Math.max(0, newLines - oldLines),
				removed: Math.max(0, oldLines - newLines),
				newFile: oldLines === 0,
			} satisfies DiffSummary;
			return result;
		},
		renderCall(args, theme, context) {
			const fp = shortPath(context.cwd, stringArg(args, "path"));
			const edits = (args as Record<string, unknown>)?.edits as
				| readonly { oldText?: string; newText?: string }[]
				| undefined;
			const editCount = Array.isArray(edits) ? edits.length : 0;
			const countSuffix = editCount > 1 ? ` (${editCount} edits)` : "";
			const header = `${statusDot(context, theme)} ${theme.fg("toolTitle", theme.bold("Edit"))} ${theme.fg("accent", fp)}${countSuffix}`;

			if (!Array.isArray(edits) || editCount !== 1) {
				return new Text(header, 0, 0);
			}

			// Single edit: show a one-line old → new preview
			const edit = edits[0];
			const oldSnippet = oneLine(edit.oldText || "", 36) || "...";
			const newSnippet = oneLine(edit.newText || "", 36) || "...";
			const preview = [
				header,
				`${theme.fg("borderMuted", "│")}  ${theme.fg("error", `- ${oldSnippet}`)}`,
				`${theme.fg("borderMuted", "│")}  ${theme.fg("success", `+ ${newSnippet}`)}`,
			].join("\n");
			return new Text(preview, 0, 0);
		},
		renderResult: renderWriteEditResult,
	});
}

export default function (pi: ExtensionAPI): void {
	patchUnknownToolRendering();
	registerBuiltInTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		thinkActive = false;
		configureMinimalUi(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		configureMinimalUi(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		thinkActive = false;
		configureMinimalUi(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		thinkActive = false;
		configureMinimalUi(ctx);
	});

	pi.on("message_update", async (event, ctx) => {
		const evt = (event as unknown as Record<string, unknown>)?.assistantMessageEvent as
			| { type?: string }
			| undefined;
		if (!evt || typeof evt.type !== "string") return;

		if (evt.type === "thinking_start") {
			thinkStartMs = Date.now();
			thinkActive = true;
			if (ctx.hasUI) ctx.ui.setHiddenThinkingLabel("Thinking…");
		} else if (evt.type === "thinking_end" && thinkActive) {
			const dur = Date.now() - thinkStartMs;
			thinkActive = false;
			if (ctx.hasUI && dur >= 200) {
				ctx.ui.setHiddenThinkingLabel(`Thought for ${formatThinkDuration(dur)}`);
			}
		}
	});
}

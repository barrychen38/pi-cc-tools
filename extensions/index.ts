import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	AssistantMessageComponent,
	InteractiveMode,
	ToolExecutionComponent,
	createBashTool,
	createEditTool,
	createFindTool,
	createGrepTool,
	createLsTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	Editor,
	Spacer,
	Text,
	type AutocompleteItem,
	type AutocompleteSuggestions,
	type Component,
} from "@earendil-works/pi-tui";

type TextBlock = { type: string; text?: string };
type TextResult = { content: readonly TextBlock[]; details?: unknown };
type RenderContext = {
	cwd: string;
	isPartial: boolean;
	isError: boolean;
	args?: unknown;
	toolCallId?: string;
	invalidate?: () => void;
};

type DiffRenderer = "plain" | "delta" | "auto";

type SettingsFile = {
	toolBackground?: "default" | "transparent" | "outlines" | "border";
	expandedPreviewMaxLines?: number;
	diffRenderer?: DiffRenderer;
	diffTheme?: string;
};

const EMPTY_TEXT = "";
const DEFAULT_EXPANDED_LINES = 2_000;
const TOOL_PADDING_X = 2;
const THINKING_TEXT_TRUECOLOR = "\x1b[38;2;165;173;203m";
const THINKING_TEXT_256COLOR = "\x1b[38;5;146m";
const GENERIC_RENDERER_PATCH = Symbol.for("pi-cc-tools:minimal-renderer");
const FIRST_MESSAGE_SPACER_PATCH = Symbol.for("pi-cc-tools:first-message-spacer");
const EMPTY_WIDGET_SPACER_PATCH = Symbol.for("pi-cc-tools:empty-widget-spacer");
const TODO_WIDGET_PATCH = Symbol.for("pi-cc-tools:todo-widget-indent");
const TOOL_BACKGROUND_KEYS = ["toolPendingBg", "toolSuccessBg", "toolErrorBg"] as const;

const THINK_DURATION_KEY = "_piCcToolsThinkDurationMs";
type ThinkingState = { active: boolean; startedAt: number; duration?: number };
const thinkingStates = new Map<string, ThinkingState>();

function thinkingMessageKey(message: Record<string, unknown>): string | undefined {
	const timestamp = message.timestamp;
	if (typeof timestamp !== "number") return undefined;
	const provider = typeof message.provider === "string" ? message.provider : "";
	const model = typeof message.model === "string" ? message.model : "";
	return `${provider}:${model}:${timestamp}`;
}

function formatThinkDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	return `${(ms / 1000).toFixed(1)}s`;
}

const THINKING_PATCH = Symbol.for("pi-cc-tools:thinking-patch");
const SKILL_AUTOCOMPLETE_PATCH = Symbol.for("pi-cc-tools:skill-autocomplete");
const SKILL_TRIGGER = "$";
const SKILL_COMMAND_PREFIX = "skill:";
const SKILL_COMMAND_COLOR = "\x1b[38;5;141m";
const RESET_FG = "\x1b[39m";
const SKILL_TOKEN_DELIMITERS = new Set([" ", "\t", "\"", "'", "=", "(", "[", "{"]);
const SKILL_NAME_PATTERN = /^[A-Za-z0-9._-]*$/;
const SKILL_TOKEN_PATTERN = /(^|[\s"'=([{])\$([A-Za-z0-9][A-Za-z0-9._-]*)(?=$|[\s.,;:!?，。；：！？)\]}'"])/g;
const skillNamesForDisplay = new Set<string>();

type SkillAutocompleteProvider = {
	commands?: readonly (AutocompleteItem | { name: string; description?: string })[];
	triggerCharacters?: string[];
};

type EditorPatch = {
	state?: { lines?: string[]; cursorLine?: number; cursorCol?: number };
	render: (width: number) => string[];
};

function commandName(command: AutocompleteItem | { name: string }): string {
	return "name" in command ? command.name : command.value;
}

function isSkillTokenBoundary(text: string, index: number): boolean {
	return index === 0 || SKILL_TOKEN_DELIMITERS.has(text[index - 1] ?? "");
}

function skillTriggerContext(textBeforeCursor: string): { text: string; query: string } | undefined {
	for (let index = textBeforeCursor.length - 1; index >= 0; index--) {
		if (textBeforeCursor[index] !== SKILL_TRIGGER || !isSkillTokenBoundary(textBeforeCursor, index)) continue;
		const query = textBeforeCursor.slice(index + 1);
		if (!SKILL_NAME_PATTERN.test(query)) return undefined;
		return { text: textBeforeCursor.slice(index), query };
	}
	return undefined;
}

function skillAutocompleteItems(provider: unknown, query: string): AutocompleteItem[] {
	const commands = (provider as SkillAutocompleteProvider).commands ?? [];
	const normalizedQuery = query.toLowerCase();
	const items: AutocompleteItem[] = [];
	for (const command of commands) {
		const name = commandName(command);
		if (!name.startsWith(SKILL_COMMAND_PREFIX)) continue;
		const skillName = name.slice(SKILL_COMMAND_PREFIX.length);
		skillNamesForDisplay.add(skillName);
		if (normalizedQuery && !skillName.toLowerCase().includes(normalizedQuery)) continue;
		items.push({
			value: skillName,
			label: skillName,
			description: command.description,
		});
	}
	return items.sort((a, b) => a.label.localeCompare(b.label));
}

function colorKnownSkillTokens(line: string): string {
	return line.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string) => {
		if (!skillNamesForDisplay.has(skillName)) return match;
		return `${prefix}${SKILL_COMMAND_COLOR}$${skillName}${RESET_FG}`;
	});
}

function stripSkillFrontmatter(content: string): string {
	return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function expandSkillReferences(text: string, commands: readonly { name: string; source: string; sourceInfo: { path: string; baseDir?: string } }[]): string {
	const skills = new Map<string, { filePath: string; baseDir: string }>();
	for (const command of commands) {
		if (command.source !== "skill" || !command.name.startsWith(SKILL_COMMAND_PREFIX)) continue;
		const skillName = command.name.slice(SKILL_COMMAND_PREFIX.length);
		skillNamesForDisplay.add(skillName);
		skills.set(skillName, {
			filePath: command.sourceInfo.path,
			baseDir: command.sourceInfo.baseDir ?? dirname(command.sourceInfo.path),
		});
	}
	if (skills.size === 0) return text;

	return text.replace(SKILL_TOKEN_PATTERN, (match, prefix: string, skillName: string) => {
		const skill = skills.get(skillName);
		if (!skill) return match;
		try {
			const body = stripSkillFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			const skillBlock = `<skill name="${skillName}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
			return `${prefix}${skillBlock}`;
		} catch {
			return match;
		}
	});
}

function patchSkillAutocomplete(): void {
	const editorPrototype = Editor.prototype as unknown as Record<PropertyKey, unknown>;
	const providerPrototype = CombinedAutocompleteProvider.prototype as unknown as Record<PropertyKey, unknown>;
	if (editorPrototype[SKILL_AUTOCOMPLETE_PATCH]) return;

	(providerPrototype as SkillAutocompleteProvider).triggerCharacters = [SKILL_TRIGGER];

	editorPrototype.isSlashMenuAllowed = function restoredIsSlashMenuAllowed(this: EditorPatch) {
		return this.state?.cursorLine === 0;
	};
	editorPrototype.isAtStartOfMessage = function restoredIsAtStartOfMessage(this: EditorPatch) {
		if (this.state?.cursorLine !== 0) return false;
		const currentLine = this.state?.lines?.[0] ?? "";
		const beforeCursor = currentLine.slice(0, this.state.cursorCol ?? 0);
		return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
	};
	editorPrototype.isInSlashCommandContext = function restoredIsInSlashCommandContext(this: EditorPatch, textBeforeCursor: string) {
		return this.state?.cursorLine === 0 && textBeforeCursor.trimStart().startsWith("/");
	};

	const originalRender = editorPrototype.render as EditorPatch["render"] | undefined;
	if (typeof originalRender === "function") {
		editorPrototype.render = function patchedRender(this: EditorPatch, width: number) {
			return originalRender.call(this, width).map(colorKnownSkillTokens);
		};
	}

	const originalGetSuggestions = providerPrototype.getSuggestions as
		| ((
			this: unknown,
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		) => Promise<AutocompleteSuggestions | null>)
		| undefined;
	if (typeof originalGetSuggestions === "function") {
		providerPrototype.getSuggestions = async function patchedGetSuggestions(
			this: unknown,
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			options: { signal: AbortSignal; force?: boolean },
		): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const context = skillTriggerContext(currentLine.slice(0, cursorCol));
			if (context) {
				const items = skillAutocompleteItems(this, context.query);
				return items.length > 0 ? { items, prefix: context.text } : null;
			}
			return originalGetSuggestions.call(this, lines, cursorLine, cursorCol, options);
		};
	}

	const originalApplyCompletion = providerPrototype.applyCompletion as
		| ((
			this: unknown,
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: AutocompleteItem,
			prefix: string,
		) => { lines: string[]; cursorLine: number; cursorCol: number })
		| undefined;
	if (typeof originalApplyCompletion === "function") {
		providerPrototype.applyCompletion = function patchedApplyCompletion(
			this: unknown,
			lines: string[],
			cursorLine: number,
			cursorCol: number,
			item: AutocompleteItem,
			prefix: string,
		) {
			if (prefix.startsWith(SKILL_TRIGGER)) {
				const currentLine = lines[cursorLine] ?? "";
				const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
				const afterCursor = currentLine.slice(cursorCol);
				const newLines = [...lines];
				newLines[cursorLine] = `${beforePrefix}$${item.value} ${afterCursor}`;
				skillNamesForDisplay.add(item.value);
				return {
					lines: newLines,
					cursorLine,
					cursorCol: beforePrefix.length + item.value.length + 2,
				};
			}
			return originalApplyCompletion.call(this, lines, cursorLine, cursorCol, item, prefix);
		};
	}

	editorPrototype[SKILL_AUTOCOMPLETE_PATCH] = true;
}

function patchAssistantThinkingLabel(): void {
	const proto = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
	if (proto[THINKING_PATCH]) return;

	const original = proto.updateContent as (message: Record<string, unknown>) => void | undefined;
	if (typeof original !== "function") return;

	proto.updateContent = function patchedUpdateContent(this: {
		hideThinkingBlock?: boolean;
		hiddenThinkingLabel?: string;
	}, message: Record<string, unknown>) {
		const state = thinkingStates.get(thinkingMessageKey(message) ?? "");
		const activeDuration = state?.active ? Date.now() - state.startedAt : undefined;
		const duration = message[THINK_DURATION_KEY] ?? state?.duration;
		if (activeDuration !== undefined) {
			this.hiddenThinkingLabel = `Thinking for ${formatThinkDuration(activeDuration)}`;
		} else if (typeof duration === "number" && duration >= 0) {
			this.hiddenThinkingLabel = `Thought for ${formatThinkDuration(duration)}`;
		}

		// Thinking content is intentionally kept collapsed. Streaming message
		// updates refresh the elapsed label without adding a separate timer.
		this.hideThinkingBlock = true;
		return original.call(this, message);
	};
	proto[THINKING_PATCH] = true;
}

// ── caches ──
const settingsCache = new Map<string, SettingsFile>();
const toolCache = new Map<string, ReturnType<typeof createBuiltInTools>>();

function resetSettingsCache(): void {
	settingsCache.clear();
}

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

function applyThinkingTextColor(theme: Theme): void {
	const themeValue = theme as unknown as {
		fgColors?: Map<string, string> | Record<string, string>;
	};
	const value = theme.getColorMode() === "truecolor"
		? THINKING_TEXT_TRUECOLOR
		: THINKING_TEXT_256COLOR;
	if (themeValue.fgColors instanceof Map) {
		themeValue.fgColors.set("thinkingText", value);
	} else if (themeValue.fgColors && typeof themeValue.fgColors === "object") {
		themeValue.fgColors.thinkingText = value;
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
	applyThinkingTextColor(ctx.ui.theme);
	applyToolBackground(ctx.ui.theme, ctx.cwd);
	ctx.ui.setWorkingIndicator();
	ctx.ui.setWorkingMessage();
	ctx.ui.setWorkingVisible(true);
}

function emptyText(): Text {
	return toolText(EMPTY_TEXT);
}

function toolText(value: string): Text {
	return new Text(value, TOOL_PADDING_X, 0);
}

function patchFirstMessageSpacing(): void {
	const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>;
	if (prototype[FIRST_MESSAGE_SPACER_PATCH]) return;

	const original = prototype.addMessageToChat;
	if (typeof original !== "function") return;

	prototype.addMessageToChat = function (
		this: { chatContainer?: { children?: Component[] } },
		message: { role?: unknown; content?: unknown },
		options?: unknown,
	) {
		const textContent = typeof message.content === "string"
			? message.content
			: Array.isArray(message.content)
				? message.content
					.filter((block): block is { type: "text"; text: string } =>
						block?.type === "text" && typeof block.text === "string")
					.map((block) => block.text)
					.join("")
				: "";
		const needsLeadingSpacer =
			message.role === "user" &&
			textContent.length > 0 &&
			this.chatContainer?.children?.length === 0;
		const result = Reflect.apply(original, this, [message, options]);
		if (needsLeadingSpacer && this.chatContainer?.children) {
			this.chatContainer.children.unshift(new Spacer(1));
		}
		return result;
	};
	prototype[FIRST_MESSAGE_SPACER_PATCH] = true;
}

function patchEmptyWidgetSpacing(): void {
	const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>;
	if (prototype[EMPTY_WIDGET_SPACER_PATCH]) return;

	const original = prototype.renderWidgetContainer;
	if (typeof original !== "function") return;

	prototype.renderWidgetContainer = function (
		container: unknown,
		widgets: Map<string, Component>,
		spacerWhenEmpty: boolean,
		leadingSpacer: boolean,
	) {
		return Reflect.apply(original, this, [
			container,
			widgets,
			spacerWhenEmpty && widgets.size > 0,
			leadingSpacer,
		]);
	};
	prototype[EMPTY_WIDGET_SPACER_PATCH] = true;
}

class ToolIndent implements Component {
	constructor(private readonly child: Component) {}

	render(width: number): string[] {
		const childWidth = Math.max(1, width - TOOL_PADDING_X);
		const padding = " ".repeat(TOOL_PADDING_X);
		return this.child.render(childWidth).map((line) => line ? `${padding}${line}` : line);
	}

	invalidate(): void {
		this.child.invalidate();
	}

	dispose(): void {
		(this.child as Component & { dispose?: () => void }).dispose?.();
	}
}

function patchTodoWidgetIndent(): void {
	const prototype = InteractiveMode.prototype as unknown as Record<PropertyKey, unknown>;
	if (prototype[TODO_WIDGET_PATCH]) return;

	const original = prototype.setExtensionWidget;
	if (typeof original !== "function") return;

	prototype.setExtensionWidget = function (
		key: string,
		content: string[] | ((...args: unknown[]) => Component) | undefined,
		options?: unknown,
	) {
		let indentedContent = content;
		if (key === "rpiv-todos" && Array.isArray(content)) {
			// Pi wraps string widgets in Text with one column of host padding.
			const padding = " ".repeat(Math.max(0, TOOL_PADDING_X - 1));
			indentedContent = content.map((line) => line ? `${padding}${line}` : line);
		} else if (key === "rpiv-todos" && typeof content === "function") {
			indentedContent = (...args: unknown[]) => new ToolIndent(Reflect.apply(content, undefined, args));
		}
		return Reflect.apply(original, this, [key, indentedContent, options]);
	};
	prototype[TODO_WIDGET_PATCH] = true;
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
	return toolText(`${statusDot(context, theme)} ${title}${suffix}`);
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
		return toolText(branchBlock(theme.fg("error", raw), theme));
	}

	if (!expanded) {
		const total = textBlocks(result).reduce((sum, b) => sum + b.split("\n").length, 0);
		if (total === 0) return emptyText();
		const label = `${total} line${total === 1 ? "" : "s"}`;
		return toolText(branchBlock(theme.fg("muted", label), theme));
	}

	const raw = expandedText(result, maxLines);
	if (!raw) return emptyText();
	return toolText(branchBlock(theme.fg("toolOutput", raw), theme));
}

type DiffSummary = { added: number; removed: number; newFile: boolean };

const WRITE_EDIT_DIFF = Symbol.for("pi-cc-tools:write-edit-diff");
const WRITE_EDIT_RENDERED_DIFF = Symbol.for("pi-cc-tools:write-edit-rendered-diff");
const FILE_DIFF_PREVIEW_LINES = 80;
const DIFF_CONTEXT_LINES = 3;
const MAX_LINE_DIFF_CELLS = 1_000_000;
const MAX_DELTA_INPUT_BYTES = 500_000;
const DELTA_TIMEOUT_MS = 2_000;
const DELTA_SYNTAX_THEME_ALIASES: Record<string, string> = {
	"catppuccin-frappe": "Catppuccin Frappe",
	"catppuccin-latte": "Catppuccin Latte",
	"catppuccin-macchiato": "Catppuccin Macchiato",
	"catppuccin-mocha": "Catppuccin Mocha",
};
const DELTA_STYLE_ARGS: Record<string, string[]> = {
	"Catppuccin Macchiato": [
		"--minus-style=syntax #4c3a4c",
		"--minus-emph-style=bold syntax #6a485a",
		"--plus-style=syntax #3e4b4c",
		"--plus-emph-style=bold syntax #51655a",
		"--zero-style=syntax",
	],
};

function splitTextLines(text: string): string[] {
	if (!text) return [];
	const lines = text.replace(/\r\n?/g, "\n").split("\n");
	if (lines.at(-1) === "") lines.pop();
	return lines;
}

function countCommonLines(before: readonly string[], after: readonly string[]): number {
	if (before.length === 0 || after.length === 0) return 0;
	// Bound complete-rewrite work; large unmatched middles are summarized as
	// removed and added instead of making rendering latency quadratic.
	if (before.length * after.length > MAX_LINE_DIFF_CELLS) return 0;

	const columns = after.length + 1;
	let previous = new Uint32Array(columns);
	let current = new Uint32Array(columns);
	for (const beforeLine of before) {
		for (let column = 1; column < columns; column++) {
			current[column] = beforeLine === after[column - 1]
				? previous[column - 1] + 1
				: Math.max(previous[column], current[column - 1]);
		}
		[previous, current] = [current, previous];
		current.fill(0);
	}
	return previous[after.length];
}

function summarizeTextChange(beforeText: string, afterText: string, newFile: boolean): DiffSummary {
	const before = splitTextLines(beforeText);
	const after = splitTextLines(afterText);

	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;

	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd--;
		afterEnd--;
	}

	const changedBefore = before.slice(start, beforeEnd);
	const changedAfter = after.slice(start, afterEnd);
	const common = countCommonLines(changedBefore, changedAfter);
	return {
		added: changedAfter.length - common,
		removed: changedBefore.length - common,
		newFile,
	};
}

function summarizeEditResult(result: TextResult): DiffSummary | undefined {
	if (!result.details || typeof result.details !== "object") return undefined;
	const diff = (result.details as { diff?: unknown }).diff;
	if (typeof diff !== "string") return undefined;

	let added = 0;
	let removed = 0;
	for (const line of diff.split("\n")) {
		if (line.startsWith("+")) added++;
		else if (line.startsWith("-")) removed++;
	}
	return { added, removed, newFile: false };
}

function diffRendererMode(cwd: string): DiffRenderer {
	const override = process.env.PI_CC_TOOLS_DIFF_RENDERER;
	if (override === "plain" || override === "delta" || override === "auto") return override;
	const setting = readSettings(cwd).diffRenderer;
	return setting === "delta" || setting === "auto" ? setting : "plain";
}

function formatTextChangeDiff(beforeText: string, afterText: string, newFile: boolean): string | undefined {
	const before = splitTextLines(beforeText);
	const after = splitTextLines(afterText);
	if (!newFile && before.length === after.length && before.every((line, index) => line === after[index])) {
		return undefined;
	}

	const lines: string[] = [];
	let truncated = false;
	const push = (line: string) => {
		if (lines.length < DEFAULT_EXPANDED_LINES) lines.push(line);
		else truncated = true;
	};
	const pushEllipsis = () => {
		if (lines.at(-1) !== "…") push("…");
	};

	if (newFile) {
		for (let index = 0; index < after.length; index++) push(`+${index + 1} ${after[index]}`);
		if (truncated) pushEllipsis();
		return lines.join("\n");
	}

	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;

	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd--;
		afterEnd--;
	}

	const contextStart = Math.max(0, start - DIFF_CONTEXT_LINES);
	if (contextStart > 0) pushEllipsis();
	for (let index = contextStart; index < start; index++) push(` ${index + 1} ${before[index]}`);
	for (let index = start; index < beforeEnd; index++) push(`-${index + 1} ${before[index]}`);
	for (let index = start; index < afterEnd; index++) push(`+${index + 1} ${after[index]}`);

	const contextEnd = Math.min(after.length, afterEnd + DIFF_CONTEXT_LINES);
	for (let index = afterEnd; index < contextEnd; index++) push(` ${index + 1} ${after[index]}`);
	if (contextEnd < after.length || truncated) pushEllipsis();
	return lines.join("\n");
}

function formatUnifiedPatch(path: string, beforeText: string, afterText: string, newFile: boolean): string | undefined {
	const before = splitTextLines(beforeText);
	const after = splitTextLines(afterText);
	if (!newFile && before.length === after.length && before.every((line, index) => line === after[index])) {
		return undefined;
	}

	if (newFile) {
		return [
			"--- /dev/null",
			`+++ b/${path}`,
			`@@ -0,0 +1,${after.length} @@`,
			...after.map((line) => `+${line}`),
		].join("\n");
	}

	let start = 0;
	while (start < before.length && start < after.length && before[start] === after[start]) start++;

	let beforeEnd = before.length;
	let afterEnd = after.length;
	while (beforeEnd > start && afterEnd > start && before[beforeEnd - 1] === after[afterEnd - 1]) {
		beforeEnd--;
		afterEnd--;
	}

	const contextStart = Math.max(0, start - DIFF_CONTEXT_LINES);
	const beforeContextEnd = Math.min(before.length, beforeEnd + DIFF_CONTEXT_LINES);
	const afterContextEnd = Math.min(after.length, afterEnd + DIFF_CONTEXT_LINES);
	const oldStart = contextStart + 1;
	const newStart = contextStart + 1;
	const oldCount = Math.max(0, beforeContextEnd - contextStart);
	const newCount = Math.max(0, afterContextEnd - contextStart);
	const lines = [
		`--- a/${path}`,
		`+++ b/${path}`,
		`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
	];
	for (let index = contextStart; index < start; index++) lines.push(` ${before[index]}`);
	for (let index = start; index < beforeEnd; index++) lines.push(`-${before[index]}`);
	for (let index = start; index < afterEnd; index++) lines.push(`+${after[index]}`);
	for (let index = afterEnd; index < afterContextEnd; index++) lines.push(` ${after[index]}`);
	return lines.join("\n");
}

function deltaSyntaxTheme(cwd: string): string | undefined {
	const themeName = readSettings(cwd).diffTheme;
	if (!themeName) return undefined;
	return DELTA_SYNTAX_THEME_ALIASES[themeName] ?? themeName;
}

function deltaStyleArgs(syntaxTheme: string | undefined): string[] {
	return syntaxTheme ? DELTA_STYLE_ARGS[syntaxTheme] ?? [] : [];
}

function compactDeltaOutput(output: string): string | undefined {
	const compact = output.trim();
	return compact ? compact : undefined;
}

function renderDeltaPatch(patch: string, cwd: string): Promise<string | undefined> {
	if (diffRendererMode(cwd) === "plain" || Buffer.byteLength(patch, "utf8") > MAX_DELTA_INPUT_BYTES) {
		return Promise.resolve(undefined);
	}

	const syntaxTheme = deltaSyntaxTheme(cwd);
	const args = [
		"--no-gitconfig",
		"--paging=never",
		"--file-style=omit",
		"--hunk-header-style=omit",
		"--keep-plus-minus-markers",
		"--width=variable",
		...(syntaxTheme ? [`--syntax-theme=${syntaxTheme}`] : []),
		...deltaStyleArgs(syntaxTheme),
	];

	return new Promise((resolveDelta) => {
		const child = spawn("delta", args, {
			cwd,
			env: { ...process.env, NO_COLOR: undefined },
			stdio: ["pipe", "pipe", "ignore"],
		});
		let output = "";
		let settled = false;
		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolveDelta(value);
		};
		const timeout = setTimeout(() => {
			child.kill();
			finish(undefined);
		}, DELTA_TIMEOUT_MS);
		(child as unknown as { unref?: () => void }).unref?.();
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", (chunk) => {
			output += chunk;
		});
		child.stdout.on("error", () => finish(undefined));
		child.stdin.on("error", () => undefined);
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? compactDeltaOutput(output) : undefined));
		child.stdin.end(patch);
	});
}

function extractPatch(result: TextResult): string | undefined {
	const details = result.details && typeof result.details === "object"
		? result.details as { patch?: unknown }
		: undefined;
	return typeof details?.patch === "string" && details.patch.trim() ? details.patch : undefined;
}

async function renderDeltaForPatch(patch: string | undefined, cwd: string): Promise<string | undefined> {
	return patch ? renderDeltaPatch(patch, cwd) : undefined;
}

function attachDiffSummary(result: TextResult, summary: DiffSummary, diff?: string, renderedDiff?: string): void {
	const details = result.details && typeof result.details === "object" ? result.details : {};
	(details as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] = summary;
	if (diff) (details as { diff?: string }).diff = diff;
	if (renderedDiff) (details as Record<PropertyKey, unknown>)[WRITE_EDIT_RENDERED_DIFF] = renderedDiff;
	(result as { details?: unknown }).details = details;
}

function diffSummaryLine(summary: DiffSummary | undefined, theme: Theme): string | undefined {
	if (!summary) return undefined;

	const parts: string[] = [];
	if (summary.newFile) parts.push(theme.fg("muted", "new file"));
	if (summary.added > 0) parts.push(theme.fg("success", `+${summary.added}`));
	if (summary.removed > 0) parts.push(theme.fg("error", `-${summary.removed}`));
	if (summary.added === 0 && summary.removed === 0) parts.push(theme.fg("muted", "unchanged"));
	return parts.length > 0 ? parts.join(" ") : undefined;
}

function editDiff(result: TextResult): string | undefined {
	const details = result.details && typeof result.details === "object"
		? result.details as { diff?: unknown }
		: undefined;
	return typeof details?.diff === "string" && details.diff.trim() ? details.diff : undefined;
}

function renderedDiff(result: TextResult): string | undefined {
	return result.details && typeof result.details === "object"
		? (result.details as Record<PropertyKey, unknown>)[WRITE_EDIT_RENDERED_DIFF] as string | undefined
		: undefined;
}

function colorDiffText(diff: string, theme: Theme, maxLines: number): string {
	const limited = takeLines(diff, maxLines).text;
	return limited
		.split("\n")
		.map((line) => {
			if (line.startsWith("+")) return theme.fg("success", line);
			if (line.startsWith("-")) return theme.fg("error", line);
			if (line.startsWith("@") || line === "…") return theme.fg("muted", line);
			return theme.fg("toolOutput", line);
		})
		.join("\n");
}

function writeEditSummary(result: TextResult): DiffSummary | undefined {
	return result.details && typeof result.details === "object"
		? (result.details as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] as DiffSummary | undefined
		: undefined;
}

function renderWriteEditResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	if (context.isPartial) return emptyText();

	const summary = writeEditSummary(result);

	if (context.isError) {
		const raw = options.expanded
			? expandedText(result, DEFAULT_EXPANDED_LINES)
			: firstTextLine(result);
		if (!raw) return emptyText();
		return toolText(branchBlock(theme.fg("error", raw), theme));
	}

	const diff = renderedDiff(result) ?? editDiff(result);
	if (diff) {
		const maxLines = options.expanded ? DEFAULT_EXPANDED_LINES : FILE_DIFF_PREVIEW_LINES;
		const diffOutput = renderedDiff(result) ? takeLines(diff, maxLines).text : colorDiffText(diff, theme, maxLines);
		const output = [diffSummaryLine(summary, theme), diffOutput].filter(Boolean).join("\n");
		return toolText(branchBlock(output, theme));
	}

	if (!options.expanded) {
		const line = diffSummaryLine(summary, theme);
		if (!line) return renderMinimalResult(result, options.expanded, theme, context);
		return toolText(branchBlock(line, theme));
	}

	const raw = expandedText(result, DEFAULT_EXPANDED_LINES);
	if (!raw) return emptyText();
	return toolText(branchBlock(theme.fg("toolOutput", raw), theme));
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
		return toolText(branchBlock(theme.fg("error", raw), theme));
	}

	if (!options.expanded) {
		// Show the first line of output — more useful than line counts for
		// todo, ask_user_question, and other MCP/custom tools.
		const first = firstTextLine(result);
		if (!first || first === "Tool failed") return emptyText();
		return toolText(branchBlock(theme.fg("muted", oneLine(first, 120)), theme));
	}

	const raw = expandedText(result, DEFAULT_EXPANDED_LINES);
	if (!raw) return emptyText();
	return toolText(branchBlock(theme.fg("toolOutput", raw), theme));
}

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "write", "edit", "find", "grep", "ls"]);
const NATIVE_RENDERER_TOOL_NAMES = new Set([...BUILT_IN_TOOL_NAMES, "Agent"]);

function keepsOwnRenderer(name: string): boolean {
	return NATIVE_RENDERER_TOOL_NAMES.has(name) || name === "todo";
}

function patchUnknownToolRendering(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
	if (prototype[GENERIC_RENDERER_PATCH]) return;

	const originalShell = prototype.getRenderShell;
	if (typeof originalShell === "function") {
		prototype.getRenderShell = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (!NATIVE_RENDERER_TOOL_NAMES.has(name)) return "self";
			return Reflect.apply(originalShell, this, []);
		};
	}

	const originalCall = prototype.getCallRenderer;
	if (typeof originalCall === "function") {
		prototype.getCallRenderer = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (keepsOwnRenderer(name)) {
				const renderer = Reflect.apply(originalCall, this, []) as
					| ((...args: unknown[]) => Component)
					| undefined;
				if (name !== "todo" || !renderer) return renderer;
				return (...args: unknown[]) => new ToolIndent(renderer(...args));
			}
			return (args: unknown, theme: Theme, context: RenderContext) =>
				renderCallLine(genericLabel(name), genericSummary(args), theme, context);
		};
	}

	const originalResult = prototype.getResultRenderer;
	if (typeof originalResult === "function") {
		prototype.getResultRenderer = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (keepsOwnRenderer(name)) {
				const renderer = Reflect.apply(originalResult, this, []) as
					| ((...args: unknown[]) => Component)
					| undefined;
				if (name !== "todo" || !renderer) return renderer;
				return (...args: unknown[]) => new ToolIndent(renderer(...args));
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
			const existed = existsSync(absPath);
			let previousContent = "";
			try {
				if (existed) previousContent = readFileSync(absPath, "utf-8");
			} catch { /* Keep the write usable when the old file cannot be read. */ }

			const newContent = stringArg(params, "content");
			const result = await getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);

			const plainDiff = formatTextChangeDiff(previousContent, newContent, !existed);
			const patch = formatUnifiedPatch(fp, previousContent, newContent, !existed);
			attachDiffSummary(
				result,
				summarizeTextChange(previousContent, newContent, !existed),
				plainDiff,
				await renderDeltaForPatch(patch, ctx.cwd),
			);
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
			const result = await getBuiltInTools(ctx.cwd).edit.execute(toolCallId, params, signal, onUpdate);
			const summary = summarizeEditResult(result);
			if (summary) attachDiffSummary(result, summary, undefined, await renderDeltaForPatch(extractPatch(result), ctx.cwd));
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
			return toolText(header);
		},
		renderResult: renderWriteEditResult,
	});
}

export default function (pi: ExtensionAPI): void {
	patchSkillAutocomplete();
	patchFirstMessageSpacing();
	patchEmptyWidgetSpacing();
	patchTodoWidgetIndent();
	patchUnknownToolRendering();
	patchAssistantThinkingLabel();
	registerBuiltInTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		resetSettingsCache();
		thinkingStates.clear();
		configureMinimalUi(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		resetSettingsCache();
		configureMinimalUi(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		configureMinimalUi(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
		resetSettingsCache();
		configureMinimalUi(ctx);
	});
	pi.on("agent_end", async (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.setWorkingVisible(false);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension" || !event.text.includes(SKILL_TRIGGER)) {
			return { action: "continue" };
		}
		const expandedText = expandSkillReferences(event.text, pi.getCommands());
		return expandedText === event.text
			? { action: "continue" }
			: { action: "transform", text: expandedText, images: event.images };
	});

	pi.on("message_update", async (event, _ctx) => {
		const evt = (event as unknown as Record<string, unknown>)?.assistantMessageEvent as
			| { type?: string }
			| undefined;
		if (!evt || typeof evt.type !== "string") return;

		const msg = (event as unknown as Record<string, unknown>).message as Record<PropertyKey, unknown> | undefined;
		if (!msg) return;
		const key = thinkingMessageKey(msg as Record<string, unknown>);
		if (!key) return;

		if (evt.type === "thinking_start") {
			thinkingStates.set(key, { active: true, startedAt: Date.now() });
		} else if (evt.type === "thinking_end") {
			const state = thinkingStates.get(key);
			if (!state?.active) return;
			state.active = false;
			state.duration = Date.now() - state.startedAt;
			msg[THINK_DURATION_KEY] = state.duration;
		}
	});

	pi.on("message_end", async (event, _ctx) => {
		const msg = (event as unknown as Record<string, unknown>).message as Record<PropertyKey, unknown> | undefined;
		if (!msg) return;
		const key = thinkingMessageKey(msg as Record<string, unknown>);
		if (!key) return;

		const state = thinkingStates.get(key);
		if (state?.duration !== undefined) {
			msg[THINK_DURATION_KEY] = state.duration;
		}
		thinkingStates.delete(key);
	});
}

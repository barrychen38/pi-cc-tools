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
	truncateToWidth,
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	type Component,
} from "@earendil-works/pi-tui";

type TextBlock = { type: string; text?: string };
type TextResult = { content: readonly TextBlock[]; details?: unknown };
type RenderContext = {
	cwd: string;
	isPartial: boolean;
	isError: boolean;
	executionStarted?: boolean;
	args?: unknown;
	toolCallId?: string;
	invalidate?: () => void;
	lastComponent?: Component;
	state?: Record<PropertyKey, unknown>;
};

type BashRenderState = {
	startedAt?: number;
	endedAt?: number;
	interval?: NodeJS.Timeout;
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
const COLLAPSED_PREVIEW_LINES = 3;
const THINKING_TEXT_TRUECOLOR = "\x1b[38;2;165;173;203m";
const THINKING_TEXT_256COLOR = "\x1b[38;5;146m";
const GENERIC_RENDERER_PATCH = Symbol.for("pi-cc-tools:minimal-renderer");
const FIRST_MESSAGE_SPACER_PATCH = Symbol.for("pi-cc-tools:first-message-spacer");

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

const THINKING_PATCH = Symbol.for("pi-cc-tools:thinking-patch");
const ASSISTANT_CONTENT_PADDING_PATCH = Symbol.for("pi-cc-tools:assistant-content-padding");
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

function collectReferencedSkillBlocks(
	text: string,
	commands: readonly { name: string; source: string; sourceInfo: { path: string; baseDir?: string } }[],
): string[] {
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
	if (skills.size === 0) return [];

	const blocks: string[] = [];
	const seen = new Set<string>();
	for (const match of text.matchAll(SKILL_TOKEN_PATTERN)) {
		const skillName = match[2];
		if (!skillName || seen.has(skillName)) continue;
		const skill = skills.get(skillName);
		if (!skill) continue;
		seen.add(skillName);
		try {
			const body = stripSkillFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
			blocks.push(`<skill name="${skillName}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`);
		} catch {
			// Keep the user prompt unchanged if an optional skill file cannot be read.
		}
	}
	return blocks;
}

function buildReferencedSkillsSection(
	text: string,
	commands: readonly { name: string; source: string; sourceInfo: { path: string; baseDir?: string } }[],
): string | undefined {
	const blocks = collectReferencedSkillBlocks(text, commands);
	if (blocks.length === 0) return undefined;
	return `The user referenced these skills with $name tokens in their prompt. Apply the matching skill instructions while preserving the user's original wording as the task request.\n\n${blocks.join("\n\n")}`;
}

function createSkillTriggerProvider(current: AutocompleteProvider): AutocompleteProvider {
	return {
		triggerCharacters: [SKILL_TRIGGER],
		getSuggestions(lines, cursorLine, cursorCol, options) {
			return current.getSuggestions(lines, cursorLine, cursorCol, options);
		},
		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
		},
		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function patchSkillAutocomplete(): void {
	const editorPrototype = Editor.prototype as unknown as Record<PropertyKey, unknown>;
	const providerPrototype = CombinedAutocompleteProvider.prototype as unknown as Record<PropertyKey, unknown>;
	if (editorPrototype[SKILL_AUTOCOMPLETE_PATCH]) return;

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
		this.hiddenThinkingLabel = state?.active ? "Thinking…" : "Thought";

		// Thinking content stays collapsed by default and can still be expanded
		// through Pi's native thinking-block interaction.
		this.hideThinkingBlock = true;
		return original.call(this, message);
	};
	proto[THINKING_PATCH] = true;
}

function patchAssistantContentPadding(): void {
	const proto = AssistantMessageComponent.prototype as unknown as Record<PropertyKey, unknown>;
	if (proto[ASSISTANT_CONTENT_PADDING_PATCH]) return;

	const original = proto.updateContent as (message: Record<string, unknown>) => void | undefined;
	if (typeof original !== "function") return;

	proto.updateContent = function patchedAssistantContentPadding(this: {
		outputPad?: number;
	}, message: Record<string, unknown>) {
		// Pi 0.86 wraps thinking blocks in MouseRegion, so clearing padding on
		// direct children no longer reaches every rendered content component.
		this.outputPad = 0;
		return original.call(this, message);
	};
	proto[ASSISTANT_CONTENT_PADDING_PATCH] = true;
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

function usesTransparentToolShell(cwd: unknown): boolean {
	const mode = readSettings(typeof cwd === "string" ? cwd : process.cwd()).toolBackground;
	return mode !== undefined && mode !== "default";
}

function configureMinimalUi(ctx: ExtensionContext): void {
	if (!ctx.hasUI) return;
	applyThinkingTextColor(ctx.ui.theme);
	ctx.ui.setWorkingIndicator();
	ctx.ui.setWorkingMessage();
	ctx.ui.setWorkingVisible(true);
}

function emptyText(): Text {
	return toolText(EMPTY_TEXT);
}

function toolText(value: string): Text {
	return new Text(value, 0, 0);
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

function renderCallLine(
	label: string,
	summary: string,
	theme: Theme,
	context: RenderContext,
	note = "",
): Text {
	const title = theme.fg("toolTitle", theme.bold(label));
	const suffix = summary ? ` ${theme.fg("accent", summary)}` : "";
	return toolText(`${statusDot(context, theme)} ${title}${suffix}${note}`);
}

// Tool output is data, not terminal instructions. Keep only SGR styling;
// consume string controls (including unfinished streaming sequences) as a unit.
// Pi's stripTerminalSequences also removes colors, so it cannot be used here.
function safeResultText(text: string): string {
	return text.replace(
		/(?:\x1b\]|\x9d)[^\x07\x1b\x9c]*(?:\x07|\x1b\\|\x9c|$)|(?:\x1b[P_X^]|[\x90\x98\x9e\x9f])[^\x1b\x9c]*(?:\x1b\\|\x9c|$)|(?:\x1b\[|\x9b)[0-?]*[ -/]*(?:[@-~]|$)|\x1b[ -/]*(?:[0-~]|$)|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g,
		(sequence) => /^\x1b\[[0-9;:]*m$/.test(sequence) ? sequence : "",
	);
}

function textBlocks(result: TextResult): string[] {
	const blocks: string[] = [];
	for (const block of result.content) {
		if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
			blocks.push(safeResultText(block.text));
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

class WidthAwarePreview implements Component {
	private sourceLines: string[] = [];
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	setLines(lines: string[]): void {
		this.sourceLines = lines;
		this.invalidate();
	}

	render(width: number): string[] {
		if (this.cachedLines === undefined || this.cachedWidth !== width) {
			this.cachedWidth = width;
			this.cachedLines = this.sourceLines.map((line) => truncateToWidth(line, width, "…"));
		}
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}
}

function formatDuration(ms: number): string {
	return `${(ms / 1000).toFixed(1)}s`;
}

function bashState(context: RenderContext): BashRenderState {
	context.state ??= {};
	return context.state as BashRenderState;
}

function branchLines(content: string[], theme: Theme): string[] {
	const rule = theme.fg("borderMuted", "│");
	return content.map((line) => `${rule} ${line}`);
}

function previewComponent(lines: string[], context: RenderContext): Component {
	const component = context.lastComponent instanceof WidthAwarePreview
		? context.lastComponent
		: new WidthAwarePreview();
	component.setLines(lines);
	return component;
}

function previewTextLines(result: TextResult): string[] {
	return textBlocks(result)
		.join("\n")
		.replace(/\r/g, "")
		.split("\n")
		.filter((line) => line.trim().length > 0);
}

function collapsedPreview(result: TextResult, theme: Theme, context: RenderContext): Component | undefined {
	const allLines = previewTextLines(result);
	if (allLines.length === 0) return undefined;
	const lines = branchLines(allLines
		.slice(0, COLLAPSED_PREVIEW_LINES)
		.map((line) => theme.fg("muted", line)), theme);
	if (allLines.length > COLLAPSED_PREVIEW_LINES) {
		const hidden = allLines.length - COLLAPSED_PREVIEW_LINES;
		lines.push(theme.fg("dim", `  … +${hidden} line${hidden === 1 ? "" : "s"} (ctrl+o to expand)`));
	}

	const state = context.state as BashRenderState | undefined;
	if (state?.startedAt !== undefined && state.endedAt !== undefined) {
		lines.push(theme.fg("dim", `  took ${formatDuration(state.endedAt - state.startedAt)}`));
	}
	return previewComponent(lines, context);
}

function liveTailPreview(result: TextResult, theme: Theme, context: RenderContext): Component | undefined {
	const allLines = previewTextLines(result);
	if (allLines.length === 0) return undefined;
	const lines = allLines.length > COLLAPSED_PREVIEW_LINES ? [theme.fg("dim", "  …")] : [];
	lines.push(...branchLines(allLines.slice(-COLLAPSED_PREVIEW_LINES).map((line) => theme.fg("muted", line)), theme));
	return previewComponent(lines, context);
}

function branchBlock(content: string, theme: Theme): string {
	return branchLines(content.split("\n"), theme).join("\n");
}

function renderMinimalResult(
	result: TextResult,
	expanded: boolean,
	theme: Theme,
	context: RenderContext,
): Component {
	if (context.isPartial) return liveTailPreview(result, theme, context) ?? emptyText();

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
		return collapsedPreview(result, theme, context) ?? emptyText();
	}

	const raw = expandedText(result, maxLines);
	if (!raw) return emptyText();
	return toolText(branchBlock(theme.fg("toolOutput", raw), theme));
}

type DiffSummary = { added: number; removed: number; newFile: boolean };

const WRITE_EDIT_DETAILS_KEY = "piCcTools";
type WriteEditDetails = {
	diffSummary?: DiffSummary;
	renderedDiff?: string;
};
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
	const details = result.details && typeof result.details === "object" && !Array.isArray(result.details)
		? result.details as Record<string, unknown>
		: {};
	const previous = details[WRITE_EDIT_DETAILS_KEY];
	const extensionDetails: WriteEditDetails = previous && typeof previous === "object" && !Array.isArray(previous)
		? { ...(previous as WriteEditDetails), diffSummary: summary }
		: { diffSummary: summary };
	if (renderedDiff) extensionDetails.renderedDiff = renderedDiff;
	details[WRITE_EDIT_DETAILS_KEY] = extensionDetails;
	if (diff) details.diff = diff;
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
	if (!result.details || typeof result.details !== "object" || Array.isArray(result.details)) return undefined;
	const extensionDetails = (result.details as Record<string, unknown>)[WRITE_EDIT_DETAILS_KEY];
	return extensionDetails && typeof extensionDetails === "object" && !Array.isArray(extensionDetails)
		? (extensionDetails as WriteEditDetails).renderedDiff
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
	if (!result.details || typeof result.details !== "object" || Array.isArray(result.details)) return undefined;
	const extensionDetails = (result.details as Record<string, unknown>)[WRITE_EDIT_DETAILS_KEY];
	return extensionDetails && typeof extensionDetails === "object" && !Array.isArray(extensionDetails)
		? (extensionDetails as WriteEditDetails).diffSummary
		: undefined;
}

function renderWriteEditResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
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
		const safeDiff = safeResultText(diff);
		const diffOutput = renderedDiff(result) ? takeLines(safeDiff, maxLines).text : colorDiffText(safeDiff, theme, maxLines);
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
): Component {
	return renderMinimalResult(result, options.expanded, theme, context);
}

function renderBashResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Component {
	const state = bashState(context);
	if (state.startedAt !== undefined && context.isPartial && state.interval === undefined) {
		state.interval = setInterval(() => context.invalidate?.(), 1_000);
	}
	if (state.startedAt !== undefined && (!context.isPartial || context.isError)) {
		state.endedAt ??= Date.now();
		if (state.interval !== undefined) {
			clearInterval(state.interval);
			state.interval = undefined;
		}
	}
	return renderBuiltinResult(result, options, theme, context);
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
): Component {
	if (context.isPartial) {
		const first = firstTextLine(result);
		if (!first || first === "Tool failed") return emptyText();
		return previewComponent(branchLines([theme.fg("muted", truncateToWidth(first, 120, "..."))], theme), context);
	}

	if (context.isError) {
		const raw = options.expanded
			? expandedText(result, DEFAULT_EXPANDED_LINES)
			: firstTextLine(result);
		if (!raw) return emptyText();
		return toolText(branchBlock(theme.fg("error", raw), theme));
	}

	if (!options.expanded) {
		return collapsedPreview(result, theme, context) ?? emptyText();
	}

	const raw = expandedText(result, DEFAULT_EXPANDED_LINES);
	if (!raw) return emptyText();
	return toolText(branchBlock(theme.fg("toolOutput", raw), theme));
}

const BUILT_IN_TOOL_NAMES = new Set(["read", "bash", "write", "edit", "find", "grep", "ls"]);
const NATIVE_RENDERER_TOOL_NAMES = new Set([...BUILT_IN_TOOL_NAMES, "Agent"]);
const GENERIC_RENDERER_PATCH_VERSION = 4;

type ToolRenderer = (...args: never[]) => Component;
type RendererMethod = (this: { toolName?: unknown }) => ToolRenderer | undefined;
type ShellMethod = (this: { toolName?: unknown; cwd?: unknown }) => unknown;

interface GenericRendererPatchState {
	version: number;
	originalShell: ShellMethod;
	originalCall: RendererMethod;
	originalResult: RendererMethod;
	wrappedShell: ShellMethod;
	wrappedCall: RendererMethod;
	wrappedResult: RendererMethod;
}

function keepsOwnRenderer(name: string): boolean {
	return NATIVE_RENDERER_TOOL_NAMES.has(name) || name === "todo";
}

function isGenericRendererPatchState(value: unknown): value is GenericRendererPatchState {
	if (typeof value !== "object" || value === null) return false;
	const state = value as Partial<GenericRendererPatchState>;
	return (
		typeof state.version === "number" &&
		typeof state.originalShell === "function" &&
		typeof state.originalCall === "function" &&
		typeof state.originalResult === "function" &&
		typeof state.wrappedShell === "function" &&
		typeof state.wrappedCall === "function" &&
		typeof state.wrappedResult === "function"
	);
}

function patchUnknownToolRendering(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
	const previous = prototype[GENERIC_RENDERER_PATCH];
	if (isGenericRendererPatchState(previous)) {
		const wrappersAreCurrent =
			prototype.getRenderShell === previous.wrappedShell &&
			prototype.getCallRenderer === previous.wrappedCall &&
			prototype.getResultRenderer === previous.wrappedResult;
		if (!wrappersAreCurrent || previous.version === GENERIC_RENDERER_PATCH_VERSION) return;
		prototype.getRenderShell = previous.originalShell;
		prototype.getCallRenderer = previous.originalCall;
		prototype.getResultRenderer = previous.originalResult;
	} else if (previous !== undefined) {
		// A legacy or foreign patch owns the prototype. A process restart will
		// install this version without stacking wrappers during hot reload.
		return;
	}

	const originalShellValue = prototype.getRenderShell;
	const originalCallValue = prototype.getCallRenderer;
	const originalResultValue = prototype.getResultRenderer;
	if (
		typeof originalShellValue !== "function" ||
		typeof originalCallValue !== "function" ||
		typeof originalResultValue !== "function"
	) return;

	const originalShell = originalShellValue as ShellMethod;
	const originalCall = originalCallValue as RendererMethod;
	const originalResult = originalResultValue as RendererMethod;

	const wrappedShell: ShellMethod = function (this: { toolName?: unknown; cwd?: unknown }) {
		const name = typeof this.toolName === "string" ? this.toolName : "tool";
		if (name === "Agent") return Reflect.apply(originalShell, this, []);
		if (name === "todo" || usesTransparentToolShell(this.cwd)) return "self";
		if (NATIVE_RENDERER_TOOL_NAMES.has(name)) return Reflect.apply(originalShell, this, []);

		const callRenderer = Reflect.apply(originalCall, this, []) as ToolRenderer | undefined;
		const resultRenderer = Reflect.apply(originalResult, this, []) as ToolRenderer | undefined;
		if (callRenderer || resultRenderer) return Reflect.apply(originalShell, this, []);
		return "self";
	};

	const wrappedCall: RendererMethod = function (this: { toolName?: unknown }) {
		const name = typeof this.toolName === "string" ? this.toolName : "tool";
		const renderer = Reflect.apply(originalCall, this, []) as ToolRenderer | undefined;
		if (renderer) return renderer;
		if (keepsOwnRenderer(name)) return undefined;
		return (args: unknown, theme: Theme, context: RenderContext) =>
			renderCallLine(genericLabel(name), genericSummary(args), theme, context);
	};

	const wrappedResult: RendererMethod = function (this: { toolName?: unknown }) {
		const name = typeof this.toolName === "string" ? this.toolName : "tool";
		const renderer = Reflect.apply(originalResult, this, []) as ToolRenderer | undefined;
		if (renderer) return renderer;
		if (keepsOwnRenderer(name)) return undefined;
		return (result: TextResult, options: { expanded: boolean }, theme: Theme, context: RenderContext) =>
			renderGenericResult(result, options, theme, context);
	};

	prototype.getRenderShell = wrappedShell;
	prototype.getCallRenderer = wrappedCall;
	prototype.getResultRenderer = wrappedResult;
	Object.defineProperty(prototype, GENERIC_RENDERER_PATCH, {
		configurable: true,
		writable: true,
		value: {
			version: GENERIC_RENDERER_PATCH_VERSION,
			originalShell,
			originalCall,
			originalResult,
			wrappedShell,
			wrappedCall,
			wrappedResult,
		} satisfies GenericRendererPatchState,
	});
}

function registerBuiltInTools(pi: ExtensionAPI): void {
	const cwd = process.cwd();
	const tools = getBuiltInTools(cwd);

	pi.registerTool({
		...tools.read,
		label: "read",
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
		...tools.bash,
		label: "bash",
		renderShell: "self",
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			return getBuiltInTools(ctx.cwd).bash.execute(toolCallId, params, signal, onUpdate);
		},
		renderCall(args, theme, context) {
			const state = bashState(context);
			if (context.executionStarted && state.startedAt === undefined) {
				state.startedAt = Date.now();
				state.endedAt = undefined;
			}
			const command = oneLine(stringArg(args, "command"), 96) || "...";
			const timeout = numberArg(args, "timeout");
			const suffix = timeout === undefined ? "" : ` (timeout ${timeout}s)`;
			const note = context.isPartial && state.startedAt !== undefined
				? ` ${theme.fg("dim", `(${formatDuration(Date.now() - state.startedAt)})`)}`
				: "";
			return renderCallLine("Bash", `$ ${command}${suffix}`, theme, context, note);
		},
		renderResult: renderBashResult,
	});

	pi.registerTool({
		...tools.grep,
		label: "grep",
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
		...tools.find,
		label: "find",
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
		...tools.ls,
		label: "ls",
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
		...tools.write,
		label: "write",
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
		...tools.edit,
		label: "edit",
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
	patchUnknownToolRendering();
	patchAssistantThinkingLabel();
	patchAssistantContentPadding();
	registerBuiltInTools(pi);

	pi.on("session_start", async (_event, ctx) => {
		resetSettingsCache();
		thinkingStates.clear();
		ctx.ui.addAutocompleteProvider(createSkillTriggerProvider);
		configureMinimalUi(ctx);
	});
	pi.on("before_agent_start", async (event, ctx) => {
		resetSettingsCache();
		configureMinimalUi(ctx);
		const section = typeof event.prompt === "string" && event.prompt.includes(SKILL_TRIGGER)
			? buildReferencedSkillsSection(event.prompt, pi.getCommands())
			: undefined;
		const sections = event.systemPromptOptions?.sections;
		if (sections) {
			if (section) sections.referenced_skills = section;
			else delete sections.referenced_skills;
			return;
		}
		// Compatibility fallback for Pi versions before structured prompt options.
		if (section && typeof event.systemPrompt === "string") {
			return { systemPrompt: `${event.systemPrompt}\n\n<referenced_skills>\n${section}\n</referenced_skills>` };
		}
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

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

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
import { Spacer, Text, type Component } from "@earendil-works/pi-tui";

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

type SettingsFile = {
	toolBackground?: "default" | "transparent" | "outlines" | "border";
	expandedPreviewMaxLines?: number;
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

type SubagentStatus = "queued" | "running" | "background" | "completed" | "failed" | "stopped";
type SubagentState = {
	toolCallId: string;
	type: string;
	description: string;
	startedAt: number;
	completedAt?: number;
	durationMs?: number;
	status: SubagentStatus;
	model?: string;
	activity?: string;
	toolUses?: number;
	agentId?: string;
	error?: string;
	backgroundRequested?: boolean;
	invalidate?: () => void;
};
type SubagentEvent = Record<string, unknown>;

const subagentStates = new Map<string, SubagentState>();
const subagentByAgentId = new Map<string, string>();
let subagentTimer: ReturnType<typeof setInterval> | undefined;

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

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function finiteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function compactModel(value: unknown): string | undefined {
	let raw: string | undefined;
	if (typeof value === "string") {
		raw = value;
	} else {
		const record = asRecord(value);
		const name = record?.name;
		const id = record?.id;
		raw = typeof name === "string" && name.trim() ? name : typeof id === "string" ? id : undefined;
	}
	if (!raw) return undefined;

	const slash = raw.lastIndexOf("/");
	const short = (slash >= 0 ? raw.slice(slash + 1) : raw)
		.replace(/^Claude\s+/i, "")
		.replace(/\s+\([^)]*\)$/, "")
		.replace(/[-_]\d{8,}$/, "")
		.trim()
		.toLowerCase();
	return short ? oneLine(short, 32) : undefined;
}

function subagentType(args: unknown): string {
	return stringArg(args, "subagent_type") || stringArg(args, "type") || "Agent";
}

function subagentDescription(args: unknown): string {
	return oneLine(stringArg(args, "description"), 36);
}

function isSubagentActive(state: SubagentState): boolean {
	return state.status === "queued" || state.status === "running" || state.status === "background";
}

function stopSubagentTimer(): void {
	if (!subagentTimer) return;
	clearInterval(subagentTimer);
	subagentTimer = undefined;
}

function ensureSubagentTimer(): void {
	if (subagentTimer) return;
	// Keep duration live with one low-frequency timer scoped to active agents.
	subagentTimer = setInterval(() => {
		let active = false;
		for (const state of subagentStates.values()) {
			if (!isSubagentActive(state)) continue;
			active = true;
			state.invalidate?.();
		}
		if (!active) stopSubagentTimer();
	}, 1_000);
	(subagentTimer as unknown as { unref?: () => void }).unref?.();
}

function refreshSubagentTimer(): void {
	if ([...subagentStates.values()].some(isSubagentActive)) ensureSubagentTimer();
	else stopSubagentTimer();
}

function resetSubagentTracking(): void {
	subagentStates.clear();
	subagentByAgentId.clear();
	stopSubagentTimer();
}

function createSubagentState(
	toolCallId: string,
	args: unknown,
	status: SubagentStatus,
	model?: string,
	store = true,
): SubagentState {
	const state: SubagentState = {
		toolCallId,
		type: subagentType(args),
		description: subagentDescription(args),
		startedAt: Date.now(),
		status,
		model: model ?? compactModel(stringArg(args, "model")),
		backgroundRequested: asRecord(args)?.run_in_background === true,
	};
	if (store) subagentStates.set(toolCallId, state);
	return state;
}

function linkSubagentAgent(state: SubagentState, agentId: string): void {
	state.agentId = agentId;
	subagentByAgentId.set(agentId, state.toolCallId);
}

function terminalSubagentStatus(status: unknown): SubagentStatus | undefined {
	if (status === "error" || status === "aborted") return "failed";
	if (status === "stopped") return "stopped";
	if (status === "completed" || status === "steered") return "completed";
	return undefined;
}

function applySubagentDetails(state: SubagentState, details: unknown): void {
	const value = asRecord(details);
	if (!value) return;

	const model = compactModel(value.modelName);
	if (model) state.model = model;
	if (typeof value.activity === "string" && value.activity.trim()) {
		state.activity = oneLine(value.activity, 44);
	}
	const toolUses = finiteNumber(value.toolUses);
	if (toolUses !== undefined) state.toolUses = Math.max(0, Math.floor(toolUses));
	const durationMs = finiteNumber(value.durationMs);
	if (durationMs !== undefined && (durationMs > 0 || terminalSubagentStatus(value.status))) {
		state.durationMs = Math.max(0, durationMs);
	}
	if (typeof value.agentId === "string" && value.agentId) linkSubagentAgent(state, value.agentId);
	if (typeof value.error === "string" && value.error.trim()) state.error = oneLine(value.error, 56);

	if (value.status === "queued") state.status = "queued";
	else if (value.status === "running") state.status = "running";
	else if (value.status === "background") {
		if (state.status !== "running" && state.status !== "queued") state.status = "background";
	}
	else {
		const terminal = terminalSubagentStatus(value.status);
		if (terminal) {
			state.status = terminal;
			state.completedAt ??= Date.now();
		}
	}
}

function subagentEventState(event: SubagentEvent): SubagentState | undefined {
	const agentId = typeof event.id === "string" ? event.id : undefined;
	const mappedToolCallId = agentId ? subagentByAgentId.get(agentId) : undefined;
	if (mappedToolCallId) return subagentStates.get(mappedToolCallId);

	const type = typeof event.type === "string" ? event.type : undefined;
	const description = typeof event.description === "string" ? event.description : undefined;
	const active = [...subagentStates.values()].filter((state) => isSubagentActive(state) && !state.agentId);
	const shortDescription = description ? oneLine(description, 36) : undefined;
	const exact = active.filter((state) =>
		(!type || state.type === type) && (!shortDescription || state.description === shortDescription),
	);
	const descriptionMatches = shortDescription
		? active.filter((state) => state.description === shortDescription)
		: [];
	const typeMatches = type ? active.filter((state) => state.type === type) : [];
	const candidate = exact.length === 1
		? exact[0]
		: descriptionMatches.length === 1
			? descriptionMatches[0]
			: typeMatches.length === 1
				? typeMatches[0]
				: active.length === 1
					? active[0]
					: undefined;
	if (!candidate) return undefined;
	if (agentId) linkSubagentAgent(candidate, agentId);
	return candidate;
}

function applySubagentLifecycle(channel: string, event: SubagentEvent): void {
	const state = subagentEventState(event);
	if (!state) return;

	if (channel === "subagents:created") {
		if (state.status !== "running") state.status = "queued";
	}
	else if (channel === "subagents:started") {
		if (state.status === "queued" || state.status === "background") state.startedAt = Date.now();
		state.status = "running";
	}
	else if (channel === "subagents:completed") state.status = "completed";
	else if (channel === "subagents:failed") state.status = terminalSubagentStatus(event.status) ?? "failed";
	else return;

	const toolUses = finiteNumber(event.toolUses);
	if (toolUses !== undefined) state.toolUses = Math.max(0, Math.floor(toolUses));
	const durationMs = finiteNumber(event.durationMs);
	if (durationMs !== undefined) state.durationMs = Math.max(0, durationMs);
	if (typeof event.error === "string" && event.error.trim()) state.error = oneLine(event.error, 56);
	if (!isSubagentActive(state)) state.completedAt ??= Date.now();
	state.invalidate?.();
	refreshSubagentTimer();
}

function extractResultError(result: unknown): string | undefined {
	const record = asRecord(result);
	if (!Array.isArray(record?.content)) return undefined;
	const blocks = record.content.filter((block): block is TextBlock => {
		const value = asRecord(block);
		return typeof value?.type === "string" && typeof value.text === "string";
	});
	if (blocks.length === 0) return undefined;
	return firstTextLine({ content: blocks });
}

function updateSubagentResult(
	toolCallId: string,
	args: unknown,
	result: unknown,
	isPartial: boolean,
	isError: boolean,
	context: RenderContext,
): void {
	const state = subagentStates.get(toolCallId) ?? createSubagentState(
		toolCallId,
		args,
		isPartial ? "running" : isError ? "failed" : "completed",
		undefined,
	);
	state.invalidate = context.invalidate;
	const record = asRecord(result);
	applySubagentDetails(state, record?.details);

	if (isError) {
		state.status = "failed";
		state.error = extractResultError(result) ?? state.error;
		state.completedAt ??= Date.now();
	} else if (isPartial) {
		if (isSubagentActive(state)) state.status = "running";
	} else if (
		asRecord(record?.details)?.status === "background" ||
		state.status === "background" ||
		state.backgroundRequested && record?.details === undefined
	) {
		if (state.status !== "running" && state.status !== "queued") state.status = "background";
	} else if (state.status !== "failed" && state.status !== "stopped") {
		state.status = "completed";
		state.completedAt ??= Date.now();
	}

	refreshSubagentTimer();
}

function formatSubagentDuration(state: SubagentState): string {
	const elapsed = state.durationMs ?? Math.max(0, (state.completedAt ?? Date.now()) - state.startedAt);
	return `${(elapsed / 1_000).toFixed(1)}s`;
}

function subagentStatusLabel(state: SubagentState): string {
	if (state.status === "queued") return "queued";
	if (state.status === "running") return state.activity ?? "working…";
	if (state.status === "background") return state.activity ?? "background";
	if (state.status === "completed") return "done";
	if (state.status === "stopped") return "stopped";
	return state.error ? `failed: ${state.error}` : "failed";
}

function renderSubagentCall(args: unknown, theme: Theme, context: RenderContext): Text {
	const toolCallId = context.toolCallId ?? "subagent";
	const state = subagentStates.get(toolCallId) ?? createSubagentState(
		toolCallId,
		args,
		context.isPartial ? "running" : context.isError ? "failed" : "completed",
		undefined,
		false,
	);
	state.invalidate = context.invalidate;
	const titleText = state.type === "Agent" ? "Agent" : `Agent ${state.type}`;
	const title = theme.fg("toolTitle", theme.bold(titleText));
	const parts = [state.description, state.model ?? "model?", formatSubagentDuration(state)];
	if (state.toolUses && state.toolUses > 0) parts.push(`${state.toolUses} tools`);
	parts.push(subagentStatusLabel(state));
	const icon = state.status === "failed" ? "✗" : state.status === "completed" ? "●" : "○";
	const iconColor = state.status === "failed" ? "error" : state.status === "completed" ? "success" : "muted";
	const summaryColor = state.status === "failed" ? "error" : "accent";
	return toolText(`${theme.fg(iconColor, icon)} ${title} ${theme.fg(summaryColor, parts.filter(Boolean).join(" · "))}`);
}

function renderSubagentResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	const toolCallId = context.toolCallId ?? "subagent";
	updateSubagentResult(toolCallId, context.args, result, context.isPartial, context.isError, context);
	if (context.isPartial || !options.expanded) return emptyText();

	const raw = expandedText(result, DEFAULT_EXPANDED_LINES);
	if (!raw) return emptyText();
	return toolText(branchBlock(theme.fg(context.isError ? "error" : "toolOutput", raw), theme));
}

function registerSubagentTracking(pi: ExtensionAPI): void {
	pi.on("tool_execution_start", async (event, ctx) => {
		if (ctx.hasUI === false) return;
		if (event.toolName !== "Agent") return;
		const backgroundRequested = asRecord(event.args)?.run_in_background === true;
		const state = subagentStates.get(event.toolCallId) ?? createSubagentState(
			event.toolCallId,
			event.args,
			backgroundRequested ? "queued" : "running",
			compactModel(stringArg(event.args, "model")) ?? compactModel(ctx.model),
		);
		state.type = subagentType(event.args);
		state.description = subagentDescription(event.args);
		state.backgroundRequested = backgroundRequested;
		if (backgroundRequested && state.status === "running") state.status = "queued";
		state.model ??= compactModel(ctx.model);
		ensureSubagentTimer();
	});

	pi.on("tool_execution_update", async (event, _ctx) => {
		if (_ctx.hasUI === false) return;
		if (event.toolName !== "Agent") return;
		const result = event.partialResult as unknown;
		updateSubagentResult(event.toolCallId, event.args, result, true, false, {
			cwd: process.cwd(),
			isPartial: true,
			isError: false,
		});
	});

	pi.on("tool_execution_end", async (event, _ctx) => {
		if (_ctx.hasUI === false) return;
		if (event.toolName !== "Agent") return;
		const state = subagentStates.get(event.toolCallId);
		if (!state) return;
		updateSubagentResult(event.toolCallId, {}, event.result, false, event.isError, {
			cwd: process.cwd(),
			isPartial: false,
			isError: event.isError,
		});
	});

	const events = (pi as unknown as {
		events?: { on?: (channel: string, handler: (data: unknown) => void) => unknown };
	}).events;
	if (!events?.on) return;
	// pi-subagents publishes background lifecycle events on Pi's shared bus.
	for (const channel of ["subagents:created", "subagents:started", "subagents:completed", "subagents:failed"]) {
		events.on(channel, (data) => applySubagentLifecycle(channel, asRecord(data) ?? {}));
	}
}

const THINKING_PATCH = Symbol.for("pi-cc-tools:thinking-patch");

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
const MAX_LINE_DIFF_CELLS = 1_000_000;

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

function attachDiffSummary(result: TextResult, summary: DiffSummary): void {
	const details = result.details && typeof result.details === "object" ? result.details : {};
	(details as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] = summary;
	(result as { details?: unknown }).details = details;
}

function renderWriteEditResult(
	result: TextResult,
	options: { expanded: boolean },
	theme: Theme,
	context: RenderContext,
): Text {
	if (context.isPartial) return emptyText();

	const summary = result.details && typeof result.details === "object"
		? (result.details as Record<PropertyKey, unknown>)[WRITE_EDIT_DIFF] as DiffSummary | undefined
		: undefined;

	if (context.isError) {
		const raw = options.expanded
			? expandedText(result, DEFAULT_EXPANDED_LINES)
			: firstTextLine(result);
		if (!raw) return emptyText();
		return toolText(branchBlock(theme.fg("error", raw), theme));
	}

	if (!options.expanded) {
		if (!summary) return renderMinimalResult(result, options.expanded, theme, context);
		const parts: string[] = [];
		if (summary.newFile) parts.push(theme.fg("muted", "new file"));
		if (summary.added > 0) parts.push(theme.fg("success", `+${summary.added}`));
		if (summary.removed > 0) parts.push(theme.fg("error", `-${summary.removed}`));
		if (summary.added === 0 && summary.removed === 0) parts.push(theme.fg("muted", "unchanged"));
		if (parts.length === 0) return emptyText();
		return toolText(branchBlock(parts.join(" "), theme));
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

function keepsOwnRenderer(name: string): boolean {
	return BUILT_IN_TOOL_NAMES.has(name) || name === "todo";
}

function patchUnknownToolRendering(): void {
	const prototype = ToolExecutionComponent.prototype as unknown as Record<PropertyKey, unknown>;
	if (prototype[GENERIC_RENDERER_PATCH]) return;

	const originalShell = prototype.getRenderShell;
	if (typeof originalShell === "function") {
		prototype.getRenderShell = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (!BUILT_IN_TOOL_NAMES.has(name)) return "self";
			return Reflect.apply(originalShell, this, []);
		};
	}

	const originalCall = prototype.getCallRenderer;
	if (typeof originalCall === "function") {
		prototype.getCallRenderer = function (this: { toolName?: unknown }) {
			const name = typeof this.toolName === "string" ? this.toolName : "tool";
			if (name === "Agent") {
				return (args: unknown, theme: Theme, context: RenderContext) =>
					renderSubagentCall(args, theme, context);
			}
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
			if (name === "Agent") {
				return (result: TextResult, options: { expanded: boolean }, theme: Theme, context: RenderContext) =>
					renderSubagentResult(result, options, theme, context);
			}
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

			const result = await getBuiltInTools(ctx.cwd).write.execute(toolCallId, params, signal, onUpdate);

			attachDiffSummary(result, summarizeTextChange(previousContent, stringArg(params, "content"), !existed));
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
			if (summary) attachDiffSummary(result, summary);
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
	patchFirstMessageSpacing();
	patchEmptyWidgetSpacing();
	patchTodoWidgetIndent();
	patchUnknownToolRendering();
	patchAssistantThinkingLabel();
	registerBuiltInTools(pi);
	registerSubagentTracking(pi);

	pi.on("session_start", async (_event, ctx) => {
		thinkingStates.clear();
		if (ctx.hasUI) resetSubagentTracking();
		configureMinimalUi(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		configureMinimalUi(ctx);
	});
	pi.on("agent_start", async (_event, ctx) => {
		configureMinimalUi(ctx);
	});
	pi.on("turn_start", async (_event, ctx) => {
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

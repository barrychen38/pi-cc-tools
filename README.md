# pi-claude-style-tools

Compact Pi tool rendering with the existing Claude-style colors, labels, status dots, and branch styling.

## Behavior

- Built-in tools keep one compact call row: `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit`.
- A quiet new session keeps one blank row above its first user message.
- Assistant text, thinking labels, tool calls/results, custom tools, todo panels, and subagent panels render without left indentation so they can use the full terminal width.
- Collapsed successful results show the first 3 non-empty, width-bounded output lines in muted gray plus a dim `… +N lines (ctrl+o to expand)` hint; file-changing `write` and `edit` results show `+N -N` plus a bounded compact diff preview.
- Running `bash` tools show a live 3-line non-empty tail preview and elapsed time; completed rows retain a dim duration.
- Failed tool results keep only the first error line visible.
- `Ctrl+O` can still expand a tool result; expanded output is plain text and capped at `expandedPreviewMaxLines`.
- MCP and unknown custom tools use the same unboxed compact fallback renderer and show the first partial progress line while running.
- `Agent` / subagent tools keep their own registered renderers and native background; other tools remain transparent in non-default background modes.
- Thinking content stays hidden; streaming updates show `Thinking for 1.2s`, then collapse to `Thought for 1.2s` in Catppuccin Macchiato Subtext 0 (`#a5adcb`).
- Pi's native working indicator remains visible while the agent is streaming or running a long tool, then removes its row while retaining the native one-line gap above the editor.
- Syntax highlighting, grouping, turn-time text, and custom spinners are disabled.
- Tool execution is delegated to Pi's built-in tools without changing their behavior.

The extension does not load a syntax highlighter or add a general-purpose refresh timer. `write` reads the previous file once to calculate its bounded line-count summary and diff preview; `edit` reuses Pi's existing result metadata for the same output shape.

## Configuration

Pi reads global settings from `~/.pi/agent/settings.json` and project settings from `.pi/settings.json`. Project settings take precedence.

```json
{
  "toolBackground": "transparent",
  "expandedPreviewMaxLines": 2000,
  "diffRenderer": "plain"
}
```

`toolBackground` accepts `default`, `transparent`, `outlines`, or the legacy alias `border`. In non-default modes, the compact renderer removes full-width background fills from tools other than `Agent`; subagent output keeps its native status background. The renderer intentionally does not add border rows to the hot path.

`diffRenderer` accepts `plain` (default), `delta`, or `auto`. `delta` / `auto` use a local `delta` executable for compact `write` / `edit` diff previews during tool execution, with file headers, hunk headers, and delta line-number columns omitted. Catppuccin Macchiato diff colors are passed explicitly when `diffTheme` is `catppuccin-macchiato`. Rendering has a timeout and automatic fallback to plain diff when unavailable.

Pi's own settings can be used alongside this extension to keep startup and thinking output quiet:

```json
{
  "quietStartup": true,
  "hideThinkingBlock": true,
  "outputPad": 0
}
```

## Development

```sh
npm test
npm run typecheck
npm run bench:tools -- baseline 120 12 8
npm run bench:tools -- minimal 120 12 8
```

The extension is verified against Pi 0.86.0 and preserves built-in tool metadata such as constrained sampling and argument preparation when installing compact renderers. Referenced `$skill` instructions use transcript-aware prompt sections on supported Pi versions. Small component-level fallbacks keep MCP/custom tool shells compact and replace thinking content with an elapsed-time label.

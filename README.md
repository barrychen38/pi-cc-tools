# pi-claude-style-tools

Compact Pi tool rendering with the existing Claude-style colors, labels, status dots, and branch styling.

## Behavior

- Built-in tools keep one compact call row: `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit`.
- A quiet new session keeps one blank row above its first user message.
- Tool calls, results, custom tools, the `rpiv-todo` panel, and subagent status/fleet panels use a consistent two-column left indent.
- Collapsed successful results show a line count; file-changing `write` and `edit` results show `+N -N` plus a bounded compact diff preview.
- Failed tool results keep only the first error line visible.
- `Ctrl+O` can still expand a tool result; expanded output is plain text and capped at `expandedPreviewMaxLines`.
- MCP and unknown custom tools use the same unboxed compact fallback renderer.
- `Agent` / subagent tools keep their own registered renderers and output style unchanged.
- Thinking content stays hidden; streaming updates show `Thinking for 1.2s`, then collapse to `Thought for 1.2s` in Catppuccin Macchiato Subtext 0 (`#a5adcb`).
- Pi's native working indicator remains visible while the agent is streaming or running a long tool, then removes its row and the empty widget spacer when the run ends.
- Tool-output live previews, syntax highlighting, grouping, turn-time text, and custom spinners are disabled.
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

`toolBackground` accepts `default`, `transparent`, `outlines`, or the legacy alias `border`. The compact renderer removes full-width background fills for the non-default modes; it intentionally does not add border rows to the hot path.

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

The extension uses Pi's public `registerTool`, `renderCall`, and `renderResult` interfaces. Small component-level fallbacks keep MCP/custom tool shells compact and replace thinking content with an elapsed-time label.

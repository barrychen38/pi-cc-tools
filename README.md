# pi-claude-style-tools

Compact Pi tool rendering with the existing Claude-style colors, labels, status dots, and branch styling.

## Behavior

- Built-in tools keep one compact call row: `read`, `bash`, `grep`, `find`, `ls`, `write`, and `edit`.
- Tool calls, results, custom tools, and the `rpiv-todo` panel use a consistent two-column left indent.
- Collapsed successful results show a line count; `write` and `edit` show only `+N -N`.
- Failed tool results keep only the first error line visible.
- `Ctrl+O` can still expand a tool result; expanded output is plain text and capped at `expandedPreviewMaxLines`.
- MCP and unknown custom tools use the same unboxed compact fallback renderer.
- Thinking content stays hidden; streaming updates show `Thinking for 1.2s`, then collapse to `Thought for 1.2s` in Catppuccin Macchiato Subtext 0 (`#a5adcb`).
- Tool-output live previews, diff content, syntax highlighting, grouping, turn-time text, and custom spinners are disabled.
- Tool execution is delegated to Pi's built-in tools without changing their behavior.

The render path does not load a syntax highlighter, render diff content, or run a refresh timer. `write` reads the previous file once to calculate its bounded line-count summary; `edit` reuses Pi's existing result metadata.

## Configuration

Pi reads global settings from `~/.pi/agent/settings.json` and project settings from `.pi/settings.json`. Project settings take precedence.

```json
{
  "toolBackground": "transparent",
  "expandedPreviewMaxLines": 2000
}
```

`toolBackground` accepts `default`, `transparent`, `outlines`, or the legacy alias `border`. The compact renderer removes full-width background fills for the non-default modes; it intentionally does not add border rows to the hot path.

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

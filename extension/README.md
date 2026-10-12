# byCLI Browser Bridge Extension

The extension connects Chrome tabs to the local byCLI daemon. It uses Chrome
extension APIs only as a transport and browser-control layer for explicit CLI
commands.

## Permission Notes

- `debugger`: sends CDP commands to byCLI-controlled or bound tabs.
- `tabs` / `tabGroups`: manages the dedicated byCLI automation container and
  reports selected tab metadata back to the CLI.
- `system.display`: reads logical display work areas so owned windows fit the
  usable screen space, including headless virtual displays. It does not change
  display settings.
- `cookies`: reads cookies for browser-backed adapters that need authenticated
  fetches.
- `downloads`: surfaces download lifecycle to `bycli browser wait download`.
  The extension observes started / in-progress / completed / failed downloads so
  the CLI can wait for a file triggered by an automation command. byCLI
  filters by the command's filename/URL pattern and timeout, and does not modify,
  redirect, or persist browser download history.

## Owned Window Placement

New byCLI windows use up to 1280 × 900 logical pixels, capped by the selected
display's work area. The last-focused normal Chrome window selects the display;
the primary display is the fallback. Existing owned normal windows stay on the
display with their largest intersection, keeping smaller sizes and positions
that already fit. Bounds are corrected on reuse, lease restoration and display
changes without changing focus. Borrowed user windows and minimized, maximized
or fullscreen window states are preserved.
Dragging an owned tab into a user window does not transfer window ownership
during lease restoration. A move, resize or state change while display metadata
is being read also takes precedence over that pending correction.

If display metadata is unavailable, byCLI logs a warning. New windows use
Chrome's natural size and placement, and existing windows retain their bounds.

Suggested Chrome Web Store justification for `downloads`:

> This extension uses `chrome.downloads` to surface download lifecycle
> (started / in-progress / completed / failed) to the byCLI command-line tool,
> so agents can wait for downloads triggered during an automation workflow. The
> command filters by a user-provided filename or URL pattern and timeout. We do
> not modify, redirect, or persist user download history.

# Analysis actions above the 3D controls

The existing analysis dock holds the original Scan, Detect and Generate report
buttons for either distance mirror. In 3D only, its bottom offset clears the
highest visible control in the 2D/refresh/basemap and camera-action stack by
8px. The viewer measures the actual control rectangles against the dock's own
positioned ancestor, since the dock and the 3D controls do not share a parent.
Resize, orientation, fullscreen, body-class changes and control size changes
trigger a new measurement. A CSS fallback covers startup before measurement;
the PWA-specific selector overrides the inline safe-area/bleed positioning.
Returning to 2D removes the measured offset and restores the original layout.

`node test-3d-analysis-dock.js` covers web/PWA geometry, wrapped controls,
different containing blocks, the 2D reset and the versioned PWA cache.

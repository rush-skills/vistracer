/** macOS uses ⌘ for app shortcuts; Windows and Linux use Ctrl. */
function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/** ⌘K on macOS, Ctrl+K elsewhere; no other modifier. */
export function isCommandBarShortcut(event: KeyboardEvent, mac = isMacPlatform()): boolean {
  return (
    event.key.toLowerCase() === "k" &&
    !event.altKey &&
    !event.shiftKey &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

export function commandBarShortcutLabel(mac = isMacPlatform()): string {
  return mac ? "⌘K" : "Ctrl+K";
}

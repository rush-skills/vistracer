/** macOS uses ⌘ for app shortcuts; Windows and Linux use Ctrl. */
function isMacPlatform(): boolean {
  return /Mac|iPhone|iPad|iPod/.test(navigator.platform || navigator.userAgent);
}

/**
 * The K key. On a layout with Latin letters the letter decides (Dvorak's
 * "k" is not on the KeyK position); on other layouts (Cyrillic "л", Greek
 * "κ") the physical KeyK position does.
 */
function isKKey(event: KeyboardEvent): boolean {
  return /^[a-z]$/i.test(event.key) ? event.key.toLowerCase() === "k" : event.code === "KeyK";
}

/**
 * ⌘K on macOS, Ctrl+K elsewhere; no other modifier. A held key's auto
 * repeat does not count, so holding the keys does not toggle the bar on and off.
 */
export function isCommandBarShortcut(event: KeyboardEvent, mac = isMacPlatform()): boolean {
  return (
    !event.repeat &&
    isKKey(event) &&
    !event.altKey &&
    !event.shiftKey &&
    (mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)
  );
}

export function commandBarShortcutLabel(mac = isMacPlatform()): string {
  return mac ? "⌘K" : "Ctrl+K";
}

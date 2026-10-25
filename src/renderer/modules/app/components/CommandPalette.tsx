import React, { useEffect, useMemo, useRef, useState } from "react";
import { FiSearch } from "react-icons/fi";
import { useCommandContext } from "@renderer/hooks/useCommands";
import {
  buildCommands,
  searchCommands,
  traceCommand,
  type Command
} from "@renderer/lib/commands";
import { isCommandBarShortcut } from "@renderer/lib/shortcuts";
import { useUiStore } from "@renderer/state/uiStore";
import "./CommandPalette.css";

const LIST_ID = "command-list";
const optionId = (command: Command) => `command-${command.id}`;

/** Another modal dialog (settings, export, onboarding) keeps the keyboard. */
const otherDialogOpen = () =>
  document.querySelector('[role="dialog"][aria-modal="true"]:not(.command-palette)') !== null;

const CommandDialog: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const context = useCommandContext();
  const commands = useMemo(() => buildCommands(context), [context]);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const optionRefs = useRef(new Map<string, HTMLLIElement>());

  const results = useMemo(() => {
    const trace = traceCommand(query, context);
    const found = searchCommands(commands, query);
    return trace ? [trace, ...found] : found;
  }, [commands, context, query]);
  const current = results[Math.min(active, results.length - 1)];

  // Focus moves into the bar and back to where it was when the bar closes.
  useEffect(() => {
    const previous = document.activeElement;
    inputRef.current?.focus();
    return () => {
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  }, []);

  useEffect(() => {
    if (current) {
      optionRefs.current.get(current.id)?.scrollIntoView?.({ block: "nearest" });
    }
  }, [current]);

  const execute = (command: Command | undefined) => {
    if (!command || command.disabledReason) {
      return;
    }
    onClose();
    command.run();
  };

  const onKeyDown = (event: React.KeyboardEvent) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowUp": {
        event.preventDefault();
        if (results.length > 0) {
          const step = event.key === "ArrowDown" ? 1 : -1;
          const from = Math.min(active, results.length - 1);
          setActive((from + step + results.length) % results.length);
        }
        break;
      }
      case "Enter":
        event.preventDefault();
        execute(current);
        break;
      case "Escape":
        event.preventDefault();
        event.stopPropagation();
        onClose();
        break;
      case "Tab":
        // The search field is the only stop: focus stays in the bar.
        event.preventDefault();
        inputRef.current?.focus();
        break;
    }
  };

  return (
    <div className="command-palette__scrim" onMouseDown={onClose}>
      <div
        className="command-palette glass"
        role="dialog"
        aria-modal="true"
        aria-label="Command bar"
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={onKeyDown}
      >
        <div className="command-palette__search">
          <FiSearch aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search commands or type a host to trace"
            aria-expanded={true}
            aria-controls={LIST_ID}
            aria-autocomplete="list"
            aria-activedescendant={current ? optionId(current) : undefined}
            placeholder="Search commands, or type a host to trace"
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setActive(0);
            }}
          />
        </div>
        {results.length === 0 ? (
          <p className="command-palette__empty">No command matches “{query.trim()}”.</p>
        ) : (
          <ul id={LIST_ID} className="command-palette__list" role="listbox" aria-label="Commands">
            {results.map((command, index) => {
              const isActive = command === current;
              return (
                <li
                  key={command.id}
                  ref={(element) => {
                    if (element) {
                      optionRefs.current.set(command.id, element);
                    } else {
                      optionRefs.current.delete(command.id);
                    }
                  }}
                  id={optionId(command)}
                  role="option"
                  aria-selected={isActive}
                  aria-disabled={command.disabledReason ? true : undefined}
                  className={`command-palette__option${isActive ? " is-active" : ""}`}
                  onMouseMove={() => setActive(index)}
                  onClick={() => execute(command)}
                >
                  <span className="command-palette__title">{command.title}</span>
                  <span className="command-palette__detail">
                    {command.disabledReason ?? command.detail}
                  </span>
                  <span className="command-palette__group">{command.group}</span>
                </li>
              );
            })}
          </ul>
        )}
        <footer className="command-palette__keys" aria-hidden>
          <span>
            <kbd>↑</kbd> <kbd>↓</kbd> move
          </span>
          <span>
            <kbd>Enter</kbd> run
          </span>
          <span>
            <kbd>Esc</kbd> close
          </span>
        </footer>
      </div>
    </div>
  );
};

/** ⌘K (macOS) or Ctrl+K opens the command bar; the toolbar button does too. */
export const CommandPalette: React.FC = () => {
  const open = useUiStore((state) => state.paletteOpen);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isCommandBarShortcut(event)) {
        return;
      }
      const { paletteOpen, setPaletteOpen } = useUiStore.getState();
      if (!paletteOpen && otherDialogOpen()) {
        return;
      }
      event.preventDefault();
      setPaletteOpen(!paletteOpen);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return open ? <CommandDialog onClose={() => useUiStore.getState().setPaletteOpen(false)} /> : null;
};

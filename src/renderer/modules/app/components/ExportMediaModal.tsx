import React, { useEffect, useState } from "react";
import { useModalA11y } from "@renderer/hooks/useModalA11y";
import "./ExportMediaModal.css";

type ExportFormat = "png" | "jpg" | "webp" | "webm" | "gif";

interface ExportMediaModalProps {
  isOpen: boolean;
  defaultFormat: ExportFormat;
  onCancel: () => void;
  onConfirm: (options: { format: ExportFormat; dwellSeconds: number }) => void;
  disabled?: boolean;
}

const dwellDefault = 2;

export const ExportMediaModal: React.FC<ExportMediaModalProps> = ({
  isOpen,
  defaultFormat,
  onCancel,
  onConfirm,
  disabled
}) => {
  const [format, setFormat] = useState<ExportFormat>(defaultFormat);
  const [dwellSeconds, setDwellSeconds] = useState(dwellDefault);
  const modalRef = useModalA11y(isOpen, onCancel);

  useEffect(() => {
    if (isOpen) {
      setFormat(defaultFormat);
      setDwellSeconds(dwellDefault);
    }
  }, [defaultFormat, isOpen]);

  if (!isOpen) {
    return null;
  }

  const requiresDwell = format === "webm" || format === "gif";

  const imageFormats: Array<{ value: ExportFormat; label: string; recommended?: boolean }> = [
    { value: "png", label: "PNG" },
    { value: "jpg", label: "JPG" },
    { value: "webp", label: "WebP", recommended: true }
  ];

  const animationFormats: Array<{ value: ExportFormat; label: string; recommended?: boolean }> = [
    { value: "webm", label: "WebM", recommended: true },
    { value: "gif", label: "GIF" }
  ];

  const renderOption = (option: { value: ExportFormat; label: string; recommended?: boolean }) => (
    <label
      key={option.value}
      className={`export-modal__option${format === option.value ? " export-modal__option--active" : ""}`}
    >
      <input
        type="radio"
        name="export-format"
        value={option.value}
        checked={format === option.value}
        onChange={() => setFormat(option.value)}
        disabled={disabled}
      />
      <span className="export-modal__option-label">{option.label}</span>
      {option.recommended && <span className="export-modal__badge">Rec.</span>}
    </label>
  );

  return (
    <div className="export-modal-overlay" onClick={onCancel}>
      <div
        ref={modalRef}
        className="export-modal"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-modal__title"
        tabIndex={-1}
      >
        <header className="export-modal__header">
          <h2 id="export-modal__title">Export route</h2>
          <p>Select an output format and frame timing for the hop animation.</p>
        </header>
        <section className="export-modal__body">
          <div className="export-modal__group">
            <span className="export-modal__label">Images</span>
            <div className="export-modal__options export-modal__options--grid">
              {imageFormats.map(renderOption)}
            </div>
          </div>
          <div className="export-modal__group">
            <span className="export-modal__label">Animation</span>
            <div className="export-modal__options export-modal__options--grid">
              {animationFormats.map(renderOption)}
            </div>
          </div>
          <div className="export-modal__group">
            <label className="export-modal__label" htmlFor="export-modal__dwell">
              Seconds per hop
            </label>
            <input
              id="export-modal__dwell"
              type="number"
              min={0.5}
              max={10}
              step={0.5}
              value={dwellSeconds}
              disabled={!requiresDwell || disabled}
              onChange={(event) => {
                const value = Number(event.target.value);
                if (!Number.isNaN(value)) {
                  setDwellSeconds(Math.min(10, Math.max(0.5, value)));
                }
              }}
            />
            <p className="export-modal__hint">
              {requiresDwell
                ? "The animation will hold each hop (with tooltip) for this duration."
                : "Still images capture the current selection."}
            </p>
          </div>
        </section>
        <footer className="export-modal__footer">
          <button type="button" className="export-modal__button" onClick={onCancel} disabled={disabled}>
            Cancel
          </button>
          <button
            type="button"
            className="export-modal__button export-modal__button--primary"
            disabled={disabled}
            onClick={() => onConfirm({ format, dwellSeconds })}
          >
            Export
          </button>
        </footer>
      </div>
    </div>
  );
};

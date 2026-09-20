import { useEffect, useRef } from "react";
import type { ArenaCard, ArenaForm } from "@draft-royale/shared";
import { ArenaCardFace } from "./ArenaCardFace";

interface FormChooserProps {
  card: ArenaCard;
  legalForms: ArenaForm[];
  disabled: boolean;
  forBothPlayers?: boolean;
  onChoose: (form: ArenaForm) => void;
  onDismiss: () => void;
}

const formName: Record<ArenaForm, string> = {
  base: "Base",
  evolution: "Evolution",
  hero: "Hero",
  champion: "Champion",
};

function FormGlyph({ form }: { form: ArenaForm }) {
  if (form === "evolution") {
    return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 2l12 14-12 14L4 16 16 2zm0 7l-6 7 6 7 6-7-6-7z" /></svg>;
  }
  if (form === "hero" || form === "champion") {
    return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 10l6 5 5-10 5 10 6-5-2 15H7L5 10zm4 17h14v3H9v-3z" /></svg>;
  }
  return <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M7 3h18a3 3 0 013 3v20a3 3 0 01-3 3H7a3 3 0 01-3-3V6a3 3 0 013-3zm3 6v14h12V9H10z" /></svg>;
}

export function FormChooser({ card, legalForms, disabled, forBothPlayers = false, onChoose, onDismiss }: FormChooserProps) {
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusable = () => Array.from(dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
    const initialControl = focusable()[1] ?? focusable()[0];
    if (initialControl) initialControl.focus();
    else dialogRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }
      if (event.key !== "Tab") return;
      const controls = focusable();
      if (controls.length === 0) {
        event.preventDefault();
        return;
      }
      const first = controls[0]!;
      const last = controls.at(-1)!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus();
    };
  }, [onDismiss]);

  return (
    <div className="arena-form-scrim" role="presentation" onPointerDown={(event) => {
      if (event.target === event.currentTarget) onDismiss();
    }}>
      <div className="arena-form-dialog" role="dialog" aria-modal="true" aria-labelledby="arena-form-title" ref={dialogRef} tabIndex={-1}>
        <button className="arena-form-close" type="button" onClick={onDismiss} aria-label="Close form chooser">×</button>
        <strong id="arena-form-title">Choose {card.name}</strong>
        {forBothPlayers && <p className="arena-form-shared-note">This form goes into both decks.</p>}
        <div className="arena-form-options">
          {legalForms.map((form) => (
            <button key={form} type="button" disabled={disabled} onClick={() => onChoose(form)} aria-label={`Pick ${card.name} as ${formName[form]}`}>
              <ArenaCardFace card={card} form={form} className="arena-form-card" />
              <span className={`arena-form-glyph is-${form}`}><FormGlyph form={form} /></span>
              <span>{formName[form]}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

import type { CSSProperties, ImgHTMLAttributes } from "react";
import { arenaElixirAccessibleLabel, arenaElixirDisplay, type ArenaCard, type ArenaForm } from "@draft-royale/shared";

const fallbackAsset = (_card: ArenaCard) => "/assets/placeholder-card.svg";

export function assetForForm(card: ArenaCard, form: ArenaForm = "base") {
  return card.forms.find((candidate) => candidate.key === form)?.asset
    ?? card.forms.find((candidate) => candidate.key === "base")?.asset
    ?? card.forms[0]?.asset
    ?? fallbackAsset(card);
}

interface ArenaCardFaceProps {
  card: ArenaCard;
  form?: ArenaForm;
  muted?: boolean;
  selected?: boolean;
  legalForms?: ArenaForm[];
  className?: string;
  style?: CSSProperties;
  imageProps?: Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt">;
}

const formShortLabel: Record<ArenaForm, string> = {
  base: "Base",
  evolution: "Evo",
  hero: "Hero",
  champion: "Champ",
};

export function ArenaCardFace({
  card,
  form = "base",
  muted = false,
  selected = false,
  legalForms = [],
  className = "",
  style,
  imageProps,
}: ArenaCardFaceProps) {
  const specialForms = legalForms.filter((candidate) => candidate !== "base");

  return (
    <span
      className={`arena-card-face ${muted ? "is-muted" : ""} ${selected ? "is-selected" : ""} ${className}`}
      style={style}
    >
      <img
        {...imageProps}
        className={`arena-card-art ${imageProps?.className ?? ""}`}
        src={assetForForm(card, form)}
        alt=""
        draggable={false}
        onError={(event) => {
          const image = event.currentTarget;
          if (!image.src.endsWith("/_invalid.png")) image.src = "/assets/placeholder-card.svg";
          imageProps?.onError?.(event);
        }}
      />
      <span className="arena-elixir" aria-label={arenaElixirAccessibleLabel(card.elixir)}><span className="arena-elixir-value" aria-hidden="true">{arenaElixirDisplay(card.elixir)}</span></span>
      {specialForms.length > 0 ? (
        <span className="arena-form-marks" aria-label={`Available forms: ${legalForms.map((key) => formShortLabel[key]).join(", ")}`}>
          {specialForms.slice(0, 2).map((key) => (
            <span className={`arena-form-mark is-${key}`} key={key} aria-hidden="true">
              {key === "evolution" ? "E" : key === "hero" ? "H" : "C"}
            </span>
          ))}
        </span>
      ) : null}
      {selected ? (
        <span className="arena-picked-check" aria-label="Already selected">
          <svg viewBox="0 0 32 32" aria-hidden="true">
            <path d="M8 16.5l5.2 5.2L24.5 10.4" />
          </svg>
        </span>
      ) : null}
    </span>
  );
}

// The side sheet that changes how one machine looks in this app.
import { useId, useRef, useState, type ChangeEvent } from "react";
import { motion } from "motion/react";
import { RadioGroup } from "radix-ui";
import { HexColorPicker } from "react-colorful";
import { ArrowCounterClockwise, FileArrowUp, Plus, X } from "@/components/icons";
import { cn, isCoarsePointer, SNAP } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import { Popover, PopoverAnchor, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Label } from "@/components/ui/label";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { usePrefersReducedMotion } from "@/lib/dither";
import { Hint } from "@/shared/shared";
import { LookIcon } from "./machine-node";
import {
  ACCENTS,
  CUSTOM_ICON_MAX_BYTES,
  CUSTOM_ICON_TYPES,
  DEVICE_ICONS,
  liftAccent,
  mapStore,
  rgbToHex,
  type Accent,
  type DeviceIcon,
  type Look,
  type ResolvedLook,
} from "./model";

const HEX_INPUT = /^#?[0-9a-f]{6}$/i;
/** What the hex field accepts while typing: a "#" and up to six hex digits. Anything else is flagged at once. */
const HEX_PARTIAL = /^#?[0-9a-f]{0,6}$/i;
/** The Custom swatch is a hue wheel, the usual sign for "any colour"; one lightness keeps it as calm as the presets. */
const HUE_WHEEL = "conic-gradient(in oklch longer hue, oklch(0.76 0.13 0), oklch(0.76 0.13 0))";
const ICON_KEYS = [...(Object.keys(DEVICE_ICONS) as DeviceIcon[]), "custom"] as const;
const ACCENT_KEYS = [...(Object.keys(ACCENTS) as Accent[]), "custom"] as const;

/** Reads an icon upload into a data URL, or throws an Error whose message says what to change. */
async function readCustomIcon(file: File): Promise<string> {
  // Some systems hand over an .svg with no MIME type, so the extension decides when the type is missing.
  const type = file.type || (/\.svg$/i.test(file.name) ? "image/svg+xml" : /\.png$/i.test(file.name) ? "image/png" : "");
  if (!(CUSTOM_ICON_TYPES as readonly string[]).includes(type)) throw new Error("Choose an SVG or PNG file.");
  if (file.size > CUSTOM_ICON_MAX_BYTES) throw new Error(`Choose a file up to 64 KB. This one is ${Math.ceil(file.size / 1024)} KB.`);
  const unreadable = new Error("This file can't be read as an image. Export it again as SVG or PNG.");
  // Re-typing the blob makes the data URL carry the checked type even when the file had none.
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(unreadable);
    reader.readAsDataURL(new Blob([file], { type }));
  });
  const img = new Image();
  img.src = url;
  await img.decode().catch(() => {
    throw unreadable;
  });
  // The icon is drawn as a mask, so only its alpha shows. On a 32px copy, a glyph has some solid pixels; a photo
  // or an opaque background has nearly all of them and would show as a solid block.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 32;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(img, 0, 0, 32, 32);
  let alpha: Uint8ClampedArray;
  try {
    alpha = ctx.getImageData(0, 0, 32, 32).data;
  } catch {
    // Older WebKit taints canvases that drew an SVG; the upload is still valid, it just skips this check.
    return url;
  }
  let visible = 0;
  let solid = 0;
  for (let i = 3; i < alpha.length; i += 4) {
    if (alpha[i] > 0) visible++;
    if (alpha[i] > 127) solid++;
  }
  if (visible === 0) throw new Error("This image is fully transparent. Choose one with a visible shape.");
  if (solid > 0.85 * 32 * 32) throw new Error("Use an image with a transparent background. This one would show as a solid block.");
  return url;
}

/** Any CSS colour, `var(--token)` and oklch included, as #rrggbb, read back through a 1x1 canvas. */
function cssToHex(color: string, el: Element): string {
  const value = color.replace(/^var\((--[\w-]+)\)$/, (_, name: string) => getComputedStyle(el).getPropertyValue(name).trim());
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
  ctx.fillStyle = value;
  ctx.fillRect(0, 0, 1, 1);
  return rgbToHex(ctx.getImageData(0, 0, 1, 1).data.subarray(0, 3));
}

export interface CustomizeSheetProps {
  id: string;
  hostname: string;
  /** What the user saved, so cleared fields show the default as a placeholder. */
  saved: Look | undefined;
  look: ResolvedLook;
  onClose: () => void;
}

export function CustomizeSheet({ id, hostname, saved, look, onClose }: CustomizeSheetProps) {
  const uid = useId();
  // Read once per open: autoFocus only matters on mount, and the sheet re-renders on every keystroke and colour drag.
  const [focusName] = useState(() => !isCoarsePointer());
  // Reduced motion keeps the fade (a state change) and drops the slide.
  const slide = usePrefersReducedMotion() ? 0 : 12;
  const set = (patch: Look) => mapStore.setLook(id, patch);
  const sheetRef = useRef<HTMLElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const swatchRef = useRef<HTMLButtonElement>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Set when the Custom swatch opens the picker, so closing it hands focus back there instead of to the hex
  // button. A click outside clears it: focus then belongs to whatever was clicked.
  const focusSwatchOnClose = useRef(false);

  // Local state is keyed by machine id: the sheet stays mounted when it switches machines.
  // Choosing Custom with nothing uploaded shows the uploader but saves nothing, so the map keeps the old icon
  // until an upload succeeds.
  const [pickingFor, setPickingFor] = useState<string | null>(null);
  const [iconError, setIconError] = useState<{ id: string; message: string } | null>(null);
  // The colour as last typed or picked, before lifting, so the inputs don't jump while a too-dark colour is lifted.
  const [accentInput, setAccentInput] = useState<{ id: string; hex: string; text: string } | null>(null);
  const iconValue = look.icon === "custom" || pickingFor === id ? "custom" : look.icon;
  const error = iconError?.id === id ? iconError.message : null;
  const input = accentInput?.id === id ? accentInput : null;
  const lifted = input && look.accent === "custom" && look.customAccent !== input.hex ? look.customAccent : null;
  const hexInvalid = input !== null && !HEX_PARTIAL.test(input.text);

  /** Saves a custom accent, lifted to readable contrast on the card it is drawn on. */
  const applyAccent = (hex: string) => set({ accent: "custom", customAccent: liftAccent(hex, cssToHex("var(--raised)", sheetRef.current!)) });
  /** `raw` is what the user typed or picked (with or without "#", any case); the inputs keep showing it. */
  const pickAccent = (raw: string) => {
    const normal = `#${raw.replace("#", "").toLowerCase()}`;
    setAccentInput({ id, hex: normal, text: raw });
    applyAccent(normal);
  };
  /** Selects the custom accent; the first time, it starts from the colour in use so nothing changes until the user picks. */
  const chooseCustom = () => (look.customAccent ? set({ accent: "custom" }) : applyAccent(cssToHex(look.color, sheetRef.current!)));
  const openFromSwatch = () => {
    focusSwatchOnClose.current = true;
    setPickerOpen(true);
  };
  const liftNotice = lifted && (
    <>
      Too dark to read on the map, so it's lightened to <span className="font-mono">{lifted}</span>.
    </>
  );

  const onIconFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Cleared so choosing the same file again (after fixing it, say) still fires change.
    e.target.value = "";
    if (!file) return;
    try {
      set({ icon: "custom", customIcon: await readCustomIcon(file) });
      setIconError(null);
      setPickingFor(null);
    } catch (err) {
      setIconError({ id, message: (err as Error).message });
    }
  };

  return (
    <motion.aside
      ref={sheetRef}
      role="dialog"
      aria-labelledby={`${uid}-title`}
      initial={{ opacity: 0, x: slide }}
      animate={{ opacity: 1, x: 0 }}
      exit={{ opacity: 0, x: slide, transition: { duration: 0.15 } }}
      transition={{ duration: 0.2, ease: SNAP }}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
      className="absolute top-2 right-2 z-10 flex max-h-[calc(100%-1rem)] w-[284px] flex-col overflow-hidden rounded-lg border border-border-strong bg-popover shadow-xl shadow-black/50"
    >
      <header className="flex items-start gap-2 border-b border-border px-3.5 pt-3 pb-2.5">
        <div className="min-w-0 flex-1">
          <h2 id={`${uid}-title`} className="truncate font-medium">
            Customize {look.name}
          </h2>
          <p className="mt-0.5 flex items-center gap-1.5 text-sm text-muted-foreground">
            Only changes how it looks here
            <Hint label="where these changes apply">
              These settings only change how this machine looks in canonfig ui on this computer.{"\n"}Nothing is sent to the Source or to
              other machines, and its hostname stays <span className="font-mono">{hostname}</span>.
            </Hint>
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label="Close customize panel"
          onClick={onClose}
          className="-mt-0.5 -mr-1.5 rounded-md text-muted-foreground"
        >
          <X className="size-4" />
        </Button>
      </header>

      <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-3.5 py-3.5">
        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-name`}>Name</Label>
          <Input
            id={`${uid}-name`}
            autoFocus={focusName}
            maxLength={32}
            value={saved?.name ?? ""}
            placeholder={hostname}
            onChange={(e) => set({ name: e.target.value })}
          />
          <p className="text-xs text-faint">
            Commands still use the hostname, <span className="font-mono">{hostname}</span>.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor={`${uid}-purpose`}>Purpose</Label>
          <Input
            id={`${uid}-purpose`}
            maxLength={40}
            value={saved?.purpose ?? look.purpose}
            placeholder="e.g. Work laptop"
            onChange={(e) => set({ purpose: e.target.value })}
          />
        </div>

        <div className="grid gap-1.5">
          <span id={`${uid}-icon`} className="text-sm font-medium">
            Icon
          </span>
          <RadioGroup.Root
            aria-labelledby={`${uid}-icon`}
            value={iconValue}
            onValueChange={(v) => {
              if (v !== "custom") {
                setPickingFor(null);
                set({ icon: v as DeviceIcon });
              } else if (look.iconSrc) set({ icon: "custom" });
              else setPickingFor(id);
            }}
            className="grid grid-cols-6 gap-1"
          >
            {ICON_KEYS.map((key) => {
              const label = key === "custom" ? "Custom icon" : DEVICE_ICONS[key].label;
              const checked = key === iconValue;
              return (
                <Tooltip key={key}>
                  <TooltipTrigger asChild>
                    <RadioGroup.Item
                      value={key}
                      aria-label={label}
                      // A pointer click on an empty Custom tile goes straight to the file picker. Keyboard selection
                      // (arrows, Space) clicks with detail 0, so arrowing past the tile never opens a dialog.
                      onClick={key === "custom" ? (e) => e.detail > 0 && !look.iconSrc && fileRef.current?.click() : undefined}
                      // aria-checked, not data-state: the Tooltip trigger shares this button and its data-state
                      // ("closed", "delayed-open") overwrites the radio's, so data-[state=checked] never matched.
                      className="grid h-9 place-items-center rounded-md border border-transparent text-muted-foreground hover:bg-muted hover:text-foreground aria-checked:border-border-strong aria-checked:bg-raised aria-checked:text-foreground"
                      style={checked ? { color: look.color } : undefined}
                    >
                      {key === "custom" && !look.iconSrc ? (
                        <Plus className="size-[18px]" />
                      ) : (
                        <LookIcon look={{ icon: key, iconSrc: look.iconSrc }} bold={checked} className="size-[18px]" />
                      )}
                    </RadioGroup.Item>
                  </TooltipTrigger>
                  <TooltipContent>{label}</TooltipContent>
                </Tooltip>
              );
            })}
          </RadioGroup.Root>
          <input ref={fileRef} type="file" accept=".svg,.png,image/svg+xml,image/png" hidden onChange={onIconFile} />
          {iconValue === "custom" && (
            <div className="grid animate-in gap-1.5 duration-150 ease-snap fade-in-0">
              <Button
                type="button"
                variant="outline"
                size="sm"
                aria-describedby={error ? `${uid}-icon-error ${uid}-icon-help` : `${uid}-icon-help`}
                onClick={() => fileRef.current?.click()}
                className="justify-self-start rounded-md px-1.5"
              >
                <FileArrowUp />
                {look.iconSrc ? "Replace image" : "Upload image"}
              </Button>
              {error && (
                <p id={`${uid}-icon-error`} role="alert" className="text-xs text-bad">
                  {error}
                </p>
              )}
              <p id={`${uid}-icon-help`} className="text-xs text-faint">
                Use a square, one-colour SVG or PNG on a transparent background, up to 64 KB. Keep it simple so it still reads at
                16 px. It takes the accent colour.
              </p>
            </div>
          )}
        </div>

        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <div className="grid gap-1.5">
            <span id={`${uid}-accent`} className="text-sm font-medium">
              Accent
            </span>
            {/* The picker opens under the Custom swatch whichever control opened it. */}
            <PopoverAnchor virtualRef={swatchRef} />
            <RadioGroup.Root
              aria-labelledby={`${uid}-accent`}
              value={look.accent}
              onValueChange={(v) => (v === "custom" ? chooseCustom() : set({ accent: v as Accent }))}
              // Seven swatches spread edge to edge line up with the icon grid's outer columns.
              className="flex justify-between"
            >
              {ACCENT_KEYS.map((key) => {
                const label = key === "custom" ? "Custom colour" : ACCENTS[key].label;
                const custom = key === "custom";
                return (
                  <Tooltip key={key}>
                    <TooltipTrigger asChild>
                      <RadioGroup.Item
                        ref={custom ? swatchRef : undefined}
                        value={key}
                        aria-label={label}
                        // A pointer click on Custom opens (or closes) the picker. Arrowing through the group also clicks,
                        // with detail 0, so passing the swatch never opens it; Enter or Space on it does.
                        onClick={custom ? (e) => e.detail > 0 && (pickerOpen ? setPickerOpen(false) : openFromSwatch()) : undefined}
                        onKeyDown={
                          custom
                            ? (e) => {
                                if (e.key !== "Enter" && e.key !== " ") return;
                                // Focus moves into the picker before Space's keyup, so no click follows to check the radio.
                                e.preventDefault();
                                if (look.accent !== "custom") chooseCustom();
                                openFromSwatch();
                              }
                            : undefined
                        }
                        className="grid size-7 place-items-center rounded-full border border-transparent hover:border-border-strong aria-checked:border-foreground/70 pointer-coarse:size-9"
                      >
                        {custom ? (
                          <span className="grid size-[18px] place-items-center rounded-full" style={{ background: HUE_WHEEL }}>
                            {look.customAccent && <span className="size-2.5 rounded-full ring-2 ring-popover" style={{ backgroundColor: look.customAccent }} />}
                          </span>
                        ) : (
                          <span className="size-[18px] rounded-full" style={{ backgroundColor: ACCENTS[key].color }} />
                        )}
                      </RadioGroup.Item>
                    </TooltipTrigger>
                    <TooltipContent>{label}</TooltipContent>
                  </Tooltip>
                );
              })}
            </RadioGroup.Root>
            {look.accent === "custom" && (
              <div className="grid animate-in gap-1.5 duration-150 ease-snap fade-in-0">
                <PopoverTrigger asChild>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    aria-label={`Edit custom colour ${look.customAccent}`}
                    onClick={() => (focusSwatchOnClose.current = false)}
                    className="justify-self-start rounded-md px-1.5 font-mono"
                  >
                    <span className="size-3.5 rounded-[3px] ring-1 ring-foreground/15" style={{ backgroundColor: look.customAccent }} />
                    {look.customAccent}
                  </Button>
                </PopoverTrigger>
                {/* While the picker is open its own copy announces the lift; this one keeps it in view after it closes. */}
                {!pickerOpen && liftNotice && <p className="text-xs text-warn">{liftNotice}</p>}
              </div>
            )}
          </div>
          <PopoverContent
            side="bottom"
            align="end"
            aria-label="Custom colour"
            className="w-60 gap-3 p-3"
            // Escape closes only the picker: Radix has handled it by now, so the sheet must not see it too.
            onKeyDown={(e) => e.key === "Escape" && e.stopPropagation()}
            onInteractOutside={(e) => {
              // The swatch toggles the picker itself; letting this close it first would reopen it on the same click.
              if (swatchRef.current?.contains(e.target as Node)) e.preventDefault();
              else focusSwatchOnClose.current = false;
            }}
            onCloseAutoFocus={(e) => {
              if (!focusSwatchOnClose.current) return;
              e.preventDefault();
              swatchRef.current?.focus();
            }}
          >
            <HexColorPicker className="accent-picker" color={input?.hex ?? look.customAccent} onChange={pickAccent} />
            <div className="flex items-center gap-2">
              {/* What the map draws: the picked colour, or its lightened version when that is too dark. */}
              <span className="size-8 shrink-0 rounded-md ring-1 ring-foreground/15" style={{ backgroundColor: look.customAccent }} />
              <Input
                aria-label="Custom colour hex code"
                aria-invalid={hexInvalid || undefined}
                aria-describedby={hexInvalid ? `${uid}-hex-error` : undefined}
                value={input?.text ?? look.customAccent}
                maxLength={7}
                spellCheck={false}
                autoComplete="off"
                placeholder="#7dd3fc"
                onChange={(e) => {
                  const text = e.target.value;
                  if (HEX_INPUT.test(text)) pickAccent(text);
                  else setAccentInput({ id, hex: input?.hex ?? look.customAccent, text });
                }}
                // An unfinished or invalid code goes back to the colour in use rather than lingering.
                onBlur={() => input && !HEX_INPUT.test(input.text) && setAccentInput({ ...input, text: input.hex })}
                className="font-mono"
              />
            </div>
            {/* One message slot whose height never changes: the hint, the lift notice and the hex error
                share a single grid cell and only the active one is visible. A growing popover that sits
                above the swatch would otherwise move up under the pointer when a notice appears (a layout shift). */}
            <div className="grid text-xs *:col-start-1 *:row-start-1">
              <p id={`${uid}-hex-error`} className={cn("text-bad", !hexInvalid && "invisible")} aria-hidden={!hexInvalid}>
                Use six hex digits, like #7dd3fc.
              </p>
              {/* Always mounted so screen readers announce the lift when it appears. */}
              <p role="status" className={cn("text-warn", (hexInvalid || !lifted) && "invisible")}>
                {liftNotice}
              </p>
              <p className={cn("text-faint", (hexInvalid || lifted) && "invisible")} aria-hidden={hexInvalid || !!lifted}>
                Pick a mid-to-light colour that stands apart from the status colours: green, gold, orange and red.
              </p>
            </div>
          </PopoverContent>
        </Popover>
      </div>

      <footer className="border-t border-border px-2 py-1.5">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!saved}
          onClick={() => mapStore.resetLook(id)}
          className="rounded-md px-1.5"
        >
          <ArrowCounterClockwise />
          Reset this machine's look
        </Button>
      </footer>
    </motion.aside>
  );
}

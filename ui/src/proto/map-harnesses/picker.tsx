import { useEffect, useLayoutEffect, useRef } from "react";
import "./picker.css";


export function Picker({ names, current, select, replay }: { names: string[]; current: number; select: (index: number) => void; replay: () => void }) {
  const picker = useRef<HTMLElement>(null);
  const highlight = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    function moveHighlight() {
      const item = picker.current!.querySelectorAll<HTMLButtonElement>(".proto-picker-item")[current];
      highlight.current!.style.width = `${item.offsetWidth}px`;
      highlight.current!.style.transform = `translateX(${item.offsetLeft}px)`;
    }
    moveHighlight();
    window.addEventListener("resize", moveHighlight);
    return () => window.removeEventListener("resize", moveHighlight);
  }, [current]);
  useEffect(() => {
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => picker.current!.setAttribute("data-ready", ""));
    });
    return () => cancelAnimationFrame(frame);
  }, []);
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      const target = event.target;
      if (target instanceof HTMLElement && (/^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName) || target.isContentEditable)) return;
      if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      const number = parseInt(event.key, 10);
      if (number >= 1 && number <= names.length) select(number - 1);
      else if (event.key === "ArrowRight") select((current + 1) % names.length);
      else if (event.key === "ArrowLeft") select((current - 1 + names.length) % names.length);
      else if (event.key === "r" || event.key === "R") replay();
    }
    document.addEventListener("keydown", keydown);
    return () => document.removeEventListener("keydown", keydown);
  }, [current, names, select, replay]);
  return <nav ref={picker} className="proto-picker" aria-label="Prototype variants">
    <span ref={highlight} className="proto-picker-highlight" aria-hidden="true" />
    {names.map((name, index) => <button key={name} className="proto-picker-item" data-active={index === current ? "" : undefined} aria-current={index === current ? "true" : undefined} onClick={() => select(index)}>{name}</button>)}
  </nav>;
}

import logo from '@/public/logo.png';

/**
 * The Canonfig mark: the Ender chest, the same 300px pixel-art file the docs
 * and the GUI use. It is drawn at small sizes, so it scales with
 * nearest-neighbour sampling to keep its pixels square instead of blurred.
 * Decorative wherever it sits beside the word "Canonfig".
 */
export function Mark({ size = 20 }: { size?: number }) {
  return (
    <img
      className="sa-mark"
      src={logo.src}
      alt=""
      width={size}
      height={size}
    />
  );
}

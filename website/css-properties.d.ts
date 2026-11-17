import "react";

// React forwards CSS custom properties in style objects to the browser.
declare module "react" {
  interface CSSProperties {
    [property: `--${string}`]: string | number | undefined;
  }
}

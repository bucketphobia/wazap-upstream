import { brand, dim, yellow } from "./ui.js";

export const BANNER_ART = `██╗    ██╗ █████╗ ███████╗ █████╗ ██████╗
██║    ██║██╔══██╗╚══███╔╝██╔══██╗██╔══██╗
██║ █╗ ██║███████║  ███╔╝ ███████║██████╔╝
██║███╗██║██╔══██║ ███╔╝  ██╔══██║██╔═══╝
╚███╔███╔╝██║  ██║███████╗██║  ██║██║
 ╚══╝╚══╝ ╚═╝  ╚═╝╚══════╝╚═╝  ╚═╝╚═╝`;

export const TAGLINE = "WhatsApp for your AI agent.";

export const BANNER = `${BANNER_ART}\n${TAGLINE}`;

/** wa + zap: a chat bubble with a bolt in it, set left of the wordmark. */
const BUBBLE = [
  "╭───────────────╮",
  "│        ▄██▀   │",
  "│      ▄██▀     │",
  "│    ▄███████▀  │",
  "│       ▄██▀    │",
  "│     ▄█▀       │",
  "╰─╮╭────────────╯",
  "  ╰╯",
];
const GUTTER = "   ";
const WORDMARK_AT = BUBBLE[0].length + GUTTER.length;

/** Columns the bubble logo needs; a narrower window gets the wordmark alone. */
export const LOGO_COLUMNS = WORDMARK_AT + Math.max(...BANNER_ART.split("\n").map((line) => line.length));

const plain = (text: string): string => text;

/** The bubble, then the wordmark one row down so the tail sits beside the tagline. */
function logoLines(side: (s: string) => string, art: (s: string) => string, tag: (s: string) => string): string[] {
  const words = BANNER_ART.split("\n");
  return BUBBLE.map((left, i) => {
    const right = i === BUBBLE.length - 1 ? tag(TAGLINE) : i === 0 ? "" : art(words[i - 1]);
    return right === "" ? side(left) : `${side(left)}${" ".repeat(WORDMARK_AT - left.length)}${right}`;
  });
}

export const LOGO_ART = logoLines(plain, plain, plain).join("\n");

function paintBubble(line: string): string {
  return line.replace(/[▄█▀]+|[^▄█▀]+/g, (run) => (/[▄█▀]/.test(run) ? yellow(run) : brand(run)));
}

/** Painted per line, so a wrapped terminal cannot bleed the colour onward. */
export function banner(columns: number | undefined = process.stderr.columns): string {
  if (columns === undefined || columns < LOGO_COLUMNS) {
    return `${BANNER_ART.split("\n").map(brand).join("\n")}\n${dim(TAGLINE)}`;
  }
  return logoLines(paintBubble, brand, dim).join("\n");
}

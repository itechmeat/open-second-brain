// Telegram MarkdownV2 reserves these — backslash-escape them.
const RESERVED = /([_*[\]()~`>#+\-=|{}.!\\])/g;

export function escapeMarkdownV2(s: string): string {
  return s.replace(RESERVED, "\\$1");
}

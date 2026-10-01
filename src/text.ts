export function trimBlankEdges(text: string): string {
  return text.replace(/^(?:[ \t]*\r?\n)+/, "").replace(/\s+$/, "");
}

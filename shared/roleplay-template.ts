/** Only named RP placeholders; never evaluate arbitrary template expressions. */
export function resolveRoleplayTemplate(text: string, names: { char: string; user: string }): string {
  return text.replace(/\{\{\s*(char|user)\s*\}\}/gi, (_, key: string) => names[key.toLowerCase() as keyof typeof names]);
}

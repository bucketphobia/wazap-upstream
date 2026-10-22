/** Presentation only: never use these labels as addresses or identity keys. */
function phoneDigits(value: string | null | undefined): string | undefined {
  const digits = value?.trim().replace(/^\+/, "").replace(/[\s().-]/g, "");
  return digits && /^[1-9]\d{3,14}$/.test(digits) ? digits : undefined;
}

/** Readable international numbers; unknown numbering plans keep all their digits. */
export function formatPhone(value: string): string {
  const digits = phoneDigits(value);
  if (!digits) return value;
  if (digits.startsWith("1") && digits.length === 11) {
    return `+1 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7)}`;
  }
  if (digits.startsWith("44") && digits.length === 12) {
    return `+44 ${digits.slice(2, 6)} ${digits.slice(6, 9)} ${digits.slice(9)}`;
  }
  if (digits.startsWith("40") && digits.length === 11) {
    return `+40 ${digits.slice(2, 5)} ${digits.slice(5, 8)} ${digits.slice(8)}`;
  }
  return `+${digits}`;
}

/** A LID or group id is never a phone number, even when its user part is digits. */
export function contactLabel(name: string, id: string, number?: string | null): string {
  if (id.endsWith("@g.us")) return `${name} (group)`;
  const fromId = /^(\d+)@s\.whatsapp\.net$/.exec(id)?.[1];
  const digits = phoneDigits(number) ?? phoneDigits(fromId);
  const technicalName = /^\d+@(?:s\.whatsapp\.net|lid)$/.test(name);
  if (!digits) return technicalName ? "Unknown (number unavailable)" : name;
  const formatted = formatPhone(digits);
  // Avoid "407… (+40 …)" and replace service placeholders once a number is known.
  if (phoneDigits(name) === digits || name === id || technicalName || !name.trim() || /^unknown(?: \(lid …\d+\))?$/.test(name)) return formatted;
  return `${name} (${formatted})`;
}

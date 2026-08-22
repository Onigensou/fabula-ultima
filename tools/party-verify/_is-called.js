// Is `id` used as a FUNCTION CALL in `src` (i.e. followed by "(")?
// Deliberately regex-free: building this pattern through shell -> python -> JS
// kept collapsing the backslashes and produced /ROUNDs*(/ — an invalid regex
// that threw at extraction time.
export function isCalled(src, id) {
  const s = String(src ?? "");
  let from = 0;
  for (;;) {
    const i = s.indexOf(id, from);
    if (i < 0) return false;
    const before = i === 0 ? "" : s[i - 1];
    const wordBefore = /[A-Za-z0-9_]/.test(before);
    let j = i + id.length;
    while (j < s.length && (s[j] === " " || s[j] === "\t")) j++;
    if (!wordBefore && s[j] === "(") return true;
    from = i + 1;
  }
}

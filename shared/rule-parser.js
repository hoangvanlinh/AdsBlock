// Native rule grammar parser shared by background and offline tooling.
(function (root) {
function parseRuleText(text) {
  const out = Object.create(null);
  let section = '';
  const lines = String(text || '').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === '#' || line[0] === ';') continue;
    if (line[0] === '[' && line[line.length - 1] === ']') {
      section = line.slice(1, -1).trim().toLowerCase();
      if (section && !out[section]) out[section] = Object.create(null);
      continue;
    }
    if (!section) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim().toLowerCase();
    const value = line.slice(eq + 1).trim();
    if (!key) continue;
    // Values are '|'-separated; a literal '|' inside a value (regex
    // alternation in scriptlet args) is written as '\\|' and unescaped here.
    const newVals = value ? value.split(/(?<!\\)\|/).map(part => part.trim().replace(/\\\|/g, '|')).filter(Boolean) : [];
    // Merge duplicate keys across multiple source files (same semantics as the
    // content-side parser): append values not already present.
    if (out[section][key] && out[section][key].length) {
      const seen = new Set(out[section][key]);
      for (const v of newVals) {
        if (!seen.has(v)) { seen.add(v); out[section][key].push(v); }
      }
    } else {
      out[section][key] = newVals;
    }
  }
  return out;
}

root.RuleParser = { parse: parseRuleText };
if (typeof module !== "undefined") module.exports = root.RuleParser;
})(typeof self === "undefined" ? globalThis : self);

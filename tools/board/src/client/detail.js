const EDITABLE_FIELDS = [
  "title",
  "priority",
  "status",
  "body",
  "agent",
  "phase",
  "depends_on",
  "max_attempts",
  "complexity_points"
];

function valuesEqual(a, b) {
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((value, index) => value === b[index]);
  }
  return a === b;
}

export function buildUpdateBody(original, edited) {
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (edited[field] !== undefined && !valuesEqual(edited[field], original[field])) {
      patch[field] = edited[field];
    }
  }
  return patch;
}

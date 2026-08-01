const EDITABLE_FIELDS = ["title", "priority", "status", "body"];

export function buildUpdateBody(original, edited) {
  const patch = {};
  for (const field of EDITABLE_FIELDS) {
    if (edited[field] !== undefined && edited[field] !== original[field]) {
      patch[field] = edited[field];
    }
  }
  return patch;
}

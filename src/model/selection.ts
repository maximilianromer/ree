export const DEFAULT_MODEL = "gpt-5.6-luna";

export function normalizeModelSlug(value: string | undefined): string {
  const model = (value ?? DEFAULT_MODEL).trim();
  if (!model) throw new Error("Model slug cannot be empty");
  if (model.length > 200)
    throw new Error("Model slug must be 200 characters or fewer");
  const containsControlCharacter = [...model].some((character) => {
    const code = character.charCodeAt(0);
    return code <= 31 || code === 127;
  });
  if (model.startsWith("-") || /\s/.test(model) || containsControlCharacter)
    throw new Error(
      "Model slug cannot start with a hyphen or contain whitespace or control characters",
    );
  return model;
}

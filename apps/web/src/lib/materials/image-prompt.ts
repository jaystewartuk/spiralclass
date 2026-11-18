// The brief a generated material image is drawn from: the teacher's own
// description, inside the framing SpiralClass adds to every one.
//
// Pure and separate from the provider call so the framing is testable and the
// one place it is decided.
//
// THE FRAMING, and why each part is there:
//
//  - A REALISTIC PHOTOGRAPH by default. The first teacher to use generated
//    pictures asked for realistic scenes rather than illustrations, which she
//    said felt like material for children; her students are adults. A teacher
//    who wants a drawing can say so in the description, and a stated style wins.
//  - NO WRITING IN THE PICTURE. Image models render text unreliably, and in a
//    language class a misspelt sign is a wrong answer printed on the exercise.
//    Anything the student should read belongs in the material, as text.
//  - The description is passed as the teacher wrote it, in whatever language
//    she wrote it in. It is not translated or rewritten.

/** The longest description acted on. A scene is a sentence or two; this bounds
 * the prompt without truncating any description a teacher would write. */
export const MATERIAL_IMAGE_DESCRIPTION_MAX = 600;

/** The shortest description worth spending a generation on. */
export const MATERIAL_IMAGE_DESCRIPTION_MIN = 3;

/** Whitespace collapsed and trimmed, so the length checks count characters a
 * teacher actually typed. */
export function normalizeMaterialImageDescription(raw: string): string {
  return raw.replace(/\s+/g, " ").trim();
}

export function buildMaterialImagePrompt(description: string): string {
  const scene = normalizeMaterialImageDescription(description).slice(
    0,
    MATERIAL_IMAGE_DESCRIPTION_MAX,
  );
  return [
    "Create one image for an exercise in a class for adult learners.",
    `The scene: ${scene}`,
    "Unless the scene above asks for another style, make it a realistic, natural-looking photograph of an everyday situation: real people, real places, natural light.",
    "Do not put any text in the image: no words, letters, numbers, captions, signs with writing, labels, logos or watermarks.",
  ].join("\n");
}

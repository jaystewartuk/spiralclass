// Shared constants/types for the durable student profile (interests + goals,
// D-20). Kept in a plain module — NOT the `"use server"` action file — because
// Next.js only allows a `"use server"` file to export async functions, so a
// value export like the char cap has to live outside it (both the server action
// and the client form import from here).

// Generous caps — a sentence or two each, long enough to be useful, short
// enough to bound the prompt.
export const STUDENT_PROFILE_MAX_CHARS = 500;

export type StudentProfileState = { error?: string; ok?: string } | undefined;

/**
 * Validate that `age` is a non-negative integer.
 *
 * NOTE (fixture seed): this implementation is intentionally incomplete — it
 * does not reject negative numbers or non-integers. The task is for the agent
 * to make `npm test` (node --test) pass by hardening this function.
 */
export function validateAge(age) {
  if (typeof age !== 'number') {
    throw new TypeError('age must be a number');
  }
  return age;
}

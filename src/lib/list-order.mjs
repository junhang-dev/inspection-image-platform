/** @param {{ id: string, createdAt?: string | null, photoGrade?: number | null, effectiveGrade?: number | null }} a
 * @param {{ id: string, createdAt?: string | null, photoGrade?: number | null, effectiveGrade?: number | null }} b
 * @param {string} sort */
export function compareListRows(a, b, sort = 'newest') {
  if (sort === 'grade_desc' || sort === 'grade_asc') {
    const valid = (grade) => Number.isInteger(grade) && grade >= 1 && grade <= 5;
    const left = a.photoGrade ?? a.effectiveGrade;
    const right = b.photoGrade ?? b.effectiveGrade;
    if (valid(left) !== valid(right)) return valid(left) ? -1 : 1;
    if (valid(left) && left !== right) return sort === 'grade_desc' ? right - left : left - right;
  }
  return (b.createdAt ?? '').localeCompare(a.createdAt ?? '') || b.id.localeCompare(a.id);
}

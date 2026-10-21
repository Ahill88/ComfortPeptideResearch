/**
 * REQUIRE_PUBLISHED_COA: when the exact string 'true', a lot is sellable/visible only while it has a PUBLISHED COA. Default off, so the
 * preview seed (placeholder lots without COAs) keeps working. Production must turn it on once real COAs exist (.env.example).
 *
 * One definition used by the catalog (lots arrays), the order service (line check) and the admin product publish rule.
 */
type EnvLike = Record<string, string | undefined>;

export function isPublishedCoaRequired(env: EnvLike = process.env): boolean {
  return env.REQUIRE_PUBLISHED_COA === 'true';
}

/** The subset of PrismaService this check needs (so unit tests can pass a tiny double). */
export interface LotCoaReader {
  lot: {
    findMany(args: { where: { code: { in: string[] }; coas: { some: { status: 'PUBLISHED' } } }; select: { code: true } }): Promise<Array<{ code: string }>>;
  };
}

/** Which of these lot codes currently have a PUBLISHED COA. A single indexed query; empty input skips the database. */
export async function lotsWithPublishedCoa(prisma: LotCoaReader, lotCodes: readonly string[]): Promise<Set<string>> {
  const codes = [...new Set(lotCodes)];
  if (codes.length === 0) return new Set();
  const rows = await prisma.lot.findMany({ where: { code: { in: codes }, coas: { some: { status: 'PUBLISHED' } } }, select: { code: true } });
  return new Set(rows.map((row) => row.code));
}

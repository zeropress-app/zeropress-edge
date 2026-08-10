# ADR 0001: Retain complete-target comment loading and thread pagination

Status: Accepted

Date: 2026-09-06

## Decision

Load all approved comments for one Post/Page, repair parent relationships in
memory, paginate root threads, and return every descendant of the selected roots.
Retain the target-scoped KV cache with D1 as the source of truth.

No intended deployment has demonstrated a limit requiring a different design.
The current approach favors complete-thread semantics and simple maintenance.

## Why retain it

One collection supports parent repair, ordering, totals, and complete threads.
Imported or moderated comments can leave missing parents, cycles, or excessive
depth; handling the complete target avoids mistaking an off-page parent for a
missing one. Repairs affect the response, not stored comments.

The cache stores approved rows, so page size and ordering can be applied without
maintaining separate page/tree projections. See the
[public pagination behavior](../api/comments.md#read-comments) and
[pagination implementation](../../src/comments/pagination.ts).

| Alternative | Tradeoff |
| --- | --- |
| Paginate individual rows in SQL | Splits threads and changes the public contract |
| Select roots in SQL, then load descendants | Must reproduce repaired-root semantics or maintain tree metadata; large threads remain unbounded |
| Persist root/depth metadata or pages | Adds consistency work across writes, moderation, imports, and deletion |
| Paginate replies separately | Bounds large threads but requires API and frontend changes |

## Accepted costs and limits

Every read processes the full approved collection for one target, including cache
hits. Memory use grows with comment count and text size; sorting can require
`O(N log N)` comparisons. Large cache values may shift more work to D1.

Root pagination does not bound response rows or bytes: one selected root can
have many descendants. Pages may change across writes and moderation; the design
does not promise a transactional snapshot across D1 queries and KV reads.

There is no measured maximum supported comments-per-target value.
[Pagination tests](../../src/comments/pagination.test.ts), including a
20,000-comment chain, establish correctness rather than deployed capacity.

## When to revisit

Reconsider when a representative workload or product requirement demonstrates:

- CPU, memory, latency, or response-size limits that the design cannot meet.
- Ineffective caching that creates material D1 load or read failures.
- A need for bounded responses, partial replies, or different pagination semantics.

Measure in the intended Workers environment, including comment count, serialized
bytes, largest thread, and cache-hit/miss behavior. Compare alternatives against
the observed bottleneck while accounting for repair, ordering, and API changes.

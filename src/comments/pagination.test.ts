import { describe, expect, it } from 'vitest';

import { paginateComments } from './pagination';
import type { CommentData } from './types';

const CREATED_AT = '2026-06-21T07:59:34Z';

function createComment(
  publicId: number,
  parentPublicId: number | null,
  createdAt = CREATED_AT,
): CommentData {
  return {
    id: `comment-${publicId}`,
    public_id: publicId,
    target_id: 1,
    parent_public_id: parentPublicId,
    author_name: `Author ${publicId}`,
    author_kind: 'guest',
    content: `Comment ${publicId}`,
    status: 'approved',
    imported: 0,
    created_at: createdAt,
  };
}

function parentMap(comments: CommentData[]): Map<number, number | null> {
  return new Map(comments.map((comment) => [comment.public_id, comment.parent_public_id]));
}

describe('paginateComments', () => {
  it('preserves root pagination, root order, and ascending reply order for a valid graph', () => {
    const comments = [
      createComment(4, 1, '2026-06-21T04:00:00Z'),
      createComment(3, null, '2026-06-23T00:00:00Z'),
      createComment(1, null, '2026-06-20T00:00:00Z'),
      createComment(2, 1, '2026-06-21T02:00:00Z'),
    ];

    const firstPage = paginateComments(comments, { page: 1, perPage: 1, order: 'desc' });
    const secondPage = paginateComments(comments, { page: 2, perPage: 1, order: 'desc' });

    expect(firstPage).toMatchObject({ totalComments: 4, totalRoots: 2, totalPages: 2 });
    expect(firstPage.comments.map((comment) => comment.public_id)).toEqual([3]);
    expect(secondPage.comments.map((comment) => comment.public_id)).toEqual([1, 2, 4]);
  });

  it('repairs orphan, self-parent, and cyclic links on clones without mutating raw rows', () => {
    const comments = [
      createComment(9, 7),
      createComment(1, 999),
      createComment(8, 9),
      createComment(2, 2),
      createComment(7, 8),
    ];
    const originalParents = parentMap(comments);

    const result = paginateComments(comments, { page: 1, perPage: 10, order: 'asc' });
    const repairedParents = parentMap(result.comments);

    expect(result).toMatchObject({ totalComments: 5, totalRoots: 3, totalPages: 1 });
    expect(result.comments.map((comment) => comment.public_id)).toEqual([1, 2, 7, 9, 8]);
    expect(repairedParents).toEqual(new Map([
      [1, null],
      [2, null],
      [7, null],
      [9, 7],
      [8, 9],
    ]));
    expect(parentMap(comments)).toEqual(originalParents);
    for (const comment of result.comments) {
      expect(comment).not.toBe(comments.find((rawComment) => rawComment.public_id === comment.public_id));
    }
  });

  it('cuts the smallest public ID in a cycle independently of input order', () => {
    const ordered = [
      createComment(20, 30),
      createComment(30, 10),
      createComment(10, 20),
      createComment(40, 30),
    ];
    const shuffled = [ordered[3], ordered[1], ordered[0], ordered[2]];

    const orderedResult = paginateComments(ordered, { page: 1, perPage: 10, order: 'asc' });
    const shuffledResult = paginateComments(shuffled, { page: 1, perPage: 10, order: 'asc' });

    expect(parentMap(orderedResult.comments)).toEqual(new Map([
      [10, null],
      [30, 10],
      [20, 30],
      [40, 30],
    ]));
    expect(shuffledResult.comments).toEqual(orderedResult.comments);
  });

  it('promotes the 11th and 21st comments to roots and returns every comment once across pages', () => {
    const comments = Array.from(
      { length: 25 },
      (_value, index) => createComment(index + 1, index === 0 ? null : index),
    ).reverse();

    const firstPage = paginateComments(comments, { page: 1, perPage: 2, order: 'asc' });
    const secondPage = paginateComments(comments, { page: 2, perPage: 2, order: 'asc' });
    const allComments = [...firstPage.comments, ...secondPage.comments];
    const repairedParents = parentMap(allComments);

    expect(firstPage).toMatchObject({ totalComments: 25, totalRoots: 3, totalPages: 2 });
    expect(firstPage.comments.map((comment) => comment.public_id)).toEqual(
      Array.from({ length: 20 }, (_value, index) => index + 1),
    );
    expect(secondPage.comments.map((comment) => comment.public_id)).toEqual([21, 22, 23, 24, 25]);
    expect(repairedParents.get(10)).toBe(9);
    expect(repairedParents.get(11)).toBeNull();
    expect(repairedParents.get(20)).toBe(19);
    expect(repairedParents.get(21)).toBeNull();
    expect(new Set(allComments.map((comment) => comment.public_id)).size).toBe(25);
    expect(comments.find((comment) => comment.public_id === 11)?.parent_public_id).toBe(10);
    expect(comments.find((comment) => comment.public_id === 21)?.parent_public_id).toBe(20);
  });

  it('handles a 20,000-comment chain without recursion or omissions', () => {
    const commentCount = 20_000;
    const comments = Array.from(
      { length: commentCount },
      (_value, index) => createComment(index + 1, index === 0 ? null : index),
    ).reverse();

    const result = paginateComments(comments, {
      page: 1,
      perPage: commentCount,
      order: 'asc',
    });

    expect(result).toMatchObject({
      totalComments: commentCount,
      totalRoots: commentCount / 10,
      totalPages: 1,
    });
    expect(result.comments).toHaveLength(commentCount);
    expect(result.comments.map((comment) => comment.public_id)).toEqual(
      Array.from({ length: commentCount }, (_value, index) => index + 1),
    );
    expect(new Set(result.comments.map((comment) => comment.public_id)).size).toBe(commentCount);
    expect(result.comments.filter((comment) => comment.parent_public_id === null)).toHaveLength(commentCount / 10);
  }, 10_000);
});

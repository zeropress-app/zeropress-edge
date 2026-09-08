import { normalizeCommentTimestamp } from './format';
import type { CommentData, CommentPaginationResult, CommentTreeNode } from './types';

const MAX_COMMENT_TREE_DEPTH = 10;

export function paginateComments(
  comments: CommentData[],
  options: { page: number; perPage: number; order: 'asc' | 'desc' },
): CommentPaginationResult {
  const repairedComments = repairCommentGraph(comments);
  const roots = buildCommentTreeNodes(repairedComments, options.order);
  const totalRoots = roots.length;
  const totalPages = totalRoots === 0 ? 0 : Math.ceil(totalRoots / options.perPage);
  const startIndex = (options.page - 1) * options.perPage;
  const selectedRoots = roots.slice(startIndex, startIndex + options.perPage);
  const selectedComments = collectCommentThreads(selectedRoots);

  return {
    comments: selectedComments,
    totalComments: repairedComments.length,
    totalRoots,
    totalPages,
  };
}

function repairCommentGraph(comments: CommentData[]): CommentData[] {
  const repairedComments = comments.map((comment) => ({ ...comment }));
  const commentMap = new Map(repairedComments.map((comment) => [comment.public_id, comment]));

  repairInvalidParentLinks(repairedComments, commentMap);
  repairCycles(repairedComments, commentMap);
  enforceMaximumDepth(repairedComments, commentMap);

  return repairedComments;
}

function repairInvalidParentLinks(comments: CommentData[], commentMap: Map<number, CommentData>): void {
  for (const comment of comments) {
    const parentPublicId = comment.parent_public_id;
    if (
      parentPublicId !== null
      && (parentPublicId === comment.public_id || !commentMap.has(parentPublicId))
    ) {
      comment.parent_public_id = null;
    }
  }
}

function repairCycles(comments: CommentData[], commentMap: Map<number, CommentData>): void {
  const completedCommentIds = new Set<number>();

  for (const startingComment of comments) {
    if (completedCommentIds.has(startingComment.public_id)) {
      continue;
    }

    const path: CommentData[] = [];
    const pathIndexes = new Map<number, number>();
    let currentComment: CommentData | undefined = startingComment;

    while (currentComment && !completedCommentIds.has(currentComment.public_id)) {
      const cycleStartIndex = pathIndexes.get(currentComment.public_id);
      if (cycleStartIndex !== undefined) {
        let linkToCut = path[cycleStartIndex];
        for (let index = cycleStartIndex + 1; index < path.length; index += 1) {
          if (path[index].public_id < linkToCut.public_id) {
            linkToCut = path[index];
          }
        }
        linkToCut.parent_public_id = null;
        break;
      }

      pathIndexes.set(currentComment.public_id, path.length);
      path.push(currentComment);
      currentComment = currentComment.parent_public_id === null
        ? undefined
        : commentMap.get(currentComment.parent_public_id);
    }

    for (const comment of path) {
      completedCommentIds.add(comment.public_id);
    }
  }
}

function enforceMaximumDepth(comments: CommentData[], commentMap: Map<number, CommentData>): void {
  const depths = new Map<number, number>();

  for (const startingComment of comments) {
    if (depths.has(startingComment.public_id)) {
      continue;
    }

    const path: CommentData[] = [];
    let currentComment: CommentData | undefined = startingComment;

    while (currentComment && !depths.has(currentComment.public_id)) {
      path.push(currentComment);
      currentComment = currentComment.parent_public_id === null
        ? undefined
        : commentMap.get(currentComment.parent_public_id);
    }

    let parentDepth = currentComment ? depths.get(currentComment.public_id) || 0 : 0;
    for (let index = path.length - 1; index >= 0; index -= 1) {
      const comment = path[index];
      if (parentDepth >= MAX_COMMENT_TREE_DEPTH) {
        comment.parent_public_id = null;
        parentDepth = 1;
      } else {
        parentDepth += 1;
      }
      depths.set(comment.public_id, parentDepth);
    }
  }
}

function compareCommentsByCreatedAt(left: CommentData, right: CommentData, order: 'asc' | 'desc'): number {
  const leftTime = new Date(normalizeCommentTimestamp(left.created_at) || left.created_at).getTime();
  const rightTime = new Date(normalizeCommentTimestamp(right.created_at) || right.created_at).getTime();
  const normalizedLeftTime = Number.isNaN(leftTime) ? 0 : leftTime;
  const normalizedRightTime = Number.isNaN(rightTime) ? 0 : rightTime;
  const timeDiff = normalizedLeftTime - normalizedRightTime;

  if (timeDiff !== 0) {
    return order === 'desc' ? -timeDiff : timeDiff;
  }

  return order === 'desc'
    ? right.public_id - left.public_id
    : left.public_id - right.public_id;
}

function buildCommentTreeNodes(comments: CommentData[], order: 'asc' | 'desc'): CommentTreeNode[] {
  const nodeMap = new Map<number, CommentTreeNode>();
  const roots: CommentTreeNode[] = [];

  for (const comment of comments) {
    nodeMap.set(comment.public_id, {
      comment,
      children: [],
    });
  }

  for (const comment of comments) {
    const node = nodeMap.get(comment.public_id);
    if (!node) {
      continue;
    }

    const parentNode = comment.parent_public_id === null
      ? undefined
      : nodeMap.get(comment.parent_public_id);
    if (parentNode) {
      parentNode.children.push(node);
    } else {
      roots.push(node);
    }
  }

  roots.sort((left, right) => compareCommentsByCreatedAt(left.comment, right.comment, order));
  sortCommentTreeChildren(roots);
  return roots;
}

function sortCommentTreeChildren(roots: CommentTreeNode[]): void {
  const pendingNodes = [...roots];

  while (pendingNodes.length > 0) {
    const node = pendingNodes.pop();
    if (!node) {
      continue;
    }

    node.children.sort((left, right) => compareCommentsByCreatedAt(left.comment, right.comment, 'asc'));
    for (const childNode of node.children) {
      pendingNodes.push(childNode);
    }
  }
}

function collectCommentThreads(roots: CommentTreeNode[]): CommentData[] {
  const comments: CommentData[] = [];
  const pendingNodes: CommentTreeNode[] = [];

  for (let index = roots.length - 1; index >= 0; index -= 1) {
    pendingNodes.push(roots[index]);
  }

  while (pendingNodes.length > 0) {
    const node = pendingNodes.pop();
    if (!node) {
      continue;
    }

    comments.push(node.comment);
    for (let index = node.children.length - 1; index >= 0; index -= 1) {
      pendingNodes.push(node.children[index]);
    }
  }

  return comments;
}

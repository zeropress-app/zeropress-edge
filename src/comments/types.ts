export type CommentTargetType = 'post' | 'page';

export type CommentAuthorKind = 'guest' | 'site_user' | 'authenticated_user';

export type CommentTargetRef = {
  targetType: CommentTargetType;
  targetPublicId: number;
};

export type CommentTargetPolicy = {
  id: number;
  target_type: CommentTargetType;
  public_id: number;
  status: string;
  allow_comments: number;
  request_token_nonce: string;
  comments_cache_revision: string;
};

export type CommentData = {
  id: string;
  public_id: number;
  target_id: number;
  parent_public_id: number | null;
  author_name: string;
  author_kind: CommentAuthorKind;
  content: string;
  status: string;
  imported: number | boolean | null;
  created_at: string;
};

export type CommentListItemData = {
  id: number;
  parent_id: number | null;
  author_name: string;
  author_kind: CommentAuthorKind;
  created_at_iso: string;
  content_text: string;
};

export type CommentRuntimeConfig = {
  disallowComments: boolean;
  requireCommentApproval: boolean;
  perPage: number;
  order: 'asc' | 'desc';
  threadComments: boolean;
  threadCommentsDepth: number;
  cacheTtlSeconds: number;
  apiBaseUrl: string | null;
};

export type CommentPaginationResult = {
  comments: CommentData[];
  totalComments: number;
  totalRoots: number;
  totalPages: number;
};

export type CommentTreeNode = {
  comment: CommentData;
  children: CommentTreeNode[];
};

export type InsertedCommentPublicIdRow = {
  public_id: number;
};

export type CreateCommentInput = {
  targetId: number;
  parentPublicId: number | null;
  authorName: string;
  authorEmail: string;
  content: string;
  status: string;
  clientIP: string;
  ipHash: string | null;
  userAgent: string | null;
  asn: number | null;
  asOrganization: string | null;
  countryCode: string | null;
  authorKind: 'guest' | 'authenticated_user';
  authorIdentityIssuer: string | null;
  authorUserId: string | null;
};

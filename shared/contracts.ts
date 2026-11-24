// Shared wire formats for the HTTP server and bookmark reader.
export type ReviewState = 'inbox' | 'kept' | 'archive';

export type MediaAttachment =
  | { type: 'photo'; src: string; alt?: string; poster?: string }
  | { type: 'video' | 'animated_gif'; src?: string; poster?: string; alt?: string }
  | { type: 'unavailable'; poster?: string; alt?: string };

export interface PostPart {
  id: string;
  author: string;
  handle: string;
  body: string;
  date: string;
  media: MediaAttachment[];
  authorId?: string;
  conversationId?: string;
  parentId?: string;
  parentAuthorId?: string;
  quoteId?: string;
  article?: { title: string; paragraphs: string[] };
  links?: { url: string; expanded: string }[];
  replyCount?: number;
}

export interface PostContext {
  unroll?: {related:number;fetchedAt:string};
  quotes: PostPart[];
  thread: PostPart[];
  checked?: boolean;
  warning?: string;
}

export interface Post extends PostPart {
  fromTimeline?: boolean;
  context?: PostContext;
}

export interface Bookmark extends Post {
  state: ReviewState;
  tags: string[];
}

export type BookmarkEdit = Partial<Pick<Bookmark, 'state' | 'tags'>>;

export interface LibraryResponse {
  posts: Bookmark[];
  name: string;
  demo: boolean;
  configured: boolean;
  connected: boolean;
  canRemove: boolean;
  resume: boolean;
  callback: string;
}

export interface SyncResponse {
  added: number;
  more: boolean;
  partial: boolean;
}

export interface AuthorizationResponse { url: string }
export interface SuccessResponse { ok: true }

export type Preview =
  | { kind: 'saved'; url: string; post: Post }
  | { kind: 'public'; url: string; author: string; html: string }
  | { kind: 'external' | 'self' | 'unavailable'; url: string; message: string; retryable?: boolean };

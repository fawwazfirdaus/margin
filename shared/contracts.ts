// Shared wire formats for the HTTP server and bookmark reader.
export type ReviewState = 'inbox' | 'kept' | 'archive';

export type MediaAttachment =
  | { type: 'photo'; src: string; alt?: string; poster?: string }
  | { type: 'video' | 'animated_gif'; src?: string; poster?: string; alt?: string }
  | { type: 'unavailable'; poster?: string; alt?: string };

export interface Post {
  id: string;
  author: string;
  handle: string;
  body: string;
  date: string;
  media: MediaAttachment[];
  fromTimeline?: boolean;
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

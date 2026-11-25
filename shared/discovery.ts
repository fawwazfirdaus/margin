import type { SelectedPart } from './free-thread.js';
import type { Bookmark, ReviewState, VideoAttachment } from './contracts.ts';

export interface Filters {
  state?: ReviewState;
  author?: string;
  tag?: string;
  media?: 'photo' | 'video' | 'text';
  after?: string;
  before?: string;
  collection?: number;
}
export interface SearchSpec {
  q: string;
  filters: Filters;
}
export interface Evidence {
  source: 'post' | 'alt' | 'image' | 'quote' | 'thread' | 'linked' | 'selected' | 'article';
  postId?: string;
  attachment?: number;
  paragraph?: number;
  author?: string;
  slot: number;
  text: string;
}
export interface Hit {
  id: string;
  author: string;
  handle: string;
  date: string;
  state: ReviewState;
  preview?: string;
  video?: Pick<VideoAttachment, 'src' | 'variants'>;
  evidence: Evidence;
  terms: string[];
}
export interface Results {
  hits: Hit[];
  total: number;
  semantic: boolean;
}
export interface Shelf {
  id: number;
  name: string;
  count: number;
}
export interface SavedSearch extends SearchSpec {
  id: number;
  name: string;
}
export interface Catalog {
  collections: Shelf[];
  searches: SavedSearch[];
  authors: string[];
  tags: string[];
  all: number;
  inbox: number;
  kept: number;
  archive: number;
}
export type WordBox = [string, number, number, number, number];
export interface PhotoJob {
  id: string;
  slot: number;
  src: string;
}
export interface ReaderData {
  post: Bookmark;
  selectedThread:SelectedPart[];
  linked: {slot:number;id:string;url:string;author:string;body:string}[];
  collections: number[];
  photos: { slot: number; postId?: string; attachment: number; words: WordBox[]; text: string }[];
}
export interface Coverage {
  threads:{active:boolean;waiting:number;unavailable:number;failed:number;checked:number;threads:number};
  links: {indexed:number; pending:number; failed:number; skipped:number; unavailable:number};
  total: number;
  ready: number;
  empty: number;
  failed: number;
  passages: number;
  embedded: number;
  modelError: string;
}
export interface Answer {
  text: string;
  citations: Hit[];
  mode: 'count' | 'model' | 'evidence' | 'empty';
}

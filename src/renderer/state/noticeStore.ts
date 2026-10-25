import { create } from "zustand";

export type NoticeTone = "info" | "error";

export interface Notice {
  text: string;
  tone: NoticeTone;
}

interface NoticeStore {
  notice?: Notice;
  /** Shows `text` for `durationMs`; replaces the notice shown before. */
  show: (text: string, tone?: NoticeTone, durationMs?: number) => void;
  clear: () => void;
}

export const NOTICE_MS = 3500;

// One timer for the one notice: a new notice cancels the timer of the
// previous one, so an old timer never clears a newer notice.
let timer: ReturnType<typeof setTimeout> | undefined;

/** Short results of actions (exports, clearing the tile cache) in the status bar. */
export const useNoticeStore = create<NoticeStore>((set) => ({
  show: (text, tone = "info", durationMs = NOTICE_MS) => {
    clearTimeout(timer);
    set({ notice: { text, tone } });
    timer = setTimeout(() => {
      timer = undefined;
      set({ notice: undefined });
    }, durationMs);
  },
  clear: () => {
    clearTimeout(timer);
    timer = undefined;
    set({ notice: undefined });
  }
}));

import { create } from "zustand";
import { runExport, type ExportOptions } from "../modules/app/lib/exportCapture";
import { useNoticeStore } from "./noticeStore";
import { selectCurrentRun, useTracerouteStore } from "./tracerouteStore";

interface ExportStore {
  working: boolean;
  dialogOpen: boolean;
  openDialog: () => void;
  closeDialog: () => void;
  /** Exports the current run; does nothing while an export runs or without a run. */
  start: (options: ExportOptions) => Promise<void>;
}

/**
 * Export state shared by the footer button, the export dialog and the
 * command bar. The result goes to the notice store, whose timer only clears
 * the notice: a finished export's timer cannot reset a newer export.
 */
export const useExportStore = create<ExportStore>((set, get) => ({
  working: false,
  dialogOpen: false,
  openDialog: () => {
    if (!get().working && selectCurrentRun(useTracerouteStore.getState())) {
      set({ dialogOpen: true });
    }
  },
  closeDialog: () => set({ dialogOpen: false }),
  start: async (options) => {
    const run = selectCurrentRun(useTracerouteStore.getState());
    if (!run || get().working) {
      return;
    }
    const notices = useNoticeStore.getState();
    notices.clear();
    set({ working: true, dialogOpen: false });
    try {
      const { filename } = await runExport(options, run);
      notices.show(`Saved ${filename}`);
    } catch (error) {
      notices.show(error instanceof Error ? error.message : "Export failed", "error");
    } finally {
      set({ working: false });
    }
  }
}));

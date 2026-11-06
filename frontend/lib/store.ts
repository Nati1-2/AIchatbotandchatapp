import { create } from "zustand";
export const useUI = create<{
  active: string | null;
  /** A message to scroll to once its conversation opens (from search). */
  focusMessage: string | null;
  setActive: (id: string | null) => void;
  openMessage: (conversationId: string, messageId: string) => void;
  clearFocus: () => void;
}>((set) => ({
  active: null,
  focusMessage: null,
  setActive: (active) => set({ active }),
  openMessage: (active, focusMessage) => set({ active, focusMessage }),
  clearFocus: () => set({ focusMessage: null }),
}));

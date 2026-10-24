import { create } from "zustand";
export const useUI = create<{
  active: string | null;
  setActive: (id: string | null) => void;
}>((set) => ({ active: null, setActive: (active) => set({ active }) }));

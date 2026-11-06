"use client";
import * as D from "@radix-ui/react-dialog";
import { X } from "lucide-react";
export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  children: React.ReactNode;
}) {
  return (
    <D.Root open={open} onOpenChange={onOpenChange}>
      <D.Portal>
        <D.Overlay className="dialog-overlay" />
        <D.Content className="dialog-content">
          <div className="dialog-heading">
            <D.Title>{title}</D.Title>
            <D.Close
              aria-label="Close dialog"
              className="button button-ghost button-icon"
            >
              <X size={18} />
            </D.Close>
          </div>
          <D.Description className={description ? "muted" : "sr-only"}>
            {description || title}
          </D.Description>
          {children}
        </D.Content>
      </D.Portal>
    </D.Root>
  );
}

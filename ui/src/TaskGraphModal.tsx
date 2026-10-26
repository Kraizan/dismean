import { useEffect, type ReactNode } from "react";

export function TaskGraphModal({
  title,
  onClose,
  children,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [onClose]);

  return (
    <div className="task-graph-modal-root">
      <button
        type="button"
        className="task-graph-modal-backdrop"
        aria-label="Close task graph"
        onClick={onClose}
      />
      <div
        className="task-graph-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="task-graph-modal-title"
      >
        <header className="task-graph-modal-header">
          <h2 id="task-graph-modal-title">{title}</h2>
          <button type="button" className="secondary btn-sm" onClick={onClose}>
            Close
          </button>
        </header>
        <div className="task-graph-modal-body">{children}</div>
      </div>
    </div>
  );
}

/** @vitest-environment jsdom */
import { CompactModal } from "@/components/compact-modal";
import { ConfirmSubmitButton } from "@/components/confirm-delete-button";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

describe("CompactModal", () => {
  it("exposes dialog semantics", () => {
    render(
      <CompactModal ariaLabel="Meal Templates" title="Meal Templates" onClose={() => {}}>
        <button type="button">Inside</button>
      </CompactModal>,
    );

    const dialog = screen.getByRole("dialog", { name: "Meal Templates" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
  });

  it("closes on Escape", () => {
    const onClose = vi.fn();
    render(
      <CompactModal ariaLabel="Meal Templates" title="Meal Templates" onClose={onClose}>
        <button type="button">Inside</button>
      </CompactModal>,
    );

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("moves focus into the dialog and restores it on close", () => {
    const trigger = document.createElement("button");
    trigger.textContent = "Open";
    document.body.appendChild(trigger);
    trigger.focus();
    expect(document.activeElement).toBe(trigger);

    const { unmount } = render(
      <CompactModal ariaLabel="Meal Templates" title="Meal Templates" onClose={() => {}}>
        <button type="button">Inside</button>
      </CompactModal>,
    );

    expect(document.activeElement).not.toBe(trigger);
    const dialog = screen.getByRole("dialog", { name: "Meal Templates" });
    expect(dialog.contains(document.activeElement)).toBe(true);

    unmount();
    expect(document.activeElement).toBe(trigger);
    trigger.remove();
  });

  it("wraps Tab from the last focusable element back to the first", () => {
    render(
      <CompactModal ariaLabel="Meal Templates" title="Meal Templates" onClose={() => {}}>
        <button type="button">First</button>
        <button type="button">Last</button>
      </CompactModal>,
    );

    const last = screen.getByRole("button", { name: "Last" });
    last.focus();
    fireEvent.keyDown(document, { key: "Tab" });

    // The close button is the first focusable node in the dialog.
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
  });
});

describe("ConfirmSubmitButton", () => {
  it("swallows the first click and submits on the second", () => {
    const onSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());

    render(
      <form onSubmit={onSubmit}>
        <ConfirmSubmitButton
          confirmLabel="Tap again to revoke"
          className="idle"
          armedClassName="armed"
        >
          Revoke
        </ConfirmSubmitButton>
      </form>,
    );

    const button = screen.getByRole("button", { name: "Revoke" });
    fireEvent.click(button);

    expect(onSubmit).not.toHaveBeenCalled();
    const armed = screen.getByRole("button", { name: "Tap again to revoke" });
    expect(armed.getAttribute("data-armed")).toBe("true");

    fireEvent.click(armed);
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("announces the armed state", () => {
    render(
      <form>
        <ConfirmSubmitButton
          confirmLabel="Tap again to change role"
          className="idle"
          armedClassName="armed"
        >
          Update role
        </ConfirmSubmitButton>
      </form>,
    );

    const status = screen.getByRole("status");
    expect(status.textContent).toBe("");

    fireEvent.click(screen.getByRole("button", { name: "Update role" }));
    expect(status.textContent).toContain("Tap again to change role");
  });
});

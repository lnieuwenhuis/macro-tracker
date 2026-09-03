import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests so queries never see a previous render's DOM.
afterEach(() => {
  cleanup();
});

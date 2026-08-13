import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

// Unmount between tests so queries never see a previous render's DOM. Harmless
// in the node environment, where there is nothing mounted to clean up.
afterEach(() => {
  cleanup();
});

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  FOOD_PHOTO_TARGET_BYTES,
  optimizeFoodPhoto,
  replaceFoodPhotoObjectUrl,
  setOptimizedFoodPhoto,
} from "@/lib/image-optimization";

type CanvasStub = {
  width: number;
  height: number;
  getContext: ReturnType<typeof vi.fn>;
  toBlob: ReturnType<typeof vi.fn>;
};

const originalDocument = globalThis.document;
const originalCreateImageBitmap = globalThis.createImageBitmap;

afterEach(() => {
  vi.restoreAllMocks();
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: originalDocument,
  });
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: originalCreateImageBitmap,
  });
});

function installImageStubs(blobSizes: number[], width = 3200, height = 1600) {
  const close = vi.fn();
  const canvases: CanvasStub[] = [];
  const dimensions: Array<[number, number]> = [];
  const qualities: number[] = [];
  Object.defineProperty(globalThis, "createImageBitmap", {
    configurable: true,
    value: vi.fn().mockResolvedValue({ width, height, close }),
  });
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: vi.fn(() => {
        const canvas: CanvasStub = {
          width: 0,
          height: 0,
          getContext: vi.fn(() => ({
            fillStyle: "",
            fillRect: vi.fn(),
            drawImage: vi.fn(),
          })),
          toBlob: vi.fn((callback: (blob: Blob) => void, _type: string, quality: number) => {
            qualities.push(quality);
            dimensions.push([canvas.width, canvas.height]);
            callback(new Blob([new Uint8Array(blobSizes.shift() ?? 1)], { type: "image/jpeg" }));
          }),
        };
        canvases.push(canvas);
        return canvas;
      }),
    },
  });
  return { canvases, close, dimensions, qualities };
}

describe("optimizeFoodPhoto", () => {
  it("resizes without upscaling, falls back through qualities, and releases resources", async () => {
    const stubs = installImageStubs([FOOD_PHOTO_TARGET_BYTES + 1, 1024]);
    const file = new File([new Uint8Array(1024)], "photo.png", { type: "image/png" });

    const result = await optimizeFoodPhoto(file);

    expect(result.type).toBe("image/jpeg");
    expect(stubs.qualities).toEqual([0.82, 0.72]);
    expect(stubs.dimensions).toEqual([[1600, 800], [1600, 800]]);
    expect(stubs.canvases).toHaveLength(1);
    expect(stubs.canvases[0]?.width).toBe(0);
    expect(stubs.canvases[0]?.height).toBe(0);
    expect(stubs.close).toHaveBeenCalledOnce();
  });

  it("retries at smaller dimensions when all qualities exceed the target", async () => {
    const tooLarge = FOOD_PHOTO_TARGET_BYTES + 1;
    const stubs = installImageStubs([tooLarge, tooLarge, tooLarge, 1000]);
    const file = new File([new Uint8Array(1000)], "photo.gif", { type: "image/gif" });

    await optimizeFoodPhoto(file);

    expect(stubs.canvases).toHaveLength(2);
    expect(stubs.dimensions.at(-1)).toEqual([1280, 640]);
    expect(stubs.qualities).toEqual([0.82, 0.72, 0.62, 0.82]);
    expect(stubs.close).toHaveBeenCalledOnce();
  });

  it("keeps a small original when conversion is unavailable", async () => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });
    const file = new File([new Uint8Array(1000)], "photo.webp", { type: "image/webp" });

    await expect(optimizeFoodPhoto(file)).resolves.toBe(file);
  });

  it("rejects a large original when conversion is unavailable", async () => {
    Object.defineProperty(globalThis, "createImageBitmap", {
      configurable: true,
      value: undefined,
    });
    const file = new File(
      [new Uint8Array(FOOD_PHOTO_TARGET_BYTES + 1)],
      "photo.webp",
      { type: "image/webp" },
    );

    await expect(optimizeFoodPhoto(file)).rejects.toThrow("below 2 MB");
  });
});

describe("optimized photo lifecycle", () => {
  it("revokes replaced URLs and uploads the optimized blob", () => {
    const revoke = vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
    const create = vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:optimized");
    const blob = new Blob(["optimized"], { type: "image/jpeg" });

    expect(replaceFoodPhotoObjectUrl("blob:original", blob)).toBe("blob:optimized");
    expect(revoke).toHaveBeenCalledWith("blob:original");
    expect(create).toHaveBeenCalledWith(blob);

    const formData = new FormData();
    setOptimizedFoodPhoto(formData, blob);
    expect((formData.get("image") as File).size).toBe(blob.size);
    expect((formData.get("image") as File).name).toBe("food-photo.jpg");
  });
});

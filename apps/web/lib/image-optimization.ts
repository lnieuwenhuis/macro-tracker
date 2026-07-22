const TARGET_IMAGE_BYTES = 2 * 1024 * 1024;
const MAX_EDGES = [1600, 1280, 1024] as const;
const JPEG_QUALITIES = [0.82, 0.72, 0.62] as const;

function canvasToJpeg(canvas: HTMLCanvasElement, quality: number) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (blob) {
          resolve(blob);
        } else {
          reject(new Error("The browser could not encode this image."));
        }
      },
      "image/jpeg",
      quality,
    );
  });
}

function originalOrError(file: File) {
  if (file.size <= TARGET_IMAGE_BYTES) {
    return file;
  }
  throw new Error(
    "This browser could not optimize the image below 2 MB. Try another image.",
  );
}

export async function optimizeFoodPhoto(file: File): Promise<Blob> {
  if (typeof createImageBitmap !== "function") {
    return originalOrError(file);
  }

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return originalOrError(file);
  }

  try {
    const longestEdge = Math.max(bitmap.width, bitmap.height);
    const edges = [...new Set(MAX_EDGES.map((edge) => Math.min(edge, longestEdge)))];

    for (const edge of edges) {
      const scale = Math.min(1, edge / longestEdge);
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;

      try {
        const context = canvas.getContext("2d");
        if (!context) {
          return originalOrError(file);
        }
        context.fillStyle = "#ffffff";
        context.fillRect(0, 0, width, height);
        context.drawImage(bitmap, 0, 0, width, height);

        for (const quality of JPEG_QUALITIES) {
          const optimized = await canvasToJpeg(canvas, quality);
          if (optimized.size <= TARGET_IMAGE_BYTES) {
            return optimized;
          }
        }
      } catch {
        return originalOrError(file);
      } finally {
        canvas.width = 0;
        canvas.height = 0;
      }
    }
  } finally {
    bitmap.close();
  }

  return originalOrError(file);
}

export const FOOD_PHOTO_TARGET_BYTES = TARGET_IMAGE_BYTES;

export function replaceFoodPhotoObjectUrl(currentUrl: string | null, blob: Blob | null) {
  if (currentUrl) {
    URL.revokeObjectURL(currentUrl);
  }
  return blob ? URL.createObjectURL(blob) : null;
}

export function setOptimizedFoodPhoto(formData: FormData, blob: Blob) {
  formData.set("image", blob, "food-photo.jpg");
}

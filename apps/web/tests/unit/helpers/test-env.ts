export async function withBackendUrl<T>(url: string, operation: () => Promise<T>) {
  const previous = process.env.BACKEND_URL;
  process.env.BACKEND_URL = url;
  try {
    return await operation();
  } finally {
    if (previous === undefined) {
      delete process.env.BACKEND_URL;
    } else {
      process.env.BACKEND_URL = previous;
    }
  }
}

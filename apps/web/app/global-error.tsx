"use client";

export default function GlobalError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html>
      <body
        style={{
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          justifyContent: "center",
          minHeight: "100vh",
          fontFamily: "sans-serif",
          gap: "1rem",
          padding: "2rem",
        }}
      >
        <h2 style={{ margin: 0 }}>Something went wrong</h2>
        <button
          type="button"
          onClick={reset}
          style={{
            padding: "0.5rem 1.25rem",
            borderRadius: "999px",
            border: "none",
            background: "#ca6b3a",
            color: "#fff",
            fontWeight: 600,
            cursor: "pointer",
          }}
        >
          Try again
        </button>
      </body>
    </html>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";

import type {
  AnalyzeFoodPhotoResult,
  FoodPhotoEstimate,
} from "@/lib/ai-food-photo";
import {
  optimizeFoodPhoto,
  replaceFoodPhotoObjectUrl,
  setOptimizedFoodPhoto,
} from "@/lib/image-optimization";

import { CloseButton } from "./close-button";
import { ModalSurface } from "./modal-surface";
import { OverlayPortal } from "./overlay-portal";

type AiFoodPhotoModalProps = {
  onClose: () => void;
  onAddToLog: (macros: {
    label: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  }) => void;
  onSaveAsPreset: (input: {
    label: string;
    proteinG: number;
    carbsG: number;
    fatG: number;
    caloriesKcal: number;
  }) => void;
};

type ApiResponse =
  | AnalyzeFoodPhotoResult
  | { ok: false; error: string; aiResponse?: string };

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const ALLOWED_FORMATS_LABEL = "Allowed formats: JPEG/JPG, PNG, WebP, or GIF. HEIC is not supported.";

function estimateToMacros(estimate: FoodPhotoEstimate) {
  return {
    label: estimate.label,
    proteinG: estimate.proteinG,
    carbsG: estimate.carbsG,
    fatG: estimate.fatG,
    caloriesKcal: estimate.caloriesKcal,
  };
}

export function AiFoodPhotoModal({
  onClose,
  onAddToLog,
  onSaveAsPreset,
}: AiFoodPhotoModalProps) {
  const libraryInputRef = useRef<HTMLInputElement>(null);
  const cameraInputRef = useRef<HTMLInputElement>(null);
  const optimizationSequenceRef = useRef(0);
  const previewUrlRef = useRef<string | null>(null);
  const [imageFile, setImageFile] = useState<Blob | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [clarification, setClarification] = useState("");
  const [question, setQuestion] = useState<string | null>(null);
  const [estimate, setEstimate] = useState<FoodPhotoEstimate | null>(null);
  const [savedPreset, setSavedPreset] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [isOptimizing, setIsOptimizing] = useState(false);

  useEffect(() => () => {
    optimizationSequenceRef.current += 1;
    if (previewUrlRef.current) {
      URL.revokeObjectURL(previewUrlRef.current);
    }
  }, []);

  function replacePreview(blob: Blob | null) {
    const nextUrl = replaceFoodPhotoObjectUrl(previewUrlRef.current, blob);
    previewUrlRef.current = nextUrl;
    setPreviewUrl(nextUrl);
  }

  async function handleFileChange(file: File | null) {
    const sequence = optimizationSequenceRef.current + 1;
    optimizationSequenceRef.current = sequence;
    replacePreview(null);

    setEstimate(null);
    setQuestion(null);
    setClarification("");
    setSavedPreset(false);
    setError(null);

    if (!file) {
      setImageFile(null);
      return;
    }

    if (!["image/jpeg", "image/png", "image/webp", "image/gif"].includes(file.type)) {
      setError("Unsupported file format. Use JPEG/JPG, PNG, WebP, or GIF.");
      setImageFile(null);
      return;
    }

    if (file.size > MAX_IMAGE_BYTES) {
      setError("Image is too large. Use an image under 8 MB.");
      setImageFile(null);
      return;
    }

    setImageFile(null);
    setIsOptimizing(true);
    try {
      const optimized = await optimizeFoodPhoto(file);
      if (optimizationSequenceRef.current !== sequence) {
        return;
      }
      setImageFile(optimized);
      replacePreview(optimized);
    } catch (optimizationError) {
      if (optimizationSequenceRef.current === sequence) {
        setError(
          optimizationError instanceof Error
            ? optimizationError.message
            : "Unable to optimize this image. Try another image.",
        );
      }
    } finally {
      if (optimizationSequenceRef.current === sequence) {
        setIsOptimizing(false);
      }
    }
  }

  async function analyzePhoto() {
    if (!imageFile) {
      setError("Choose a food photo first.");
      return;
    }

    const formData = new FormData();
    setOptimizedFoodPhoto(formData, imageFile);
    formData.set("clarification", clarification);

    setIsAnalyzing(true);
    setError(null);

    try {
      const response = await fetch("/api/ai/food-photo", {
        method: "POST",
        body: formData,
      });
      const payload = (await response.json()) as ApiResponse;

      if (!payload.ok) {
        if (payload.aiResponse) {
          console.error("Food photo AI response could not be parsed.", {
            aiResponse: payload.aiResponse,
          });
        }
        setError(payload.error || "Unable to analyze this photo.");
        return;
      }

      if (payload.analysis.status === "needs_clarification") {
        setQuestion(payload.analysis.question);
        setEstimate(null);
        return;
      }

      setQuestion(null);
      setEstimate(payload.analysis.estimate);
      setSavedPreset(false);
    } catch {
      setError("Unable to analyze this photo right now.");
    } finally {
      setIsAnalyzing(false);
    }
  }

  function handleAddEstimate() {
    if (!estimate) return;
    onAddToLog(estimateToMacros(estimate));
  }

  return (
    <OverlayPortal>
      <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
        <div
          className="absolute inset-0 bg-black/40 backdrop-blur-sm"
          onClick={() => {
            if (!isAnalyzing) {
              onClose();
            }
          }}
        />
        <ModalSurface
          ariaLabel="Estimate from photo"
          onClose={onClose}
          dismissable={!isAnalyzing}
          className="relative z-10 mx-4 mb-4 w-full max-w-sm rounded-2xl border border-[var(--color-border)] bg-[var(--color-surface-strong)] shadow-2xl outline-none sm:mb-0"
        >
          <div className="flex items-center justify-between border-b border-[var(--color-border)] px-5 py-4">
            <div>
              <h3 className="text-base font-bold text-[var(--color-ink)]">
                Estimate from photo
              </h3>
              <p className="text-xs text-[var(--color-muted)]">
                Take a picture now or choose one from your library.
              </p>
            </div>
            <CloseButton
              onClick={() => {
                if (!isAnalyzing) {
                  onClose();
                }
              }}
              disabled={isAnalyzing}
            />
          </div>

          <div className="space-y-4 p-5">
            <div className="relative flex aspect-[4/3] w-full items-center justify-center overflow-hidden rounded-xl border border-dashed border-[var(--color-border-strong)] bg-[var(--color-shell-panel)] text-sm font-semibold text-[var(--color-muted)]">
              {previewUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={previewUrl}
                  alt="The food photo you selected, ready to analyse"
                  className="h-full w-full object-cover"
                />
              ) : (
                <span className="px-4 text-center">No food photo selected</span>
              )}
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                disabled={isOptimizing}
                onClick={() => cameraInputRef.current?.click()}
                className="rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
              >
                Take picture
              </button>
              <button
                type="button"
                disabled={isOptimizing}
                onClick={() => libraryInputRef.current?.click()}
                className="rounded-xl border border-[var(--color-accent)] py-2.5 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5"
              >
                Choose photo
              </button>
            </div>
            <p className="rounded-lg bg-[var(--color-card-subtle)] px-3 py-2 text-[11px] font-medium text-[var(--color-muted)]">
              {ALLOWED_FORMATS_LABEL}
            </p>
            <input
              ref={libraryInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              onChange={(event) =>
                handleFileChange(event.target.files?.[0] ?? null)
              }
              className="hidden"
            />
            <input
              ref={cameraInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              capture="environment"
              onChange={(event) =>
                handleFileChange(event.target.files?.[0] ?? null)
              }
              className="hidden"
            />

            {question ? (
              <div className="rounded-xl border border-[var(--color-border)] bg-[var(--color-card-subtle)] p-3">
                <p className="text-sm font-semibold text-[var(--color-ink)]">
                  {question}
                </p>
                <textarea
                  value={clarification}
                  onChange={(event) => setClarification(event.target.value)}
                  rows={3}
                  className="mt-3 w-full resize-none rounded-xl border border-[var(--color-border)] bg-[var(--color-app-bg)] px-3 py-2.5 text-sm text-[var(--color-ink)] outline-none transition focus:border-[var(--color-accent)]"
                  placeholder="Add the missing detail"
                />
              </div>
            ) : null}

            {estimate ? (
              <div className="space-y-3">
                <div>
                  <h4 className="text-sm font-bold text-[var(--color-ink)]">
                    {estimate.label}
                  </h4>
                </div>

                <div className="grid grid-cols-2 gap-2">
                  {[
                    {
                      label: "Calories",
                      value: `${estimate.caloriesKcal} kcal`,
                      color: "var(--color-bar-calories)",
                    },
                    {
                      label: "Protein",
                      value: `${estimate.proteinG}g`,
                      color: "var(--color-bar-protein)",
                    },
                    {
                      label: "Carbs",
                      value: `${estimate.carbsG}g`,
                      color: "var(--color-bar-carbs)",
                    },
                    {
                      label: "Fat",
                      value: `${estimate.fatG}g`,
                      color: "var(--color-bar-fat)",
                    },
                  ].map((item) => (
                    <div
                      key={item.label}
                      className="rounded-xl border border-[var(--color-border)] px-3 py-2"
                    >
                      <span className="text-[10px] font-semibold uppercase tracking-[0.14em] text-[var(--color-muted-strong)]">
                        {item.label}
                      </span>
                      <p
                        className="mt-0.5 text-lg font-bold tabular-nums"
                        style={{ color: item.color }}
                      >
                        {item.value}
                      </p>
                    </div>
                  ))}
                </div>

                {estimate.notes.length > 0 ? (
                  <p className="text-[10px] text-[var(--color-muted)]">
                    {estimate.notes.join(" ")}
                  </p>
                ) : null}
              </div>
            ) : null}

            {error ? (
              <p className="rounded-lg bg-[color-mix(in_srgb,var(--color-danger)_12%,transparent)] px-3 py-2 text-xs text-[var(--color-danger)]">
                {error}
              </p>
            ) : null}

            <div className="space-y-2">
              {!estimate ? (
                <button
                  type="button"
                  onClick={analyzePhoto}
                  disabled={isAnalyzing || isOptimizing || !imageFile}
                  className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isOptimizing
                    ? "Optimizing..."
                    : isAnalyzing
                    ? "Analyzing..."
                    : question
                      ? "Answer and estimate"
                      : "Estimate macros"}
                </button>
              ) : (
                <>
                  <button
                    type="button"
                    onClick={handleAddEstimate}
                    className="w-full rounded-xl bg-[var(--color-accent)] py-2.5 text-sm font-semibold text-white transition hover:-translate-y-0.5"
                  >
                    Add to log
                  </button>
                  <button
                    type="button"
                    disabled={savedPreset}
                    onClick={() => {
                      onSaveAsPreset(estimateToMacros(estimate));
                      setSavedPreset(true);
                    }}
                    className="w-full rounded-xl border border-[var(--color-accent)] py-2.5 text-sm font-semibold text-[var(--color-accent)] transition hover:-translate-y-0.5 disabled:opacity-50"
                  >
                    {savedPreset ? "Saved!" : "Save template"}
                  </button>
                </>
              )}
            </div>
          </div>
        </ModalSurface>
      </div>
    </OverlayPortal>
  );
}

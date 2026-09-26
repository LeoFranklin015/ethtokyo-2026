"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Button } from "@/components/ui/Button";
import { MEMBER_ID_PATTERN, parseMemberId } from "@/lib/ens/memberId";

type DetectedBarcode = { rawValue: string };

type BarcodeDetectorLike = { detect(source: HTMLVideoElement): Promise<DetectedBarcode[]> };

type BarcodeDetectorCtor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

declare global {
  interface Window {
    BarcodeDetector?: BarcodeDetectorCtor;
  }
}

type Trouble = { title: string; body: string };

/**
 * Reading a member's badge.
 *
 * The badge encodes a URL ending in the member's five-character id, which becomes their ENS
 * label. Every way this can fail — a blocked camera, no camera, a page served over plain HTTP,
 * a browser without barcode decoding — is reported as itself and leaves the id typeable by
 * hand, because an operator standing in front of a queue cannot debug the browser.
 *
 * Shared by the two surfaces that read a badge — an operator onboarding someone at the desk and
 * a guest signing themselves onto the network — which differ only in what the confirmation step
 * has to warn about, so that copy is passed in rather than duplicated alongside a second camera.
 */
export function QrScanner({
  onScanned,
  onClose,
  confirmTitle = "Is this the right member?",
  confirmNote = "This becomes their name on-chain. Minting it is not easily undone, so check it against the badge in front of you.",
  confirmLabel = "Use this id",
}: {
  onScanned: (id: string) => void;
  onClose: () => void;
  confirmTitle?: string;
  confirmNote?: ReactNode;
  confirmLabel?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const dialogRef = useRef<HTMLDivElement | null>(null);

  const [trouble, setTrouble] = useState<Trouble | null>(null);
  const [scanned, setScanned] = useState<string | null>(null);
  // A QR that decodes to something that is not an id is a different state from no QR at all:
  // the operator is pointing at the wrong code and needs to be told, not left waiting.
  const [rejected, setRejected] = useState<string | null>(null);
  const [manual, setManual] = useState("");
  const [manualOpen, setManualOpen] = useState(false);
  // Bumped to open a fresh camera session after a scan the operator rejected.
  const [attempt, setAttempt] = useState(0);

  const stopCamera = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
  }, []);

  const close = useCallback(() => {
    stopCamera();
    onClose();
  }, [stopCamera, onClose]);

  useEffect(() => {
    const restoreTo = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => restoreTo?.focus?.();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [close]);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setInterval> | undefined;

    async function start() {
      // getUserMedia is only exposed on a secure origin, and in development the console is
      // routinely opened at a LAN address over http — which is the failure people will hit.
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
        setTrouble({
          title: "This page is not served securely",
          body: "Cameras are only available over HTTPS or on localhost. Open this page at https:// or at localhost, or enter the id below.",
        });
        setManualOpen(true);
        return;
      }
      const Detector = window.BarcodeDetector;
      if (!Detector) {
        setTrouble({
          title: "Scanning is unavailable in this browser",
          body: "It has no barcode decoding. Chrome on Android and Safari can scan; otherwise enter the id below.",
        });
        setManualOpen(true);
        return;
      }

      let stream: MediaStream;
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "environment" },
        });
      } catch (e) {
        const name = e instanceof DOMException ? e.name : "";
        setTrouble(
          name === "NotAllowedError"
            ? {
                title: "The browser blocked the camera",
                body: "Allow camera access for this site — the camera icon in the address bar, or site settings — then open the scanner again.",
              }
            : name === "NotFoundError"
              ? {
                  title: "No camera on this device",
                  body: "Nothing here can scan a badge. Enter the id below instead.",
                }
              : {
                  title: "The camera would not start",
                  body: e instanceof Error ? e.message : "Unknown error.",
                },
        );
        setManualOpen(true);
        return;
      }

      if (cancelled) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }
      streamRef.current = stream;
      const video = videoRef.current;
      if (video) {
        video.srcObject = stream;
        await video.play().catch(() => {});
      }

      const detector = new Detector({ formats: ["qr_code"] });
      let busy = false;
      timer = setInterval(async () => {
        if (busy || !videoRef.current || videoRef.current.readyState < 2) return;
        busy = true;
        try {
          const found = await detector.detect(videoRef.current);
          const raw = found[0]?.rawValue;
          if (raw) {
            const id = parseMemberId(raw);
            if (id) {
              stopCamera();
              setRejected(null);
              setScanned(id);
            } else {
              setRejected(raw);
            }
          }
        } catch {
          // A single failed frame is not worth an error state; the next one is 200ms away.
        } finally {
          busy = false;
        }
      }, 200);
    }

    void start();
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      stopCamera();
    };
  }, [stopCamera, attempt]);

  const manualId = manual.trim().toLowerCase();
  const manualValid = MEMBER_ID_PATTERN.test(manualId);

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center">
      <button
        type="button"
        aria-label="Close"
        onClick={close}
        className="absolute inset-0 cursor-default bg-ink/20"
      />
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label="Scan a member badge"
        className="relative w-full max-w-[420px] rounded-sharp border border-rule bg-paper p-5 outline-none"
      >
        <p className="label">Scan a badge</p>

        {scanned ? (
          <>
            <h2 className="mt-2 text-sm text-ink">{confirmTitle}</h2>
            <p className="mt-4 text-center font-mono text-2xl tracking-[0.2em] text-ink">
              {scanned}
            </p>
            {confirmNote ? (
              <p className="mx-auto mt-3 max-w-[40ch] text-center text-xs leading-relaxed text-ink-muted">
                {confirmNote}
              </p>
            ) : null}
            <div className="mt-5 flex flex-wrap gap-2">
              <Button variant="solid" onClick={() => onScanned(scanned)}>
                {confirmLabel}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  setScanned(null);
                  setAttempt((n) => n + 1);
                }}
              >
                Scan another
              </Button>
            </div>
          </>
        ) : trouble ? (
          <>
            <h2 className="mt-2 text-sm text-ink">{trouble.title}</h2>
            <p className="mt-2 max-w-[46ch] text-xs leading-relaxed text-ink-muted">
              {trouble.body}
            </p>
          </>
        ) : (
          <>
            <h2 className="mt-2 text-sm text-ink">Point the camera at the badge</h2>
            <div className="mt-4">
              <span id="qr-video-label" className="label">
                Camera
              </span>
              <video
                ref={videoRef}
                aria-labelledby="qr-video-label"
                playsInline
                muted
                className="mt-2 aspect-square w-full rounded-sharp border border-rule bg-ink/5 object-cover"
              />
            </div>
            <p className="mt-2 min-h-[1rem] font-mono text-[0.6875rem]" role="status">
              {rejected ? (
                <span style={{ color: "var(--alert)" }}>
                  that code is not a member badge — still scanning
                </span>
              ) : (
                <span className="text-ink-muted">looking for a code…</span>
              )}
            </p>
          </>
        )}

        {!scanned ? (
          <div className="mt-5 border-t border-rule pt-4">
            {manualOpen ? (
              <label className="block">
                <span className="label">Member id</span>
                <span className="mt-2 flex items-center gap-2">
                  <input
                    value={manual}
                    onChange={(e) =>
                      setManual(e.target.value.replace(/[^a-zA-Z0-9]/g, "").slice(0, 5))
                    }
                    placeholder="sdiuf"
                    autoComplete="off"
                    spellCheck={false}
                    className="h-11 min-w-0 flex-1 rounded-sharp border border-rule bg-paper px-3 font-mono text-sm tracking-[0.2em] text-ink placeholder:text-ink-faint"
                  />
                  <Button
                    variant="solid"
                    className="shrink-0"
                    onClick={() => onScanned(manualId)}
                    disabled={!manualValid}
                  >
                    Use
                  </Button>
                </span>
                <span className="mt-1 block text-xs text-ink-muted">
                  The five characters at the end of the badge&rsquo;s link.
                </span>
              </label>
            ) : (
              <Button variant="ghost" onClick={() => setManualOpen(true)}>
                Enter the id instead
              </Button>
            )}
          </div>
        ) : null}

        <div className="mt-5">
          <Button variant="ghost" onClick={close}>
            Cancel
          </Button>
        </div>
      </div>
    </div>
  );
}

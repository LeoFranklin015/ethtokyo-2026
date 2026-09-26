"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useDisconnect, useSwitchChain } from "wagmi";
import { useAppKit } from "@reown/appkit/react";
import { sepolia } from "wagmi/chains";
import { Button } from "@/components/ui/Button";

/**
 * The wallet, wherever you are in the product.
 *
 * Connecting used to live only inside the create wizard's first step, so once you were past it
 * there was no way to see which account was signing, copy it, switch it, or disconnect — on a
 * product where every write is signed by the visitor's own wallet and the contracts decide what
 * that wallet may do. Not showing it meant a refused transaction gave you no way to check the
 * most likely cause.
 *
 * Connecting is Reown AppKit's modal. The hand-rolled version offered `connectors[0]` and
 * nothing else, which is always the injected one — so the WalletConnect connector was
 * configured, registered, and unreachable, and a phone without an extension had no way in.
 */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, chainId, isConnected } = useAccount();
  const { open: openModal } = useAppKit();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const firstItemRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  // Escape is the one key people reach for, and focus goes back to the control that opened the
  // menu rather than to the top of the document.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      setOpen(false);
      triggerRef.current?.focus();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Opening with the keyboard has to land somewhere usable; without this, Tab from the trigger
  // walks into the click-away backdrop before reaching any of the actions.
  useEffect(() => {
    if (open) firstItemRef.current?.focus();
  }, [open]);

  const wrongChain = isConnected && chainId !== sepolia.id;

  async function copy() {
    if (!address) return;
    try {
      await navigator.clipboard.writeText(address);
      setCopied(true);
    } catch {
      // A browser that refuses the clipboard is not worth an error state; the address is
      // selectable in the menu either way.
    }
  }

  function close() {
    setOpen(false);
    triggerRef.current?.focus();
  }

  if (!isConnected || !address) {
    return (
      <Button variant={compact ? "outline" : "solid"} onClick={() => void openModal()}>
        Connect wallet
      </Button>
    );
  }

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        // A pill, like every other action in the product. It was a square-cornered chip, which
        // read as a status readout rather than something you press — and it is the control that
        // opens the wallet menu, so it has to look pressable.
        //
        // Not uppercased, unlike the button labels around it: this is an address, and EIP-55
        // encodes a checksum in its capitalisation. Rendering `0XE082…` is both wrong-looking
        // and destroys the one property that makes a mistyped address detectable.
        className="inline-flex h-11 items-center gap-2 rounded-full border border-ink/35 bg-paper px-4 font-mono text-xs tracking-[0.08em] text-ink transition-colors hover:border-ink hover:bg-ink/5"
      >
        <StatusDot wrongChain={wrongChain} />
        {short(address)}
      </button>

      {open ? (
        <>
          {/* Click-away. A backdrop is the only thing that works for a menu inside a sidebar. */}
          <button
            type="button"
            tabIndex={-1}
            aria-hidden
            onClick={close}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            aria-label="Wallet"
            // Wider than the old 248px so the address fits two clean lines, and capped against
            // the viewport so it cannot hang off the edge of a phone.
            className="absolute right-0 z-50 mt-2 w-[19rem] max-w-[calc(100vw-2rem)] rounded-sharp border border-rule bg-paper-raise"
          >
            <div className="border-b border-rule px-4 py-3">
              <p className="label">Connected</p>
              <p className="mt-2 font-mono text-xs leading-5 text-ink">
                {/* Split at a fixed point rather than letting `break-all` choose. An address
                    broken mid-run reads as two unrelated strings and is impossible to check by
                    eye against a wallet. */}
                <span className="block">{address.slice(0, 21)}</span>
                <span className="block">{address.slice(21)}</span>
              </p>
              <p className="mt-2 flex items-center gap-2 font-mono text-[0.6875rem] text-ink-muted">
                <StatusDot wrongChain={wrongChain} />
                {wrongChain ? "Wrong network" : "Sepolia"}
              </p>
              {wrongChain ? (
                <p className="mt-1.5 text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
                  Everything here is on Sepolia. Writes will be refused until you switch.
                </p>
              ) : null}
            </div>

            <div className="py-1">
              {wrongChain ? (
                <MenuItem
                  ref={firstItemRef}
                  onClick={() => switchChain({ chainId: sepolia.id })}
                  disabled={switching}
                  emphasis
                >
                  {switching ? "Switching…" : "Switch to Sepolia"}
                </MenuItem>
              ) : null}

              <MenuItem ref={wrongChain ? undefined : firstItemRef} onClick={copy}>
                {copied ? "Copied" : "Copy address"}
              </MenuItem>

              <MenuItem
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </MenuItem>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * One row of the wallet menu.
 *
 * Full-width rows rather than a pill and a bare link side by side: they are the same kind of
 * thing and were styled as though they were not, which made "Disconnect" read as a footnote
 * instead of an action. 44px tall, so it is a real tap target on a phone.
 */
function MenuItem({
  ref,
  children,
  onClick,
  disabled,
  emphasis,
}: {
  ref?: React.Ref<HTMLButtonElement>;
  children: React.ReactNode;
  onClick: () => void;
  disabled?: boolean;
  emphasis?: boolean;
}) {
  return (
    <button
      ref={ref}
      type="button"
      role="menuitem"
      onClick={onClick}
      disabled={disabled}
      className={`flex h-11 w-full items-center px-4 text-left font-mono text-xs uppercase tracking-[0.12em] transition-colors hover:bg-ink/5 focus-visible:bg-ink/5 disabled:pointer-events-none disabled:opacity-40 ${
        emphasis ? "text-ink" : "text-ink-muted hover:text-ink"
      }`}
    >
      {children}
    </button>
  );
}

/** Green when connected to Sepolia, red when not — never colour alone, the label says which. */
function StatusDot({ wrongChain }: { wrongChain: boolean }) {
  return (
    <span
      aria-hidden
      className="size-1.5 shrink-0 rounded-full"
      style={{ background: wrongChain ? "var(--alert)" : "var(--signal)" }}
    />
  );
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

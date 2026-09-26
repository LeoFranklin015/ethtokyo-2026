"use client";

import { useEffect, useState } from "react";
import { useAccount, useConnect, useDisconnect, useSwitchChain } from "wagmi";
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
 */
export function WalletButton({ compact = false }: { compact?: boolean }) {
  const { address, chainId, isConnected } = useAccount();
  const { connect, connectors, isPending } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching } = useSwitchChain();

  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(t);
  }, [copied]);

  // Close the menu on Escape, which is the one key people reach for.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
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

  if (!isConnected || !address) {
    const injected = connectors[0];
    return (
      <Button
        variant={compact ? "outline" : "solid"}
        onClick={() => injected && connect({ connector: injected })}
        disabled={isPending || !injected}
      >
        {isPending ? "Connecting…" : "Connect wallet"}
      </Button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex items-center gap-2 rounded-sharp border border-rule bg-paper px-3 py-1.5 font-mono text-xs text-ink hover:bg-ink/5"
      >
        <span
          aria-hidden
          className="size-1.5 rounded-full"
          style={{ background: wrongChain ? "var(--alert)" : "var(--signal)" }}
        />
        {short(address)}
      </button>

      {open ? (
        <>
          {/* Click-away. A backdrop is the only thing that works for a menu in a sidebar. */}
          <button
            type="button"
            aria-label="Close wallet menu"
            onClick={() => setOpen(false)}
            className="fixed inset-0 z-40 cursor-default"
          />
          <div
            role="menu"
            className="absolute right-0 z-50 mt-2 w-[248px] rounded-sharp border border-rule bg-paper p-3 shadow-lg"
          >
            <p className="label">Connected</p>
            <p className="mt-1 break-all font-mono text-[0.6875rem] text-ink-80">{address}</p>

            {wrongChain ? (
              <div className="mt-3">
                <p className="text-xs leading-relaxed" style={{ color: "var(--alert)" }}>
                  Wrong network. Everything here is on Sepolia.
                </p>
                <Button
                  variant="solid"
                  className="mt-2"
                  onClick={() => switchChain({ chainId: sepolia.id })}
                  disabled={switching}
                >
                  {switching ? "Switching…" : "Switch to Sepolia"}
                </Button>
              </div>
            ) : (
              <p className="mt-1 font-mono text-[0.6875rem] text-ink-muted">Sepolia</p>
            )}

            <div className="mt-3 flex flex-wrap gap-2">
              <Button variant="outline" onClick={copy}>
                {copied ? "Copied" : "Copy address"}
              </Button>
              <Button
                variant="ghost"
                onClick={() => {
                  disconnect();
                  setOpen(false);
                }}
              >
                Disconnect
              </Button>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}

export function short(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}
